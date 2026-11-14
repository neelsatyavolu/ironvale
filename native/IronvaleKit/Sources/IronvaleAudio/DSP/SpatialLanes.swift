// HRTF lanes (PLAN.md 3.8, M8b). The web gives its 8 nearest, newest positional voices an HRTF
// PannerNode (pool.ts, voices.ts assignHrtf). Natively, MixCore writes each such voice's mono,
// filtered, gain-applied signal into one of 8 lanes; Apple's spatial mixer renders the lanes with
// its HRTFHQ algorithm, and the binaural result is added back into the voice's bus before the
// bus gains, the world low-pass, the limiter and the soft clip, exactly where the web's panner
// output goes.
//
// The plan names AVAudioEnvironmentNode. That node is a wrapper around this same audio unit
// (kAudioUnitSubType_SpatialMixer); hosting the unit directly lets MixCore pull it synchronously on
// the render thread, so lanes stay sample-aligned with the rest of the mix and never bypass the
// master chain. Like the environment node, it spatialises mono input: stereo voices (four gun
// tails) enter a lane as (L + R) / 2. It will not sound identical to Chrome's HRTF; accepted (3.8).
//
// One spatial mixer per positional bus (effects, ambience loops), 8 inputs each; a lane feeds the
// mixer of its voice's bus and is silent on the other. A mixer with no lane for half a second is
// not rendered at all. Distance attenuation and the unit's reverb are off: the engine's own
// curves set the level, as the web's panners run with rolloffFactor 0.

import AudioToolbox
import Foundation

final class SpatialLanes {
    static let count = 8
    /// Mixers: 0 feeds the effects bus, 1 the ambience loops.
    static let mixers = 2
    /// How long a mixer keeps rendering after its last lane left (HRTF filter tails).
    static let idleSeconds = 0.5

    let sampleRate: Double
    let available: Bool
    /// Mono lane signals, `count` x maxFrames, written by MixCore each block.
    let buffers: UnsafeMutablePointer<Float>
    /// Which mixer each lane feeds this block: -1 none.
    let laneMixer: UnsafeMutablePointer<Int32>
    private let taps: UnsafeMutablePointer<Tap>
    private var units: [AudioUnit] = []
    private let output: UnsafeMutableAudioBufferListPointer
    private let outputData: UnsafeMutablePointer<Float>
    private var sampleTime = 0.0
    private var idleFrames: [Int]
    private let idleLimit: Int
    /// Last azimuth / elevation sent per mixer input, to skip unchanged parameter writes.
    private var sentAzimuth: [Float]
    private var sentElevation: [Float]

    struct Tap {
        var buffer: UnsafeMutablePointer<Float>
        var laneMixer: UnsafeMutablePointer<Int32>
        var lane: Int32
        var mixer: Int32
    }

    init(sampleRate: Double, maxFrames: Int) {
        self.sampleRate = sampleRate
        buffers = .allocate(capacity: SpatialLanes.count * maxFrames)
        buffers.initialize(repeating: 0, count: SpatialLanes.count * maxFrames)
        laneMixer = .allocate(capacity: SpatialLanes.count)
        laneMixer.initialize(repeating: -1, count: SpatialLanes.count)
        taps = .allocate(capacity: SpatialLanes.count * SpatialLanes.mixers)
        output = AudioBufferList.allocate(maximumBuffers: 2)
        outputData = .allocate(capacity: 2 * maxFrames)
        outputData.initialize(repeating: 0, count: 2 * maxFrames)
        idleLimit = Int(SpatialLanes.idleSeconds * sampleRate)
        idleFrames = [Int](repeating: Int.max / 2, count: SpatialLanes.mixers)
        sentAzimuth = [Float](repeating: .nan, count: SpatialLanes.count * SpatialLanes.mixers)
        sentElevation = [Float](repeating: .nan, count: SpatialLanes.count * SpatialLanes.mixers)
        for m in 0..<SpatialLanes.mixers {
            for lane in 0..<SpatialLanes.count {
                (taps + m * SpatialLanes.count + lane).initialize(to: Tap(buffer: buffers + lane * maxFrames, laneMixer: laneMixer, lane: Int32(lane), mixer: Int32(m)))
            }
        }
        var ok = true
        for m in 0..<SpatialLanes.mixers {
            guard let unit = SpatialLanes.makeMixer(sampleRate: sampleRate, maxFrames: maxFrames, taps: taps + m * SpatialLanes.count) else {
                ok = false
                break
            }
            units.append(unit)
        }
        available = ok
    }

