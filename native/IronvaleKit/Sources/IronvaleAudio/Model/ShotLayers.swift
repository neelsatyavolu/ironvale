// Ported from src/audio/layers.ts and src/audio/variation.ts at commit cbe0add.

import Foundation

public enum ReverbPreset: String, Sendable, CaseIterable, BitwiseCopyable {
    case openField = "open-field", forest, street, industrial, interior
}

/// How a gunshot is layered: close crack against distant take, tail, sub, mechanism and reverb send.
public struct ShotLayers: Sendable, Equatable {
    public let close: Double
    public let distant: Double
    public let tail: Double
    public let tailCutoff: Double
    public let sub: Double
    public let mech: Double
    public let reverbSend: Double

    public static let closeUntil = 35.0
    public static let distantFrom = 130.0
    static let mechRange = 7.0

    static func environment(_ preset: ReverbPreset) -> (tail: Double, tailCutoff: Double, send: Double) {
        switch preset {
        case .openField: (1, 9000, 0.16)
        case .forest: (0.8, 4200, 0.34)
        case .street: (0.7, 7000, 0.42)
        case .industrial: (0.62, 8000, 0.5)
        case .interior: (0.16, 3000, 0.72)
        }
    }

    public static func choose(local: Bool, distance: Double, environment preset: ReverbPreset) -> ShotLayers {
        let env = environment(preset)
        if local {
            return ShotLayers(close: 1, distant: 0, tail: env.tail, tailCutoff: env.tailCutoff, sub: 0.9, mech: 0.4, reverbSend: env.send)
        }
        let far = smoothstep(closeUntil, distantFrom, distance)
        return ShotLayers(
            close: cos((far * Double.pi) / 2),
            distant: sin((far * Double.pi) / 2),
            tail: env.tail * (1 - 0.45 * far),
            tailCutoff: env.tailCutoff,
            sub: 0,
            mech: distance < mechRange ? 0.3 * (1 - distance / mechRange) : 0,
            reverbSend: env.send * (1 - 0.3 * far)
        )
    }

    /// The reverb in force: the interior zone's preset under a roof, the map's own outside.
    public static func activeReverb(_ mapPreset: ReverbPreset, indoors: Bool, zone: ReverbPreset?) -> ReverbPreset {
        indoors ? (zone ?? .interior) : mapPreset
    }
}

func smoothstep(_ from: Double, _ to: Double, _ value: Double) -> Double {
    let t = min(1, max(0, (value - from) / (to - from)))
    return t * t * (3 - 2 * t)
}

/// Picks which take of a sound to play; the same take never plays twice in a row.
public final class VariationPicker {
    private var last: [String: Int] = [:]
    private let random: () -> Double

    public init(random: @escaping () -> Double) {
        self.random = random
    }

    /// Index in [0, count) for the next play of `group`.
    public func next(_ group: String, count: Int) -> Int {
        if count <= 1 { return 0 }
        let previous = last[group] ?? -1
        var index = Int((random() * Double(previous < 0 ? count : count - 1)).rounded(.down))
        if previous >= 0 && index >= previous { index += 1 }
        index = min(count - 1, index)
        last[group] = index
        return index
    }
}

/// A multiplier of 1 +/- `amount`, for pitch and level variation.
public func jitter(_ random: () -> Double, _ amount: Double) -> Double {
    1 + (random() * 2 - 1) * amount
}
