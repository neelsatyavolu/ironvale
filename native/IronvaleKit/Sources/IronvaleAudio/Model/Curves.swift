// Ported from src/audio/curves.ts at commit cbe0add.
// Distance, air absorption, propagation delay and occlusion curves. Pure functions: the engine
// evaluates them when a sound starts and a few times a second for loops.

import Foundation

public enum SoundClass: String, Sendable, CaseIterable {
    case gunshot, impact, footstep, foley, voice, casing, ambient, generic
}

public struct DistanceProfile: Sendable, Equatable {
    /// Distance in metres at which the sound plays at full level.
    public var ref: Double
    /// Beyond this the sound is silent and is not started at all.
    public var max: Double
    /// 1 is physical inverse-distance falloff; lower carries further.
    public var rolloff: Double
    /// Distance over which air absorption halves the low-pass cutoff.
    public var airHalf: Double
    /// The low-pass never closes below this, in Hz.
    public var minCutoff: Double
    /// Sound arrives late by distance / speed of sound once it is far enough to notice.
    public var delayed: Bool

    public init(ref: Double, max: Double, rolloff: Double, airHalf: Double, minCutoff: Double, delayed: Bool) {
        self.ref = ref
        self.max = max
        self.rolloff = rolloff
        self.airHalf = airHalf
        self.minCutoff = minCutoff
        self.delayed = delayed
    }
}

public enum Curves {
    public static func profile(_ soundClass: SoundClass) -> DistanceProfile {
        switch soundClass {
        case .gunshot: DistanceProfile(ref: 9, max: 700, rolloff: 0.6, airHalf: 60, minCutoff: 600, delayed: true)
        case .impact: DistanceProfile(ref: 3, max: 140, rolloff: 1, airHalf: 45, minCutoff: 900, delayed: true)
        case .footstep: DistanceProfile(ref: 1.6, max: 38, rolloff: 1, airHalf: 22, minCutoff: 1200, delayed: false)
        case .foley: DistanceProfile(ref: 1.3, max: 28, rolloff: 1, airHalf: 18, minCutoff: 1400, delayed: false)
        case .voice: DistanceProfile(ref: 2, max: 45, rolloff: 1, airHalf: 28, minCutoff: 1200, delayed: false)
        case .casing: DistanceProfile(ref: 1, max: 16, rolloff: 1, airHalf: 14, minCutoff: 2500, delayed: false)
        case .ambient: DistanceProfile(ref: 4, max: 70, rolloff: 0.9, airHalf: 40, minCutoff: 900, delayed: false)
        case .generic: DistanceProfile(ref: 2, max: 60, rolloff: 1, airHalf: 30, minCutoff: 1000, delayed: false)
        }
    }

    public static let speedOfSound = 343.0
    /// Closer than this the delay is too short to hear and is skipped.
    public static let delayFromMetres = 30.0
    public static let openCutoff = 20000.0
    static let fadeFraction = 0.15
    static let occludedFloorHz = 450.0

    /// Inverse-distance gain (1 inside `ref`), fading to exactly 0 over the last part before `max`.
    public static func distanceGain(_ distance: Double, _ profile: DistanceProfile) -> Double {
        if distance >= profile.max { return 0 }
        let d = Swift.max(distance, profile.ref)
        let inverse = profile.ref / (profile.ref + profile.rolloff * (d - profile.ref))
        let fadeStart = profile.max * (1 - fadeFraction)
        let fade = distance <= fadeStart ? 1 : 1 - (distance - fadeStart) / (profile.max - fadeStart)
        return inverse * fade
    }

    /// Low-pass cutoff in Hz that stands in for air absorption: open up close, closing with distance.
    public static func airCutoff(_ distance: Double, _ profile: DistanceProfile) -> Double {
        let beyond = Swift.max(0, distance - profile.ref)
        return Swift.max(profile.minCutoff, openCutoff * pow(0.5, beyond / profile.airHalf))
    }

    /// Seconds a sound takes to arrive.
    public static func propagationDelay(_ distance: Double, _ profile: DistanceProfile) -> Double {
        if !profile.delayed || distance < delayFromMetres { return 0 }
        return distance / speedOfSound
    }

    public static func occlusion(blocked: Bool) -> Occlusion { blocked ? .blocked : .clear }

    /// Cutoff after air absorption and occlusion.
    public static func finalCutoff(_ distance: Double, _ profile: DistanceProfile, _ occlusion: Occlusion) -> Double {
        Swift.max(occludedFloorHz, airCutoff(distance, profile) * occlusion.cutoff)
    }

    /// Footstep level: running is louder and a little higher, crouching is quiet.
    public static func stepLevel(running: Bool, crouching: Bool) -> (volume: Double, pitch: Double) {
        if crouching { return (0.28, 0.97) }
        return running ? (0.85, 1.04) : (0.5, 1)
    }

    /// Landing level from fall speed in m/s: a hop is a scuff, a long drop is a thump.
    public static func landingVolume(_ speed: Double) -> Double {
        Swift.min(1, Swift.max(0.22, (speed - 1.5) / 8))
    }
}

public struct Occlusion: Sendable, Equatable {
    public let gain: Double
    /// Multiplies the air-absorption cutoff.
    public let cutoff: Double

    public static let clear = Occlusion(gain: 1, cutoff: 1)
    /// A wall between source and listener: quieter and much duller, never silent.
    public static let blocked = Occlusion(gain: 0.42, cutoff: 0.16)
}

/// Hands out a fixed number of line-of-sight tests per frame.
public struct RaycastBudget: Sendable {
    private let perFrame: Int
    private var left: Int

    public init(perFrame: Int) {
        self.perFrame = perFrame
        left = perFrame
    }

    public mutating func reset() { left = perFrame }

    public mutating func take() -> Bool {
        if left <= 0 { return false }
        left -= 1
        return true
    }
}
