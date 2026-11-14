// Ported from src/audio/pool.ts at commit cbe0add.
// The voice pool, main-thread side. Every slot keeps its filter, gain and panner for the life of
// the engine; playing a sound only starts a source in MixCore. Positional voices get distance
// gain, an air-absorption low-pass, a propagation delay and an occlusion test here.

import IronvaleWorld

public struct DecodedSound: Sendable {
    public let id: String
    /// Row in the MixCore sound table (-1 when there is no PCM, as in the trace harness).
    public let table: Int32
    public let duration: Double
    /// Seconds of leading silence to skip.
    public let offset: Double
    public let loopStart: Double
    public let loopEnd: Double

    public init(id: String, table: Int32, duration: Double, offset: Double, loopStart: Double, loopEnd: Double) {
        self.id = id
        self.table = table
        self.duration = duration
        self.offset = offset
        self.loopStart = loopStart
        self.loopEnd = loopEnd
    }
}

/// One play call. A value type: fill in what differs from the defaults.
public struct PlayRequest {
    public var sound: DecodedSound?
    public var bus = BusName.effects
    /// World position, or nil for the listener's own sounds.
    public var position: Vec3?
    public var soundClass = SoundClass.generic
    public var profile: DistanceProfile?
    public var volume = 1.0
    public var pitch = 1.0
    /// -1 (left) to 1 (right); only for sounds without a position.
    public var pan = 0.0
    /// 0 - 1 into the reverb.
    public var send = 0.0
    /// Extra low-pass ceiling in Hz.
    public var cutoff = VoicePool.openHz
    public var priority = Priority.normal
    public var group = ""
    public var groupCap = 0
    public var loop = false
    /// Seconds to wait on top of any propagation delay.
    public var delay = 0.0
    public var occlude = true
    /// Result of a test already made for this event, so its layers share one ray.
    public var occlusion: Occlusion?
    public var fadeIn = 0.0

    public init(sound: DecodedSound? = nil) {
        self.sound = sound
    }
}

/// Stops or re-levels one playing sound; inert once that sound has ended or been replaced.
public struct SoundHandle {
    public let stop: (Double?) -> Void
    public let setVolume: (Double) -> Void

    public static var silent: SoundHandle { SoundHandle(stop: { _ in }, setVolume: { _ in }) }
}

public final class VoicePool {
    public static let maxPlaying = 32
    public static let maxHrtf = 8
    public static let slotCount = 44
    public static let stealFade = 0.03
    static let raycastsPerFrame = 5
    static let loopRefresh = 0.25
    public static let openHz = 20000.0

    struct Slot {
        let gain: ParamMirror
        let filter: ParamMirror
        let send: ParamMirror
        var hasSource = false
        var bus: BusName?
        var usesPanner: Bool?
        var generation: UInt32 = 0
        var x = 0.0, y = 0.0, z = 0.0
        var profile = Curves.profile(.generic)
        var volume = 1.0
        var cutoff = VoicePool.openHz
        var occlusion = 1.0
        var refreshIn = 0.0
    }

    public let book = VoiceBook(slots: VoicePool.slotCount, maxPlaying: VoicePool.maxPlaying)
    /// Listener position, updated by the engine every frame.
    public var listener = Vec3.zero
    public var hrtfEnabled = true

    private var slots: [Slot]
    private var budget = RaycastBudget(perFrame: VoicePool.raycastsPerFrame)
    private unowned let sink: MixSink
    private let clock: () -> Double
    private let lineOfSight: (Vec3, Vec3) -> Bool

    init(sink: MixSink, clock: @escaping () -> Double, lineOfSight: @escaping (Vec3, Vec3) -> Bool) {
        self.sink = sink
        self.clock = clock
        self.lineOfSight = lineOfSight
        slots = (0..<VoicePool.slotCount).map { i in
            let s = Int32(i)
            return Slot(
                gain: ParamMirror(.voice(slot: s, .gain), initial: 0, sink: sink, clock: clock),
                filter: ParamMirror(.voice(slot: s, .cutoff), initial: VoicePool.openHz, sink: sink, clock: clock),
                send: ParamMirror(.voice(slot: s, .send), initial: 0, sink: sink, clock: clock)
            )
        }
    }

    var now: Double { clock() }

    /// Start a sound. Returns the slot index, or -1 when it was out of range, outranked or not loaded.
    @discardableResult
    public func play(_ request: PlayRequest) -> Int {
        sink.send(.playBegin)
        let index = start(request)
        sink.send(.playEnd(slot: Int32(index)))
        return index
    }

