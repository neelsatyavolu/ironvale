// Ported from src/ai/aim.ts and src/ai/marksman.ts at commit cbe0add.
import Foundation
import IronvaleContract

private let radToDeg = 180 / Double.pi
private let lossRate = 2.0
private let flinchDecay = 3.0
private let movingPenalty = 1.35

/// Cone half-angle in degrees for shots that land within `metres` of the aim point at 20 m.
public func aimErrorDegrees(_ metres: Double) -> Double { atan(metres / 20) * radToDeg }

/// How well a soldier is on target right now.
public struct AimModel: Sendable {
    private let profile: DifficultyProfile
    private let steady: Double
    private var tracked = 0.0
    private var flinch = 0.0

    public init(profile: DifficultyProfile) {
        self.profile = profile
        steady = aimErrorDegrees(profile.aimErrorAt20m)
    }

    public mutating func reset() { tracked = 0 }

    public mutating func update(_ dt: Double, tracking: Bool) {
        tracked = tracking ? tracked + dt : max(0, tracked - dt * lossRate)
        flinch *= exp(-dt * flinchDecay)
    }

    public mutating func disturb(_ degrees: Double) { flinch += degrees }

    /// Spread cone half-angle in degrees for a shot now.
    public func spread(targetAngularSpeed: Double, moving: Bool) -> Double {
        let settle = exp(-profile.aimTightenRate * tracked)
        let base = steady * (1 + (profile.firstShotPenalty - 1) * settle)
        return base * (moving ? movingPenalty : 1) + targetAngularSpeed * profile.trackingLag + flinch
    }
}

/// Seconds a scoped rifle needs to bring the scope onto a target, on top of the reaction time.
public let scopeInSeconds = 0.35

public func readyToFire(_ def: WeaponDef, sightedTime: Double, reactionTime: Double) -> Bool {
    !def.scoped || sightedTime >= reactionTime + scopeInSeconds
}

public func botShotSpread(_ def: WeaponDef, aimSpread: Double, distance: Double, minRange: Double) -> Double {
    let weaponSpread = def.scoped && distance < minRange ? def.spreadHip : def.spreadAim
    return max(aimSpread, weaponSpread)
}