    deinit {
        for unit in units {
            AudioUnitUninitialize(unit)
            AudioComponentInstanceDispose(unit)
        }
        buffers.deallocate()
        laneMixer.deallocate()
        taps.deallocate()
        free(output.unsafeMutablePointer)
        outputData.deallocate()
    }

    private static func check(_ status: OSStatus, _ what: String) -> Bool {
        if status != noErr { NSLog("IronvaleAudio: spatial mixer \(what) failed (\(status)); HRTF lanes fall back to equal-power") }
        return status == noErr
    }

    private static func makeMixer(sampleRate: Double, maxFrames: Int, taps: UnsafeMutablePointer<Tap>) -> AudioUnit? {
        var description = AudioComponentDescription(componentType: kAudioUnitType_Mixer, componentSubType: kAudioUnitSubType_SpatialMixer,
                                                    componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
        guard let component = AudioComponentFindNext(nil, &description) else { return nil }
        var instance: AudioUnit?
        guard check(AudioComponentInstanceNew(component, &instance), "creation"), let unit = instance else { return nil }
        func set<T>(_ property: AudioUnitPropertyID, _ scope: AudioUnitScope, _ element: UInt32, _ value: T) -> Bool {
            let status = withUnsafePointer(to: value) { AudioUnitSetProperty(unit, property, scope, element, $0, UInt32(MemoryLayout<T>.size)) }
            return check(status, "property \(property)")
        }
        let mono = AudioStreamBasicDescription(mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
                                               mFormatFlags: kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved,
                                               mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        var stereo = mono
        stereo.mChannelsPerFrame = 2
        var ok = set(kAudioUnitProperty_ElementCount, kAudioUnitScope_Input, 0, UInt32(SpatialLanes.count))
        ok = ok && set(kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, UInt32(maxFrames))
        ok = ok && set(kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 0, stereo)
        ok = ok && set(kAudioUnitProperty_SpatialMixerOutputType, kAudioUnitScope_Global, 0, AUSpatialMixerOutputType.spatialMixerOutputType_Headphones.rawValue)
        ok = ok && set(kAudioUnitProperty_UsesInternalReverb, kAudioUnitScope_Global, 0, UInt32(0))
        for input in 0..<UInt32(SpatialLanes.count) where ok {
            ok = ok && set(kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, input, mono)
            ok = ok && set(kAudioUnitProperty_SpatializationAlgorithm, kAudioUnitScope_Input, input, AUSpatializationAlgorithm.spatializationAlgorithm_HRTFHQ.rawValue)
            ok = ok && set(kAudioUnitProperty_3DMixerDistanceParams, kAudioUnitScope_Input, input,
                           MixerDistanceParams(mReferenceDistance: 1, mMaxDistance: 1_000_000, mMaxAttenuation: 0))
            ok = ok && set(kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, input,
                           AURenderCallbackStruct(inputProc: spatialLaneInput, inputProcRefCon: UnsafeMutableRawPointer(taps + Int(input))))
            ok = ok && check(AudioUnitSetParameter(unit, k3DMixerParam_Distance, kAudioUnitScope_Input, input, 1, 0), "distance")
        }
        if ok { ok = check(AudioUnitInitialize(unit), "initialize") }
        if !ok {
            AudioComponentInstanceDispose(unit)
            return nil
        }
        return unit
    }

    // ---------------------------------------------------------------- render thread

    /// Clear the lane buffers for a block of `frames`.
    func clear(frames: Int, maxFrames: Int) {
        for lane in 0..<SpatialLanes.count { (buffers + lane * maxFrames).update(repeating: 0, count: frames) }
    }

    /// Point lane `lane`'s source at `azimuth` / `elevation` degrees (0 ahead, positive right / up).
    func aim(lane: Int, azimuth: Float, elevation: Float) {
        let mixer = Int(laneMixer[lane])
        guard available, mixer >= 0 else { return }
        let key = mixer * SpatialLanes.count + lane
        let unit = units[mixer]
        if sentAzimuth[key] != azimuth {
            AudioUnitSetParameter(unit, k3DMixerParam_Azimuth, kAudioUnitScope_Input, UInt32(lane), azimuth, 0)
            sentAzimuth[key] = azimuth
        }
        if sentElevation[key] != elevation {
            AudioUnitSetParameter(unit, k3DMixerParam_Elevation, kAudioUnitScope_Input, UInt32(lane), elevation, 0)
            sentElevation[key] = elevation
        }
    }

    /// Render both mixers for `frames` and add each one's binaural output into its bus.
    func render(frames: Int, effects: (UnsafeMutablePointer<Float>, UnsafeMutablePointer<Float>),
                ambience: (UnsafeMutablePointer<Float>, UnsafeMutablePointer<Float>)) {
        defer { sampleTime += Double(frames) }
        guard available else { return }
        for m in 0..<SpatialLanes.mixers {
            var used = false
            for lane in 0..<SpatialLanes.count where laneMixer[lane] == Int32(m) { used = true }
            idleFrames[m] = used ? 0 : idleFrames[m] + frames
            if idleFrames[m] > idleLimit { continue }
            output[0] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(frames * 4), mData: outputData)
            output[1] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(frames * 4), mData: outputData + frames)
            var flags = AudioUnitRenderActionFlags()
            var stamp = AudioTimeStamp()
            stamp.mSampleTime = sampleTime
            stamp.mFlags = .sampleTimeValid
            let status = AudioUnitRender(units[m], &flags, &stamp, 0, UInt32(frames), output.unsafeMutablePointer)
            if status != noErr { continue }
            let target = m == 0 ? effects : ambience
            vDSPAdd(outputData, target.0, frames)
            vDSPAdd(outputData + frames, target.1, frames)
        }
    }

