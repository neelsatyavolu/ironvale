// Hosts MixCore in one AVAudioSourceNode (PLAN.md 3.8) and owns the output device settings:
// the I/O buffer size (kAudioDevicePropertyBufferFrameSize) and an overload counter fed by
// kAudioDeviceProcessorOverload.

import AVFoundation
import CoreAudio
import Foundation
import Synchronization

/// Optional hooks around each render call (tests use them to watch the render thread).
public protocol RenderProbe: AnyObject, Sendable {
    func enter()
    func leave()
}

public final class AudioOutput {
    public let engine = AVAudioEngine()
    public let core: MixCore
    private let node: AVAudioSourceNode
    private let overloadCount = OverloadCounter()
    private var device: AudioObjectID = 0
    private var listening = false

    /// The output device's current sample rate; build MixCore at this rate.
    public static func hardwareSampleRate() -> Double {
        let probe = AVAudioEngine()
        return probe.outputNode.outputFormat(forBus: 0).sampleRate
    }

    /// The built-in speakers (or other built-in output), whose I/O buffer can be set freely;
    /// Bluetooth outputs keep their own buffer size.
    public static func builtInOutputDevice() -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return nil }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return nil }
        for id in ids {
            var transport: UInt32 = 0
            var tsize = UInt32(MemoryLayout<UInt32>.size)
            var t = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
            var ssize: UInt32 = 0
            guard AudioObjectGetPropertyData(id, &t, 0, nil, &tsize, &transport) == noErr, transport == kAudioDeviceTransportTypeBuiltIn,
                  AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &ssize) == noErr, ssize > 0 else { continue }
            return id
        }
        return nil
    }

    /// Nominal sample rate of an output device.
    public static func sampleRate(of device: AudioObjectID) -> Double? {
        var rate = 0.0
        var size = UInt32(MemoryLayout<Double>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyNominalSampleRate, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        return AudioObjectGetPropertyData(device, &address, 0, nil, &size, &rate) == noErr ? rate : nil
    }

    public init(core: MixCore, probe: RenderProbe? = nil) {
        self.core = core
        let format = AVAudioFormat(standardFormatWithSampleRate: core.sampleRate, channels: 2)!
        node = AVAudioSourceNode(format: format) { _, _, frameCount, bufferList -> OSStatus in
            let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
            guard buffers.count >= 2, let left = buffers[0].mData, let right = buffers[1].mData else { return noErr }
            probe?.enter()
            core.render(frames: Int(frameCount), left: left.assumingMemoryBound(to: Float.self), right: right.assumingMemoryBound(to: Float.self))
            probe?.leave()
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
    }

    public var overloads: Int { overloadCount.value }

    /// The I/O buffer of the output device in frames, or nil when it cannot be read.
    public var bufferFrames: Int? {
        guard device != 0 else { return nil }
        var frames: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyBufferFrameSize, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        return AudioObjectGetPropertyData(device, &address, 0, nil, &size, &frames) == noErr ? Int(frames) : nil
    }

    /// Start rendering with the device I/O buffer set to `bufferFrames` (nil keeps the device's own),
    /// on `device` or the default output.
    public func start(bufferFrames: UInt32? = 256, device chosen: AudioObjectID? = nil) throws {
        if var chosen, let unit = engine.outputNode.audioUnit {
            let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &chosen, UInt32(MemoryLayout<AudioObjectID>.size))
            if status != noErr { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "could not select output device \(chosen)"]) }
        }
        device = try currentDevice()
        if !listening {
            var overload = AudioObjectPropertyAddress(mSelector: kAudioDeviceProcessorOverload, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            let counter = overloadCount
            AudioObjectAddPropertyListenerBlock(device, &overload, DispatchQueue.global(qos: .utility)) { _, _ in counter.increment() }
            listening = true
        }
        engine.prepare()
        try engine.start()
        // AVAudioEngine picks its own I/O size when it starts; set ours afterwards.
        if let bufferFrames { try setBufferFrames(bufferFrames) }
    }

    public func setBufferFrames(_ bufferFrames: UInt32) throws {
        var frames = bufferFrames
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyBufferFrameSize, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        let status = AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &frames)
        if status != noErr { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "could not set the I/O buffer to \(bufferFrames) frames"]) }
    }

    public func stop() {
        engine.stop()
    }

    private func currentDevice() throws -> AudioObjectID {
        guard let unit = engine.outputNode.audioUnit else { throw NSError(domain: "IronvaleAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "no output audio unit"]) }
        var id: AudioObjectID = 0
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, &size)
        if status != noErr || id == 0 { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "no output device"]) }
        return id
    }
}

private final class OverloadCounter: Sendable {
    private let count = Atomic<Int>(0)
    func increment() { count.add(1, ordering: .relaxed) }
    var value: Int { count.load(ordering: .relaxed) }
}
