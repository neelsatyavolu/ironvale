// Ported from src/weapons/recoil.ts at commit 185029e.
import Foundation
import IronvaleContract

/// What the shooter's body is doing when a shot breaks.
public struct Stance: Sendable, Equatable {
    /// 0 hip, 1 aimed.
    public var aimBlend = 0.0
    public var crouching = false
    /// Horizontal speed, m/s.
    public var speed = 0.0
    public var airborne = false

    public init(aimBlend: Double = 0, crouching: Bool = false, speed: Double = 0, airborne: Bool = false) {
        self.aimBlend = aimBlend
        self.crouching = crouching
        self.speed = speed
        self.airborne = airborne
    }
}

/// Per-shot view kick and the firing cone.
public final class RecoilModel {
    /// Degrees to pass to `PlayerController.addRecoil` for the last shot.
    public private(set) var kickPitch = 0.0
    public private(set) var kickYaw = 0.0
    private var heat = 0.0
    private var bloom = 0.0
    private var sinceShot = Double.infinity
    private let random: () -> Double
    private let c: SimConstants.Recoil

    public init(constants: SimConstants.Recoil = SimData.shared.constants.recoil, random: @escaping () -> Double) {
        c = constants
        self.random = random
    }

    public func shot(_ def: WeaponDef, _ stance: Stance) {
        let growth = 1 + c.GROWTH_PER_SHOT * min(heat, c.MAX_HEAT)
        let steadied = (1 - (1 - c.AIMED_KICK) * stance.aimBlend) * (stance.crouching ? c.CROUCHED : 1)
        kickPitch = def.recoil.vertical * growth * steadied
        kickYaw = (random() * 2 - 1) * def.recoil.horizontal * growth * steadied
        heat = min(heat + 1, c.MAX_HEAT)
        bloom = min(bloom + c.BLOOM_PER_SHOT * def.spreadHip, c.MAX_BLOOM * def.spreadHip)
        sinceShot = 0
    }

    public func update(_ dt: Double) {
        sinceShot += dt
        if sinceShot > c.HEAT_HOLD_SECONDS { heat = max(0, heat - dt * c.HEAT_DRAIN_PER_SECOND) }
        bloom *= JSMath.exp(-dt * c.BLOOM_RECOVERY)
    }

    /// Cone half-angle in degrees for a shot fired now.
    public func spread(_ def: WeaponDef, _ stance: Stance) -> Double {
        let aim = stance.aimBlend
        let base = def.spreadHip + (def.spreadAim - def.spreadHip) * aim
        let moving = def.spreadMoving * min(1, stance.speed / c.FULL_MOVE_SPEED) * (1 - (1 - c.AIMED_MOVE) * aim)
        let bloomPart = bloom * (1 - (1 - c.AIMED_BLOOM) * aim)
        let air = stance.airborne ? max(c.AIR_SPREAD_MIN, def.spreadHip * c.AIR_SPREAD_FACTOR) : 0
        return (base + moving + bloomPart + air) * (stance.crouching ? c.CROUCHED : 1)
    }

    public func reset() {
        heat = 0
        bloom = 0
        sinceShot = .infinity
    }
}
