// Ported from src/weapons/ballistics.ts at commit 185029e. Shared hitscan: one `fire` call is one
// trigger pull, every pellet gets its own cone sample, trace and damage. The local player's rounds
// are traced from the camera; everyone else's from the muzzle they pass in.
import IronvaleContract
import IronvaleWorld

public final class Ballistics {
    private enum Kind { case land, casing, whiz }

    private struct Pending {
        let due: Double
        let kind: Kind
        let weapon: WeaponDef
        let shooterId: Int
        let result: ShotResult?
        let direction: Vec3
        let point: Vec3
    }

    private var pending: [Pending] = []
    private var lastTime: Double
    private let events: EventBus
    private let combat: any ShotResolver
    private let player: () -> any Combatant
    private let cameraPosition: () -> Vec3
    private let time: () -> Double
    private let random: () -> Double
    private let c: SimConstants.Ballistics

    public init(events: EventBus, combat: any ShotResolver, player: @escaping () -> any Combatant,
                cameraPosition: @escaping () -> Vec3, time: @escaping () -> Double,
                random: @escaping () -> Double, constants: SimConstants.Ballistics = SimData.shared.constants.ballistics) {
        self.events = events
        self.combat = combat
        self.player = player
        self.cameraPosition = cameraPosition
        self.time = time
        self.random = random
        c = constants
        lastTime = time()
    }

    /// Lands rounds and casings that are due. The web runs this from `engine.onFrame`.
    public func flush() {
        let now = time()
        // The clock going backwards means a new match: nothing in flight carries over.
        if now < lastTime { pending.removeAll() }
        lastTime = now
        var i = pending.count - 1
        while i >= 0 {
            let entry = pending[i]
            if entry.due <= now {
                pending[i] = pending[pending.count - 1]
                pending.removeLast()
                switch entry.kind {
                case .land:
                    if let result = entry.result { land(entry.weapon, entry.shooterId, result, entry.direction) }
                case .whiz:
                    events.emit(.nearMiss(point: entry.point, direction: entry.direction, weapon: entry.weapon.id))
                case .casing:
                    ejectCasing(entry.weapon, combat.get(entry.shooterId), entry.point, entry.direction)
                }
            }
            i -= 1
        }
    }

    public func fire(shooter: any Combatant, weapon: WeaponDef, muzzle: Vec3, direction: Vec3, spreadDegrees: Double? = nil) {
        let local = shooter.kind == .local
        let aim = direction.normalized()
        events.emit(.shotFired(shooterId: shooter.id, weapon: weapon.id, muzzle: muzzle, direction: aim, local: local))

        let origin = local ? cameraPosition() : muzzle
        let spread = spreadDegrees ?? weapon.spreadHip
        var whizzed = local
        for _ in 0 ..< Int(weapon.pellets) {
            let pellet = WeaponMath.sampleCone(axis: aim, halfAngleDegrees: spread, random: random)
            // Bullets pass through the shooter's own side: no friendly fire.
            let result = combat.raycast(origin: origin, direction: pellet, maxDistance: weapon.range, ignoreId: shooter.id, ignoreTeam: shooter.team)
            events.emit(.bulletTrace(shooterId: shooter.id, weapon: weapon.id, from: muzzle, to: result.end, local: local))
            if !whizzed { whizzed = checkNearMiss(weapon, origin, result, pellet) }
            if result.distance > c.INSTANT_RANGE {
                later(result.distance / weapon.muzzleVelocity, Pending(due: 0, kind: .land, weapon: weapon, shooterId: shooter.id,
                                                                        result: result, direction: pellet, point: result.end))
            } else {
                land(weapon, shooter.id, result, pellet)
            }
        }

        if local { return }
        if weapon.fireMode == "bolt" {
            later(c.BOLT_EJECT_DELAY, Pending(due: 0, kind: .casing, weapon: weapon, shooterId: shooter.id,
                                              result: nil, direction: aim, point: muzzle))
        } else {
            ejectCasing(weapon, shooter, muzzle, aim)
        }
    }

    private func later(_ seconds: Double, _ entry: Pending) {
        pending.append(Pending(due: time() + seconds, kind: entry.kind, weapon: entry.weapon, shooterId: entry.shooterId,
                               result: entry.result, direction: entry.direction, point: entry.point))
    }

    private func land(_ weapon: WeaponDef, _ shooterId: Int, _ result: ShotResult, _ direction: Vec3) {
        if let target = result.combatant, let hit = result.combatantHit {
            if !target.alive { return }
            target.applyDamage(DamageInfo(amount: WeaponMath.damageAt(weapon, hit.distance, hit.zone), zone: hit.zone,
                                          attackerId: shooterId, weaponId: weapon.id, point: hit.point, direction: direction))
            events.emit(.combatantHit(weapon: weapon.id, targetId: target.id, attackerId: shooterId, hit: hit,
                                      direction: direction, fatal: !target.alive))
        } else if let world = result.world {
            events.emit(.bulletImpact(shooterId: shooterId, weapon: weapon.id, hit: world))
        }
    }

    private func ejectCasing(_ weapon: WeaponDef, _ shooter: (any Combatant)?, _ muzzle: Vec3, _ direction: Vec3) {
        let up = Vec3(0, 1, 0)
        var side = direction.cross(up)
        if side.lengthSq < 1e-6 { side = Vec3(1, 0, 0) }
        side = side.normalized()
        let position = muzzle.adding(direction, scaledBy: -c.CASING_BEHIND_MUZZLE)
        var velocity = side.scaled(c.CASING_SIDE_SPEED * (0.8 + random() * 0.4))
            .adding(up, scaledBy: c.CASING_UP_SPEED * (0.7 + random() * 0.6))
        if let shooter { velocity = velocity + shooter.velocity }
        events.emit(.casingEjected(kind: weapon.casing, position: position, velocity: velocity))
    }

    /// Returns true when a near miss was reported for this round.
    private func checkNearMiss(_ weapon: WeaponDef, _ origin: Vec3, _ result: ShotResult, _ direction: Vec3) -> Bool {
        let player = player()
        if !player.alive || result.combatant === player { return false }
        let head = player.eyePosition()
        let nearest = WeaponMath.closestPointOnSegment(origin, result.end, head)
        if nearest.distanceToSquared(head) > c.NEAR_MISS_RADIUS * c.NEAR_MISS_RADIUS { return false }
        let along = nearest.distance(to: origin)
        if along > c.INSTANT_RANGE {
            later(along / weapon.muzzleVelocity, Pending(due: 0, kind: .whiz, weapon: weapon, shooterId: -1,
                                                         result: nil, direction: direction, point: nearest))
        } else {
            events.emit(.nearMiss(point: nearest, direction: direction, weapon: weapon.id))
        }
        return true
    }
}
