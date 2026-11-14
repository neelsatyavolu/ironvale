// Ported from src/audio/voices.ts at commit cbe0add.
// Bookkeeping for the voice pool: which slot a new sound gets, which playing sound it may cut
// off, and which positional voices get the costly HRTF panner. Holds no audio state.

public enum Priority: Int, Sendable, Comparable {
    case low = 0, normal = 1, high = 2, critical = 3
    public static func < (a: Priority, b: Priority) -> Bool { a.rawValue < b.rawValue }
}

public struct VoiceInfo: Sendable {
    public var active = false
    /// Start order; lower is older.
    public var serial = 0
    public var priority = Priority.low
    /// Voices in one group share a small cap. "" is uncapped.
    public var group = ""
    public var positional = false
    /// Metres from the listener when it started (0 for the player's own sounds).
    public var distance = 0.0
    public var loop = false
    /// Time before which a just-stopped slot must not be reused.
    public var freeAt = 0.0
    public var hrtf = false
}

public struct VoiceRequest: Sendable {
    public var priority: Priority
    public var group: String
    /// Most voices of this group that may sound at once; 0 is no cap.
    public var groupCap: Int
    public var positional: Bool
    public var distance: Double
    public var loop: Bool
}

public struct Acquired: Sendable, Equatable {
    /// Slot for the new voice, or -1 when it should not play.
    public let slot: Int
    /// Slots to fade out and stop first.
    public let stolen: [Int]
}

public final class VoiceBook {
    public private(set) var voices: [VoiceInfo]
    private var serial = 0
    private let maxPlaying: Int

    public init(slots: Int, maxPlaying: Int) {
        voices = Array(repeating: VoiceInfo(), count: slots)
        self.maxPlaying = maxPlaying
    }

    public var playing: Int { voices.reduce(0) { $0 + ($1.active ? 1 : 0) } }

    public func setDistance(_ slot: Int, _ distance: Double) { voices[slot].distance = distance }

    public func acquire(_ request: VoiceRequest, now: Double) -> Acquired {
        var stolen: [Int] = []
        if request.groupCap > 0 && request.group != "" {
            var inGroup = 0
            for voice in voices where voice.active && voice.group == request.group { inGroup += 1 }
            while inGroup >= request.groupCap {
                let oldest = oldest { $0.group == request.group }
                if oldest < 0 { break }
                release(oldest, now: now)
                stolen.append(oldest)
                inGroup -= 1
            }
        }
        if playing >= maxPlaying {
            let victim = victim(request.priority)
            if victim < 0 { return Acquired(slot: -1, stolen: stolen) }
            release(victim, now: now)
            stolen.append(victim)
        }
        guard let slot = voices.firstIndex(where: { !$0.active && $0.freeAt <= now }) else {
            return Acquired(slot: -1, stolen: stolen)
        }
        serial += 1
        voices[slot].active = true
        voices[slot].serial = serial
        voices[slot].priority = request.priority
        voices[slot].group = request.group
        voices[slot].positional = request.positional
        voices[slot].distance = request.distance
        voices[slot].loop = request.loop
        voices[slot].hrtf = false
        return Acquired(slot: slot, stolen: stolen)
    }

    /// Mark a slot free. `fade` seconds keep it out of reuse while its gain ramps down.
    public func release(_ slot: Int, now: Double, fade: Double = 0.04) {
        guard voices.indices.contains(slot) else { return }
        voices[slot].active = false
        voices[slot].freeAt = now + fade
    }

    /// The voice a new sound of `priority` may replace: lowest priority, then oldest. Never a loop.
    public func victim(_ priority: Priority) -> Int {
        var lowest = Priority.critical
        for voice in voices where voice.active && !voice.loop && voice.priority < lowest { lowest = voice.priority }
        if lowest > priority { return -1 }
        return oldest { !$0.loop && $0.priority == lowest }
    }

    private func oldest(_ match: (VoiceInfo) -> Bool) -> Int {
        var found = -1
        for i in voices.indices {
            let voice = voices[i]
            if !voice.active || !match(voice) { continue }
            if found < 0 || voice.serial < voices[found].serial { found = i }
        }
        return found
    }

    /// Decide which positional voices use HRTF: the `max` best by nearness and recency. Returns the slots whose state changed.
    public func assignHrtf(max: Int) -> [Int] {
        var changed: [Int] = []
        var ranked: [Int] = []
        for i in voices.indices where voices[i].active && voices[i].positional { ranked.append(i) }
        // Array.prototype.sort is stable; ranked is in slot order, so ties keep slot order.
        ranked.sort { a, b in
            let sa = hrtfScore(a), sb = hrtfScore(b)
            return sa != sb ? sa < sb : a < b
        }
        for i in voices.indices {
            let rank = ranked.firstIndex(of: i) ?? -1
            let want = rank >= 0 && rank < max
            if voices[i].hrtf != want {
                voices[i].hrtf = want
                if voices[i].active { changed.append(i) }
            }
        }
        return changed
    }

    /// Lower is more deserving: metres away plus a metre for every voice started since.
    private func hrtfScore(_ slot: Int) -> Double {
        voices[slot].distance + Double(serial - voices[slot].serial)
    }
}
