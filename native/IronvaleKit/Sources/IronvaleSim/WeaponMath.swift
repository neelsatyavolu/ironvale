// Ported from src/weapons/math.ts and src/weapons/loadout.ts at commit 185029e. Hit-registration
// math: the damage formula must equal the web's, because the receiver caps damage with it.
import Foundation
import IronvaleContract
import IronvaleWorld

public enum WeaponMath {
    /// Damage multiplier at a distance: 1 up to `falloffStart`, linear down to `falloffMin` at `falloffEnd`.
    public static func damageFalloff(start: Double, end: Double, min: Double, distance: Double) -> Double {
        if distance <= start { return 1 }
        if distance >= end { return min }
        let t = (distance - start) / (end - start)
        return 1 + (min - 1) * t
    }

    public static func damageFalloff(_ def: WeaponDef, _ distance: Double) -> Double {
        damageFalloff(start: def.falloffStart, end: def.falloffEnd, min: def.falloffMin, distance: distance)
    }

    public static func zoneMultiplier(_ def: WeaponDef, _ zone: HitZone) -> Double {
        switch zone {
        case .head: def.headshotMultiplier
        case .limb: def.limbMultiplier
        case .torso: 1
        }
    }

    /// Damage one projectile does to a zone at a distance.
    public static func damageAt(_ def: WeaponDef, _ distance: Double, _ zone: HitZone) -> Double {
        def.damage * damageFalloff(def, distance) * zoneMultiplier(def, zone)
    }

    /// Seconds between shots at the weapon's rate of fire.
    public static func shotInterval(_ roundsPerMinute: Double) -> Double { 60 / Swift.max(1, roundsPerMinute) }

    /// Random unit direction inside a cone around `axis` (unit length), uniform over the cone's cross-section.
    public static func sampleCone(axis: Vec3, halfAngleDegrees: Double, random: () -> Double) -> Vec3 {
        if halfAngleDegrees <= 0 { return axis }
        let angle = halfAngleDegrees * (Double.pi / 180) * random().squareRoot()
        let around = random() * (Double.pi * 2)
        // Any vector not parallel to the axis gives a stable tangent frame.
        let seed = abs(axis.y) < 0.99 ? Vec3(0, 1, 0) : Vec3(1, 0, 0)
        let tangent = seed.cross(axis).normalized()
        let bitangent = axis.cross(tangent)
        let side = JSMath.sin(angle)
        return axis.scaled(JSMath.cos(angle))
            .adding(tangent, scaledBy: side * JSMath.cos(around))
            .adding(bitangent, scaledBy: side * JSMath.sin(around))
            .normalized()
    }

    /// Nearest point to `p` on the segment a-b.
    public static func closestPointOnSegment(_ a: Vec3, _ b: Vec3, _ p: Vec3) -> Vec3 {
        let ab = b - a
        let lengthSq = ab.lengthSq
        if lengthSq < 1e-12 { return a }
        let t = Swift.min(1, Swift.max(0, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / lengthSq))
        return ab.scaled(t) + a
    }
}

/// The weapons a player carries into a match, in slot order (`issuedWeapons`). A duel has no
/// difficulty level, so every weapon is issued.
public func issuedWeapons(mode: MatchConfig.Mode, difficulty: String, data: SimData = .shared) -> [String] {
    data.contract.weapons.weaponIds.filter { id in
        guard let levels = data.constants.loadout.RESERVED[id] else { return true }
        return mode == .duel || levels.contains(difficulty)
    }
}
