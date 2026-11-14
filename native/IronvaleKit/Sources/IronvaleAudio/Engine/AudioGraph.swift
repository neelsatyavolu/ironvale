// Ported from src/audio/graph.ts at commit cbe0add.
// The fixed part of the graph, main-thread side: bus levels, ducking, the low-health narrowing,
// the reverb slot crossfade and the procedural sub thump. MixCore renders what this schedules.
//
//   voices ──> effects ─┐
//   beds ──> bedFilter ─┤
//   loops ─> duck ─> ambience ─> world ─> mix ─┬─> master ─> limiter ─> trim ─> clip ─> out
//   reverb return ─> effects        interface ─┘

import Foundation

public struct AudioSettings: Sendable, Equatable {
    public var master: Double
    public var effects: Double
    public var ambience: Double
    public var interface: Double
    public var hrtf: Bool
    /// Bumped whenever the settings object is replaced; the web compares object identity.
    public var revision: Int

    public init(master: Double, effects: Double, ambience: Double, interface: Double, hrtf: Bool, revision: Int = 0) {
        self.master = master
        self.effects = effects
        self.ambience = ambience
        self.interface = interface
        self.hrtf = hrtf
        self.revision = revision
    }
}

public final class AudioGraph {
    static let reverbFade = 0.7
    static let smooth = 0.05
    /// Make-up gain taken back after the limiter (graph.ts LIMITER_TRIM).
    public static let limiterTrim = 0.82
    public static let subBuffer = "proc-sub"

    public let sampleRate: Double
    private let clock: () -> Double
    private var params: [BusParam: ParamMirror] = [:]
    private unowned let sink: MixSink
    private var activeSlot = 0
    private var slotPreset: [ReverbPreset?] = [nil, nil]
    private var reverb: ReverbPreset?
    private var pendingReverb: ReverbPreset?
    private var reverbBusyUntil = 0.0
    private var applied: Int?

    init(sampleRate: Double, sink: MixSink, clock: @escaping () -> Double) {
        self.sampleRate = sampleRate
        self.sink = sink
        self.clock = clock
        for bus in BusParam.allCases { params[bus] = ParamMirror(.bus(bus), initial: bus.initial, sink: sink, clock: clock) }
    }

    public var now: Double { clock() }

    func param(_ bus: BusParam) -> ParamMirror { params[bus]! }

    /// Follow the volume sliders. Acts only when the settings object changed.
    func applySettings(_ settings: AudioSettings) {
        if settings.revision == applied { return }
        applied = settings.revision
        let now = self.now
        param(.master).setTargetAtTime(settings.master, now, AudioGraph.smooth)
        param(.effects).setTargetAtTime(settings.effects, now, AudioGraph.smooth)
        param(.ambience).setTargetAtTime(settings.ambience, now, AudioGraph.smooth)
        param(.interface).setTargetAtTime(settings.interface, now, AudioGraph.smooth)
    }

    /// Crossfade to another reverb. A change that arrives mid-fade waits for the idle slot.
    func setReverb(_ preset: ReverbPreset) {
        if preset == reverb {
            pendingReverb = nil
            return
        }
        if now < reverbBusyUntil {
            pendingReverb = preset
            return
        }
        let now = self.now
        let next = 1 - activeSlot
        slotPreset[next] = preset
        sink.send(.reverbImpulse(slot: Int32(next), preset))
        fadeTo(param(next == 0 ? .reverb0 : .reverb1), 1, now, AudioGraph.reverbFade)
        fadeTo(param(activeSlot == 0 ? .reverb0 : .reverb1), 0, now, AudioGraph.reverbFade)
        activeSlot = next
        reverb = preset
        pendingReverb = nil
        reverbBusyUntil = now + AudioGraph.reverbFade + 0.05
    }

    /// Once a frame: apply a reverb change queued during a fade and rest the faded-out convolver.
    func update() {
        if now < reverbBusyUntil { return }
        let idle = 1 - activeSlot
        if slotPreset[idle] != nil {
            slotPreset[idle] = nil
            sink.send(.reverbImpulse(slot: Int32(idle), nil))
        }
        if let pending = pendingReverb { setReverb(pending) }
        let now = self.now
        for mirror in params.values { mirror.compact(now: now) }
    }

    /// Dip ambience under a gunshot and let it swell back. `depth` is the gain at the bottom.
    func duckAmbience(_ depth: Double, _ hold: Double, _ release: Double) {
        let now = self.now
        let gain = param(.duck)
        gain.cancelScheduledValues(now)
        gain.setTargetAtTime(depth, now, 0.012)
        gain.setTargetAtTime(1, now + hold, release)
    }

    /// Under a roof the outside world loses its top end and some level.
    func setIndoors(_ indoors: Bool) {
        param(.bedFilter).setTargetAtTime(indoors ? 1100 : 20000, now, 0.35)
    }

    /// 0 is a normal mix; 1 closes the world down to a dull murmur (low health).
    func setNarrow(_ amount: Double) {
        let cutoff = 20000 * pow(900.0 / 20000, min(1, max(0, amount)))
        param(.mix).setTargetAtTime(cutoff, now, 0.25)
    }

    /// Mute or restore everything in the world; the interface bus keeps playing.
    func setWorldGain(_ value: Double, _ seconds: Double) {
        fadeTo(param(.world), value, now, seconds)
    }

    /// A short sine drop for the chest thump under the player's own shots, at the engine rate.
    static func makeSubBuffer(sampleRate rate: Double) -> [Float] {
        let length = Int((0.24 * rate).rounded(.down))
        var data = [Float](repeating: 0, count: length)
        var phase = 0.0
        for i in 0..<length {
            let t = Double(i) / rate
            phase += (2 * Double.pi * (38 + 62 * exp(-t / 0.035))) / rate
            data[i] = Float(sin(phase) * min(1, t / 0.003) * exp(-t / 0.06) * min(1, Double(length - i) / (0.02 * rate)))
        }
        return data
    }

    private func fadeTo(_ param: ParamMirror, _ value: Double, _ now: Double, _ seconds: Double) {
        param.cancelScheduledValues(now)
        param.setValueAtTime(param.value, now)
        param.linearRampToValueAtTime(value, now + seconds)
    }
}
