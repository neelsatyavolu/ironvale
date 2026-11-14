// Wires the audio together for the app: MixCore (render thread), the sound library, the
// main-thread AudioEngine and, when asked, the AVAudioEngine output. The game calls `frame`
// once per frame with that frame's GameEvents.

import CoreAudio
import Foundation

extension MixCore: MixSink {
    /// Main thread: queue a command for the next render call. Trace-only markers are not sent.
    public func send(_ command: MixCommand) {
        switch command {
        case .playBegin, .playEnd: return
        default: commands.push(command)
        }
    }
}

public final class AudioSession {
    public let core: MixCore
    public let library: SoundLibrary
    public let engine: AudioEngine
    public private(set) var output: AudioOutput?

    /// `sampleRate`: the output rate (AudioOutput.hardwareSampleRate() for live playback).
    public init(repo: URL, host: AudioHost, sampleRate: Double, random: @escaping () -> Double = { Double.random(in: 0..<1) }) throws {
        let core = MixCore(sampleRate: sampleRate)
        self.core = core
        library = try SoundLibrary(repo: repo, core: core)
        engine = AudioEngine(host: host, catalog: Catalog(ids: library.ids), decoder: library, sink: core, sampleRate: sampleRate,
                             clock: { [unowned core] in core.currentTime }, random: random)
    }

    /// Start live playback with the device I/O buffer at `bufferFrames`.
    public func startOutput(bufferFrames: UInt32, device: AudioObjectID? = nil, probe: RenderProbe? = nil) throws {
        let output = AudioOutput(core: core, probe: probe)
        try output.start(bufferFrames: bufferFrames, device: device)
        self.output = output
    }

    /// One game frame: hand back ended voices, deliver this frame's events, then update.
    public func frame(dt: Double, events: [AudioEvent]) {
        drainEnded()
        for event in events { engine.handle(event) }
        engine.update(dt)
    }

    public func drainEnded() {
        while let ended = core.ended.pop() { engine.sourceEnded(slot: Int(ended.slot), generation: ended.generation) }
    }
}