    private func start(_ request: PlayRequest) -> Int {
        guard let sound = request.sound else { return -1 }
        let now = self.now
        let profile = request.profile ?? Curves.profile(request.soundClass)
        let position = request.position

        var distance = 0.0
        var level = request.volume
        var cutoff = request.cutoff
        var delay = request.delay
        var occlusion = Occlusion.clear
        if let position {
            distance = jsHypot(position.x - listener.x, position.y - listener.y, position.z - listener.z)
            // A one-shot that starts out of earshot is over before the listener could reach it.
            if !request.loop && distance >= profile.max { return -1 }
            if let given = request.occlusion { occlusion = given } else if request.occlude { occlusion = occlusionAt(position) }
            level *= Curves.distanceGain(distance, profile) * occlusion.gain
            cutoff = Swift.min(cutoff, Curves.finalCutoff(distance, profile, occlusion))
            delay += Curves.propagationDelay(distance, profile)
        }

        let acquired = book.acquire(
            VoiceRequest(priority: request.priority, group: request.group, groupCap: request.groupCap, positional: position != nil, distance: distance, loop: request.loop),
            now: now
        )
        for stolen in acquired.stolen { silence(stolen, VoicePool.stealFade) }
        let index = acquired.slot
        if index < 0 { return -1 }

        let startAt = now + delay
        route(index, request.bus, position != nil)
        if let position {
            sink.send(.position(slot: Int32(index), x: position.x, y: position.y, z: position.z))
            slots[index].x = position.x
            slots[index].y = position.y
            slots[index].z = position.z
        } else {
            sink.send(.stereoPan(slot: Int32(index), request.pan))
        }
        slots[index].profile = profile
        slots[index].volume = request.volume
        slots[index].cutoff = request.cutoff
        slots[index].occlusion = occlusion == .clear ? 1 : 0
        slots[index].refreshIn = Double(index % 5) * 0.05

        let slot = slots[index]
        slot.gain.cancelScheduledValues(now)
        if request.fadeIn > 0 {
            slot.gain.setValueAtTime(0, now)
            slot.gain.setValueAtTime(0, startAt)
            slot.gain.linearRampToValueAtTime(level, startAt + request.fadeIn)
        } else {
            slot.gain.setValueAtTime(level, now)
        }
        slot.filter.cancelScheduledValues(now)
        slot.filter.setValueAtTime(Swift.min(VoicePool.openHz, cutoff), now)
        slot.send.cancelScheduledValues(now)
        slot.send.setValueAtTime(request.send, now)

        slots[index].generation &+= 1
        slots[index].hasSource = true
        sink.send(.startVoice(slot: Int32(index), SourceStart(
            sound: sound.table,
            start: startAt,
            offset: request.loop ? sound.loopStart : sound.offset,
            rate: request.pitch,
            loop: request.loop,
            loopStart: request.loop ? sound.loopStart : 0,
            loopEnd: request.loop ? sound.loopEnd : 0,
            generation: slots[index].generation
        )))

        if position != nil {
            refreshHrtf()
            // A pooled HRTF panner would crossfade from wherever it last was; it starts in place.
            sink.send(.panningModel(slot: Int32(index), hrtf: false))
            if book.voices[index].hrtf { sink.send(.panningModel(slot: Int32(index), hrtf: true)) }
        }
        return index
    }

    /// Whether slot `index` currently holds an occlusion-free voice (1) or a blocked one (0).
    public func occlusionState(_ index: Int) -> Double { slots[index].occlusion }

    /// One budgeted line-of-sight test from the listener. Clear when the frame's budget is spent.
    public func occlusionAt(_ position: Vec3) -> Occlusion {
        budget.take() ? Curves.occlusion(blocked: blocked(position.x, position.y, position.z)) : .clear
    }

    public func distanceTo(_ position: Vec3) -> Double {
        jsHypot(position.x - listener.x, position.y - listener.y, position.z - listener.z)
    }

    /// A handle for callers outside the engine and for loops.
    public func handle(_ index: Int) -> SoundHandle {
        if index < 0 { return .silent }
        let generation = slots[index].generation
        return SoundHandle(
            stop: { [weak self] fade in
                guard let self, self.slots[index].generation == generation, self.slots[index].hasSource else { return }
                self.stop(index, fade ?? VoicePool.stealFade)
            },
            setVolume: { [weak self] volume in
                guard let self, self.slots[index].generation == generation, self.slots[index].hasSource else { return }
                let slot = self.slots[index]
                let scale = slot.volume > 0 ? volume / slot.volume : 0
                self.slots[index].volume = volume
                slot.gain.setTargetAtTime(slot.gain.value * scale, self.now, 0.05)
            }
        )
    }