    @inline(__always) private func vDSPAdd(_ source: UnsafeMutablePointer<Float>, _ target: UnsafeMutablePointer<Float>, _ frames: Int) {
        for i in 0..<frames { target[i] += source[i] }
    }
}

/// Input callback of one spatial mixer input: the lane's samples when the lane feeds this mixer, else silence.
private func spatialLaneInput(refCon: UnsafeMutableRawPointer, flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
                              stamp: UnsafePointer<AudioTimeStamp>, bus: UInt32, frames: UInt32,
                              data: UnsafeMutablePointer<AudioBufferList>?) -> OSStatus {
    let tap = refCon.assumingMemoryBound(to: SpatialLanes.Tap.self).pointee
    guard let data else { return noErr }
    let list = UnsafeMutableAudioBufferListPointer(data)
    guard let out = list[0].mData?.assumingMemoryBound(to: Float.self) else { return noErr }
    let n = Int(frames)
    if tap.laneMixer[Int(tap.lane)] == tap.mixer {
        out.update(from: tap.buffer, count: n)
    } else {
        out.update(repeating: 0, count: n)
        flags.pointee.insert(.unitRenderAction_OutputIsSilence)
    }
    return noErr
}

extension Panning {
    /// Unfolded direction of a source in the listener's frame, in degrees: azimuth in (-180, 180]
    /// (0 ahead, positive right) and elevation in [-90, 90] (positive up).
    static func direction(listener p: (Double, Double, Double), forward f: (Double, Double, Double),
                          up u: (Double, Double, Double), source s: (Double, Double, Double)) -> (azimuth: Double, elevation: Double) {
        let rel = (s.0 - p.0, s.1 - p.1, s.2 - p.2)
        let fl = (f.0 * f.0 + f.1 * f.1 + f.2 * f.2).squareRoot()
        if fl == 0 { return (0, 0) }
        let fwd = (f.0 / fl, f.1 / fl, f.2 / fl)
        var r = (fwd.1 * u.2 - fwd.2 * u.1, fwd.2 * u.0 - fwd.0 * u.2, fwd.0 * u.1 - fwd.1 * u.0)
        let rl = (r.0 * r.0 + r.1 * r.1 + r.2 * r.2).squareRoot()
        if rl == 0 { return (0, 0) }
        r = (r.0 / rl, r.1 / rl, r.2 / rl)
        let up = (r.1 * fwd.2 - r.2 * fwd.1, r.2 * fwd.0 - r.0 * fwd.2, r.0 * fwd.1 - r.1 * fwd.0)
        let x = rel.0 * r.0 + rel.1 * r.1 + rel.2 * r.2
        let y = rel.0 * up.0 + rel.1 * up.1 + rel.2 * up.2
        let z = rel.0 * fwd.0 + rel.1 * fwd.1 + rel.2 * fwd.2
        if x == 0 && y == 0 && z == 0 { return (0, 0) }
        let degrees = 180 / Double.pi
        return (atan2(x, z) * degrees, atan2(y, (x * x + z * z).squareRoot()) * degrees)
    }
}
