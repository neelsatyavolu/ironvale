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
    /// Sees every command the engine sends MixCore, trace-only markers included (the app's audio report).
    public var monitor: ((MixCommand) -> Void)? {
        get { sink.monitor }
        set { sink.monitor = newValue }
    }
    private let sink: MonitoredSink

    /// `sampleRate`: the output rate (AudioOutput.hardwareSampleRate() for live playback).
    public init(repo: URL, host: AudioHost, sampleRate: Double, random: @escaping () -> Double = { Double.random(in: 0..<1) }) throws {
        let core = MixCore(sampleRate: sampleRate)
        self.core = core
        library = try SoundLibrary(repo: repo, core: core)
        let sink = MonitoredSink(core: core)
        self.sink = sink
        engine = AudioEngine(host: host, catalog: Catalog(ids: library.ids), decoder: library, sink: sink, sampleRate: sampleRate,
                             clock: { [unowned core] in core.currentTime }, random: random)
    }

    /// Start live playback with the device I/O buffer at `bufferFrames` (nil keeps the device's own).
    /// A failed start leaves nothing running.
    public func startOutput(bufferFrames: UInt32?, device: AudioObjectID? = nil, probe: RenderProbe? = nil) throws {
        stopOutput()
        let output = AudioOutput(core: core, probe: probe)
        do {
            try output.start(bufferFrames: bufferFrames, device: device)
        } catch {
            output.stop()
            throw error
        }
        self.output = output
    }

    /// Stop live playback; MixCore must not be rendered by two engines at once.
    public func stopOutput() {
        output?.stop()
        output = nil
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

/// Forwards to MixCore, showing each command to an optional monitor first.
private final class MonitoredSink: MixSink {
    let core: MixCore
    var monitor: ((MixCommand) -> Void)?

    init(core: MixCore) { self.core = core }

    func send(_ command: MixCommand) {
        monitor?(command)
        core.send(command)
    }
}
