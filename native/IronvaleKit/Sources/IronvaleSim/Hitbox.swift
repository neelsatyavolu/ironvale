// Ported from src/game/hitbox.ts at commit 185029e. The volumes come from Contract/bodies.json.
import IronvaleContract
import IronvaleWorld

/// Ray against a three-capsule humanoid (head, torso, legs) standing at `feet`. The first volume
/// in list order that the ray touches wins (head before torso), so the order is load-bearing.
public func hitTestHumanoid(
    feet: Vec3, crouching: Bool, origin: Vec3, direction: Vec3, maxDistance: Double,
    hitbox: BodiesTable.Hitbox = SimData.shared.contract.bodies.hitbox
) -> CombatantHit? {
    for volume in crouching ? hitbox.CROUCHING : hitbox.STANDING {
        guard let distance = rayVerticalCapsule(feet: feet, volume: volume, origin: origin, direction: direction),
              distance <= maxDistance,
              let zone = HitZone(rawValue: volume.zone)
        else { continue }
        return CombatantHit(distance: distance, zone: zone, point: origin.adding(direction, scaledBy: distance))
    }
    return nil
}

/// Distance along the ray to an upright capsule, or nil on a miss.
func rayVerticalCapsule(feet: Vec3, volume: BodiesTable.Volume, origin: Vec3, direction: Vec3) -> Double? {
    let r2 = volume.radius * volume.radius
    var nearest: Double?

    // Infinite vertical cylinder, then clamp to the segment.
    let ox = origin.x - feet.x
    let oz = origin.z - feet.z
    let a = direction.x * direction.x + direction.z * direction.z
    let c = ox * ox + oz * oz - r2
    let startY = origin.y - feet.y
    // A ray that starts inside the volume (an enemy pressed against the muzzle) hits at once.
    if c < 0, startY >= volume.bottom, startY <= volume.top { return 0 }
    if a > 1e-9 {
        let b = ox * direction.x + oz * direction.z
        let disc = b * b - a * c
        if disc >= 0 {
            let t = (-b - disc.squareRoot()) / a
            let y = origin.y + direction.y * t - feet.y
            if t >= 0, y >= volume.bottom, y <= volume.top { nearest = t }
        }
    }

    for height in [volume.bottom, volume.top] {
        let offset = Vec3(ox, origin.y - (feet.y + height), oz)
        let b = offset.dot(direction)
        let c = offset.lengthSq - r2
        if c < 0 { return 0 }
        let disc = b * b - c
        if disc < 0 { continue }
        let t = -b - disc.squareRoot()
        if t >= 0, nearest.map({ t < $0 }) ?? true { nearest = t }
    }
    return nearest
}
