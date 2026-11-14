// The command stream from the main-thread audio engine to MixCore (PLAN.md 3.8). Every value is
// plain data, so a command copies into the SPSC ring without allocating. The same stream is what
// the M8a trace harness records and compares with the web's Web Audio calls.

import IronvaleWorld

/// Web Audio AudioParam automation.
public enum AutomationKind: UInt8, Sendable, BitwiseCopyable {
    case set, lin, target, cancel
}

public struct Automation: Sendable, Equatable, BitwiseCopyable {
    public var kind: AutomationKind
    public var time: Double
    public var value: Double
    public var tau: Double

    public init(_ kind: AutomationKind, time: Double, value: Double = 0, tau: Double = 0) {
        self.kind = kind
        self.time = time
        self.value = value
        self.tau = tau
    }
}

/// The fixed graph's automated params (graph.ts).
public enum BusParam: Int, Sendable, CaseIterable, BitwiseCopyable {
    case master, world, mix, ambience, duck, effects, interface, bedFilter, ambienceLoops, reverbIn, reverb0, reverb1

    public var name: String { String(describing: self) }
    /// Value before any automation, as the web constructs the node.
    public var initial: Double {
        switch self {
        case .master, .reverb0, .reverb1: 0
        case .mix, .bedFilter: 20000
        default: 1
        }
    }
}

public enum VoiceParam: Int, Sendable, BitwiseCopyable {
    case gain, cutoff, send
}

public enum ParamID: Sendable, Equatable, Hashable, BitwiseCopyable {
    case bus(BusParam)
    case voice(slot: Int32, VoiceParam)
    case bed(Int32)
}

public enum BusName: String, Sendable, BitwiseCopyable {
    case effects, ambience, interface
}

/// Where a bed's gain feeds: the indoor low-pass, or straight into the ducked ambience.
public enum BedDestination: UInt8, Sendable, BitwiseCopyable {
    case bedFilter, ambienceLoops
}

public struct SourceStart: Sendable, Equatable, BitwiseCopyable {
    /// Row in the MixCore sound table.
    public var sound: Int32
    public var start: Double
    public var offset: Double
    public var rate: Double
    public var loop: Bool
    public var loopStart: Double
    public var loopEnd: Double
    /// Changes every time the slot starts or loses a source; ended notices carry it back.
    public var generation: UInt32
}

/// Listener position, forward and up vectors (PannerNode listener), as plain doubles.
public struct ListenerPose: Sendable, Equatable, BitwiseCopyable {
    public var px, py, pz, fx, fy, fz, ux, uy, uz: Double

    public init(position p: Vec3, forward f: Vec3, up u: Vec3) {
        (px, py, pz, fx, fy, fz, ux, uy, uz) = (p.x, p.y, p.z, f.x, f.y, f.z, u.x, u.y, u.z)
    }
}

public enum MixCommand: Sendable, BitwiseCopyable {
    case param(ParamID, Automation)
    case startVoice(slot: Int32, SourceStart)
    case stopVoice(slot: Int32, generation: UInt32, when: Double)
    case route(slot: Int32, bus: BusName, positional: Bool)
    case position(slot: Int32, x: Double, y: Double, z: Double)
    case stereoPan(slot: Int32, Double)
    case panningModel(slot: Int32, hrtf: Bool)
    case startBed(bed: Int32, SourceStart, BedDestination)
    case stopBed(bed: Int32, when: Double)
    case listener(ListenerPose)
    /// Convolver slot 0 or 1 takes this preset's impulse (nil: emptied); MixCore convolves (Convolver.swift).
    case reverbImpulse(slot: Int32, ReverbPreset?)
    /// Brackets one VoicePool.play call; MixCore ignores them, the trace uses them for attribution.
    case playBegin
    case playEnd(slot: Int32)
}

/// Receives the engine's commands: MixCore's ring in the app, a recorder in the trace harness.
public protocol MixSink: AnyObject {
    func send(_ command: MixCommand)
}

/// A param's main-thread mirror: forwards automation to the sink and keeps the timeline, so
/// `value` reads match what the web's AudioParam.value returns (float32 of the timeline at now).
public final class ParamMirror {
    public let id: ParamID
    public private(set) var timeline: ParamTimeline
    private unowned let sink: MixSink
    private let clock: () -> Double

    init(_ id: ParamID, initial: Double, sink: MixSink, clock: @escaping () -> Double) {
        self.id = id
        timeline = ParamTimeline(defaultValue: initial)
        self.sink = sink
        self.clock = clock
    }

    public var value: Double { Double(Float(timeline.value(at: clock()))) }

    func setValueAtTime(_ value: Double, _ time: Double) { add(Automation(.set, time: time, value: value)) }
    func linearRampToValueAtTime(_ value: Double, _ time: Double) { add(Automation(.lin, time: time, value: value)) }
    func setTargetAtTime(_ value: Double, _ time: Double, _ tau: Double) { add(Automation(.target, time: time, value: value, tau: tau)) }
    func cancelScheduledValues(_ time: Double) { add(Automation(.cancel, time: time)) }

    /// Keep the mirror short; values from `now` on are unchanged.
    func compact(now: Double) { timeline.compact(now: now) }

    private func add(_ event: Automation) {
        timeline.apply(event)
        sink.send(.param(id, event))
    }
}