    public func stop(_ index: Int, _ fadeSeconds: Double = VoicePool.stealFade) {
        guard slots.indices.contains(index), slots[index].hasSource else { return }
        book.release(index, now: now, fade: fadeSeconds + 0.01)
        silence(index, fadeSeconds)
    }

    /// Stop every voice, or only the one-shots (loops keep running muted while paused).
    public func stopAll(_ fadeSeconds: Double, includeLoops: Bool) {
        for i in slots.indices {
            if !slots[i].hasSource { continue }
            if !includeLoops && book.voices[i].loop { continue }
            stop(i, fadeSeconds)
        }
    }

    public var playing: Int { book.playing }

    /// MixCore (or the harness) reports that the source started with `generation` fell silent.
    public func sourceEnded(slot index: Int, generation: UInt32) {
        guard slots.indices.contains(index), slots[index].generation == generation, slots[index].hasSource else { return }
        slots[index].hasSource = false
        book.release(index, now: now, fade: 0)
    }

    /// Per-frame work: reset the raycast budget and keep positional loops matched to the listener.
    public func update(_ dt: Double) {
        budget.reset()
        let now = self.now
        for i in slots.indices {
            let voice = book.voices[i]
            if !voice.active || !voice.loop || !voice.positional { continue }
            slots[i].refreshIn -= dt
            if slots[i].refreshIn > 0 { continue }
            slots[i].refreshIn = VoicePool.loopRefresh
            let slot = slots[i]
            let distance = jsHypot(slot.x - listener.x, slot.y - listener.y, slot.z - listener.z)
            book.setDistance(i, distance)
            if distance < slot.profile.max && budget.take() { slots[i].occlusion = blocked(slot.x, slot.y, slot.z) ? 0 : 1 }
            let occlusion = Curves.occlusion(blocked: slots[i].occlusion == 0)
            slot.gain.setTargetAtTime(slot.volume * Curves.distanceGain(distance, slot.profile) * occlusion.gain, now, 0.18)
            slot.filter.setTargetAtTime(Swift.min(slot.cutoff, Curves.finalCutoff(distance, slot.profile, occlusion)), now, 0.18)
        }
        for slot in slots {
            slot.gain.compact(now: now)
            slot.filter.compact(now: now)
            slot.send.compact(now: now)
        }
    }

    private func blocked(_ x: Double, _ y: Double, _ z: Double) -> Bool {
        !lineOfSight(listener, Vec3(x, y, z))
    }

    /// Give HRTF to the nearest and newest positional voices; the rest use equal-power panning.
    private func refreshHrtf() {
        for index in book.assignHrtf(max: hrtfEnabled ? VoicePool.maxHrtf : 0) {
            sink.send(.panningModel(slot: Int32(index), hrtf: book.voices[index].hrtf))
        }
    }

    private func route(_ index: Int, _ bus: BusName, _ usesPanner: Bool) {
        slots[index].usesPanner = usesPanner
        slots[index].bus = bus
        sink.send(.route(slot: Int32(index), bus: bus, positional: usesPanner))
    }

    /// Ramp a slot down and stop its source, without a click.
    private func silence(_ index: Int, _ fadeSeconds: Double) {
        guard slots[index].hasSource else { return }
        let now = self.now
        let generation = slots[index].generation
        slots[index].generation &+= 1
        slots[index].hasSource = false
        let slot = slots[index]
        slot.gain.cancelScheduledValues(now)
        slot.gain.setTargetAtTime(0, now, fadeSeconds / 4)
        slot.send.setTargetAtTime(0, now, fadeSeconds / 4)
        sink.send(.stopVoice(slot: Int32(index), generation: generation, when: now + fadeSeconds))
    }
}

/// `Math.hypot` for three values, as V8 computes it: scaled by the largest magnitude, Kahan-summed.
func jsHypot(_ a: Double, _ b: Double, _ c: Double) -> Double {
    let x = abs(a), y = abs(b), z = abs(c)
    let m = Swift.max(x, y, z)
    if m == .infinity { return .infinity }
    if m == 0 { return 0 }
    var sum = 0.0, compensation = 0.0
    for v in [x, y, z] {
        let r = v / m
        let s = r * r - compensation
        let p = sum + s
        compensation = (p - sum) - s
        sum = p
    }
    return (sum.squareRoot()) * m
}
