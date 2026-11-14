// Ported from src/characters/locomotion.ts at commit f14381f.
import Foundation

public enum GaitClip: Int, CaseIterable, Sendable {
    case idle, walk, jog, run, crouchIdle, crouchWalk, crouchJog

    public var name: String {
        switch self {
        case .idle: "idle"
        case .walk: "walk"
        case .jog: "jog"
        case .run: "run"
        case .crouchIdle: "crouchIdle"
        case .crouchWalk: "crouchWalk"
        case .crouchJog: "crouchJog"
        }
    }

    public var isMoving: Bool { self != .idle && self != .crouchIdle }
}

/// Clip weights indexed by `GaitClip.rawValue`.
public struct GaitWeights: Sendable, Equatable {
    public var values: [Double] = [1, 0, 0, 0, 0, 0, 0]
    public init() {}
    public subscript(clip: GaitClip) -> Double {
        get { values[clip.rawValue] }
        set { values[clip.rawValue] = newValue }
    }
}

public enum Locomotion {
    struct Band {
        let clip: GaitClip
        let from: Double
        let to: Double
    }

    // locomotion.ts STANDING and CROUCHED (end in Infinity, so the exporter cannot read them).
    static let standing = [Band(clip: .idle, from: 0, to: 0.1), Band(clip: .walk, from: 0.8, to: 2.0),
                           Band(clip: .jog, from: 2.5, to: 4.4), Band(clip: .run, from: 5.1, to: .infinity)]
    static let crouched = [Band(clip: .crouchIdle, from: 0, to: 0.1), Band(clip: .crouchWalk, from: 0.5, to: 0.9),
                           Band(clip: .crouchJog, from: 1.5, to: .infinity)]
    static let movingClips: [GaitClip] = [.walk, .jog, .run, .crouchWalk, .crouchJog]

    private static func addBands(_ bands: [Band], _ speed: Double, _ share: Double, _ out: inout GaitWeights) {
        if share <= 0 { return }
        for i in bands.indices {
            let band = bands[i]
            let next = i + 1 < bands.count ? bands[i + 1] : nil
            guard let next, speed > band.to else {
                out[band.clip] += share
                return
            }
            if speed < next.from {
                let mix = (speed - band.to) / (next.from - band.to)
                out[band.clip] += share * (1 - mix)
                out[next.clip] += share * mix
                return
            }
        }
    }

    /// Clip weights for a ground speed. `crouch` is 0 standing, 1 crouched.
    public static func gaitWeights(speed: Double, crouch: Double) -> GaitWeights {
        var out = GaitWeights()
        out.values = [0, 0, 0, 0, 0, 0, 0]
        let amount = min(1, max(0, crouch))
        let pace = max(0, speed)
        addBands(standing, pace, 1 - amount, &out)
        addBands(crouched, pace, amount, &out)
        return out
    }

    /// Metres of ground one full cycle covers for this mix; infinity when not moving.
    public static func cycleLength(_ weights: GaitWeights, tables: CharacterTables = .shared) -> Double {
        var length = 0.0
        var total = 0.0
        for clip in movingClips {
            let weight = weights[clip]
            if weight <= 0 { continue }
            let meta = tables.clip(clip.name)
            length += weight * (meta.speed ?? 0) * meta.duration
            total += weight
        }
        return total > 1e-4 ? length / total : .infinity
    }

    /// Advances the stride phase by the ground covered this step.
    public static func advancePhase(_ phase: Double, speed: Double, weights: GaitWeights, dt: Double, reverse: Bool,
                                    tables: CharacterTables = .shared) -> Double {
        let length = cycleLength(weights, tables: tables)
        if !length.isFinite || speed <= 0 { return phase }
        let cadence = min(speed / length, tables.maxCadence)
        let next = phase + (reverse ? -cadence : cadence) * dt
        return next - next.rounded(.down)
    }

    /// Time into a looping clip for a stride phase, lined up on the left foot strike.
    public static func clipTime(_ clip: GaitClip, phase: Double, tables: CharacterTables = .shared) -> Double {
        let meta = tables.clip(clip.name)
        let shifted = phase + (meta.strike ?? 0)
        return (shifted - shifted.rounded(.down)) * meta.duration
    }

    /// locomotion.ts wrapAngle: `angle - Math.round(angle / 2π) * 2π` (Math.round rounds halves up).
    static func wrapAngle(_ angle: Double) -> Double {
        angle - (angle / (2 * .pi) + 0.5).rounded(.down) * 2 * .pi
    }

    public struct Heading: Sendable, Equatable {
        public let hipYaw: Double
        public let reverse: Bool
    }

    public static func resolveHeading(_ moveAngle: Double, wasReverse: Bool, tables: CharacterTables = .shared) -> Heading {
        let angle = wrapAngle(moveAngle)
        let threshold = tables.reverseAngle + (wasReverse ? -tables.reverseHysteresis : tables.reverseHysteresis)
        let reverse = abs(angle) > threshold
        let legs = reverse ? wrapAngle(angle - .pi) : angle
        return Heading(hipYaw: min(tables.maxHipYaw, max(-tables.maxHipYaw, legs)), reverse: reverse)
    }
}
