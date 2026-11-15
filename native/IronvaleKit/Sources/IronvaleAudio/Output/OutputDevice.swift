// The system output device (System Settings > Sound > Output) and a watcher that reports when it
// changes or its sample rate does, so the app can move playback and rebuild MixCore at the new rate.
// The web's AudioContext follows the default output on its own; AVAudioEngine does not reliably.

import CoreAudio
import Foundation

public enum OutputDevice {
    /// The system default output device, or nil when there is none.
    public static func systemDefault() -> AudioObjectID? {
        var id: AudioObjectID = 0
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
        return status == noErr && id != kAudioObjectUnknown ? id : nil
    }

    /// The device's name as Sound settings shows it.
    public static func name(of device: AudioObjectID) -> String {
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &name) == noErr, let name else { return "device \(device)" }
        return name.takeRetainedValue() as String
    }

    /// Built-in speakers or headphone jack: the only outputs whose I/O buffer the game sets (PLAN.md 3.8).
    public static func isBuiltIn(_ device: AudioObjectID) -> Bool {
        var transport: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        return AudioObjectGetPropertyData(device, &address, 0, nil, &size, &transport) == noErr && transport == kAudioDeviceTransportTypeBuiltIn
    }
}

/// Calls `onChange` on the main thread when the default output device changes, or the nominal
/// sample rate of the watched device does. Changes arrive in bursts; the caller coalesces them.
@MainActor
public final class OutputDeviceWatcher {
    private static let defaultAddress = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                                                   mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    private static let rateAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyNominalSampleRate,
                                                                mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    private let onChange: @MainActor () -> Void
    private var defaultListener: AudioObjectPropertyListenerBlock?
    private var rateListener: (device: AudioObjectID, block: AudioObjectPropertyListenerBlock)?

    public init(onChange: @escaping @MainActor () -> Void) {
        self.onChange = onChange
        let block = makeBlock()
        var address = Self.defaultAddress
        if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, block) == noErr {
            defaultListener = block
        }
    }

    /// Watch the sample rate of `device` (the one playback is on) instead of the previous one.
    public func watchRate(of device: AudioObjectID?) {
        if rateListener?.device == device { return }
        if let (old, block) = rateListener {
            var address = Self.rateAddress
            AudioObjectRemovePropertyListenerBlock(old, &address, .main, block)
            rateListener = nil
        }
        guard let device else { return }
        let block = makeBlock()
        var address = Self.rateAddress
        if AudioObjectAddPropertyListenerBlock(device, &address, .main, block) == noErr { rateListener = (device, block) }
    }

    public func stop() {
        watchRate(of: nil)
        if let block = defaultListener {
            var address = Self.defaultAddress
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, block)
            defaultListener = nil
        }
    }

    private func makeBlock() -> AudioObjectPropertyListenerBlock {
        { [weak self] _, _ in
            // Registered on the main queue.
            MainActor.assumeIsolated { self?.onChange() }
        }
    }
}
