// A scripted firefight that drives Effects the way a match with bots does: N shooters in a ring
// around a centre, each firing bursts at its own rate at points near the centre, with traces,
// impacts on the level (world raycasts), casings, hits and the odd grenade. Used by the M9 FX
// benchmark (FXBenchmark: GPU cost at 16 bots) and the allocation test; deterministic per seed.
import Darwin
import IronvaleCore
import IronvaleWorld

public final class Firefight {
    struct Shooter {
        var position: D3
        var weapon: FXWeapon
        var interval: Double
        var timer: Double
        var burstLeft: Int
        var pause: Double
    }

    public let centre: D3
    private var shooters: [Shooter] = []
    private var random: SeededRandom
    private var grenadeTimer = 2.0
    private let world: CollisionWorld?

    public init(centre: D3, bots: Int, radius: Double, weapons: [FXWeapon], world: CollisionWorld?, seed: UInt32 = 0x16b075) {
        self.centre = centre
        self.world = world
        random = SeededRandom(seed: seed)
        for i in 0..<bots {
            let angle = Double(i) / Double(bots) * .pi * 2
            let r = radius * (0.6 + 0.4 * random.next())
            let weapon = weapons[i % weapons.count]
            shooters.append(Shooter(position: D3(centre.x + cos(angle) * r, centre.y + 1.45, centre.z + sin(angle) * r),
                                    weapon: weapon, interval: 60 / 650, timer: random.next() * 0.5, burstLeft: 0, pause: 0))
        }
    }

    /// Fires whatever is due in the next `dt` seconds into `fx`.
    public func step(_ dt: Double, _ fx: Effects) {
        for i in shooters.indices {
            shooters[i].timer -= dt
            while shooters[i].timer <= 0 {
                if shooters[i].burstLeft == 0 {
                    shooters[i].burstLeft = 3 + Int(random.next() * 6)
                    shooters[i].timer += 0.25 + random.next() * 0.6
                    continue
                }
                shooters[i].burstLeft -= 1
                shooters[i].timer += shooters[i].interval
                fire(shooters[i], fx)
            }
        }
        grenadeTimer -= dt
        if grenadeTimer <= 0 {
            grenadeTimer += 3
            let a = random.next() * .pi * 2
            var p = D3(centre.x + cos(a) * 6, centre.y + 0.3, centre.z + sin(a) * 6)
            if let g = world?.groundHeight(x: p.x, z: p.z, fromY: centre.y + 3, maxDrop: 10) { p.y = g + 0.1 }
            fx.grenadeExploded(position: p)
        }
    }

    private func fire(_ s: Shooter, _ fx: Effects) {
        let target = D3(centre.x + (random.next() - 0.5) * 12, centre.y + random.next() * 2.2, centre.z + (random.next() - 0.5) * 12)
        let direction = (target - s.position).normalized()
        fx.shotFired(weapon: s.weapon, muzzle: s.position, direction: direction, local: false)
        let range = 120.0
        if let hit = world?.raycast(origin: s.position.vec3, direction: direction.vec3, maxDistance: range) {
            let point = D3(hit.point)
            fx.bulletTrace(weapon: s.weapon, from: s.position, to: point, local: false)
            if random.next() < 0.12 {
                fx.combatantHit(targetId: 99, point: point, direction: direction, fatal: random.next() < 0.2)
            } else {
                fx.bulletImpact(weapon: s.weapon, point: point, normal: D3(hit.normal), surface: hit.surface)
            }
        } else {
            fx.bulletTrace(weapon: s.weapon, from: s.position, to: s.position.adding(direction, range), local: false)
        }
        let side = D3(-direction.z, 0, direction.x)
        fx.casingEjected(kind: .rifle, position: s.position.adding(side, 0.08),
                         velocity: (side * (1.6 + random.next())).adding(D3.up, 1.2 + random.next() * 0.6))
    }
}
