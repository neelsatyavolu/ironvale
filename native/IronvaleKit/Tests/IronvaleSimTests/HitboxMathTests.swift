// Ported from tests/game/hitbox.test.ts, tests/weapons/math.test.ts and tests/weapons/loadout.test.ts
// at commit 185029e, plus the damageAt grid from Contract/sim/weapons.json.
import Foundation
import IronvaleCore
@testable import IronvaleSim
import IronvaleWorld
import Testing

private let feet = Vec3(0, 0, 0)
private let forward = Vec3(0, 0, -1)
private let DEG = Double.pi / 180

@Suite struct HitTestHumanoid {
    @Test func headHitAtHeadHeight() {
        let hit = hitTestHumanoid(feet: feet, crouching: false, origin: Vec3(0, 1.64, 10), direction: forward, maxDistance: 100)
        #expect(hit?.zone == .head)
        #expect(approx(hit!.distance, 10 - 0.125, 2))
    }

    @Test func torsoAndLimbHits() {
        #expect(hitTestHumanoid(feet: feet, crouching: false, origin: Vec3(0, 1.2, 10), direction: forward, maxDistance: 100)?.zone == .torso)
        #expect(hitTestHumanoid(feet: feet, crouching: false, origin: Vec3(0, 0.5, 10), direction: forward, maxDistance: 100)?.zone == .limb)
    }

    @Test func missesBesideAboveAndBeyondRange() {
        #expect(hitTestHumanoid(feet: feet, crouching: false, origin: Vec3(0.6, 1.2, 10), direction: forward, maxDistance: 100) == nil)
        #expect(hitTestHumanoid(feet: feet, crouching: false, origin: Vec3(0, 2.1, 10), direction: forward, maxDistance: 100) == nil)
        #expect(hitTestHumanoid(feet: feet, crouching: false, origin: Vec3(0, 1.2, 10), direction: forward, maxDistance: 5) == nil)
    }

    @Test func hitsAtOnceInsideTheBody() {
        let hit = hitTestHumanoid(feet: feet, crouching: false, origin: Vec3(0.05, 1.2, 0.1), direction: forward, maxDistance: 100)
        #expect(hit?.zone == .torso)
        #expect(hit?.distance == 0)
    }

    @Test func ignoresTargetsBehind() {
        #expect(hitTestHumanoid(feet: feet, crouching: false, origin: Vec3(0, 1.2, -10), direction: forward, maxDistance: 100) == nil)
    }

    @Test func lowersTheHeadWhenCrouching() {
        #expect(hitTestHumanoid(feet: feet, crouching: true, origin: Vec3(0, 1.64, 10), direction: forward, maxDistance: 100) == nil)
        #expect(hitTestHumanoid(feet: feet, crouching: true, origin: Vec3(0, 1.08, 10), direction: forward, maxDistance: 100)?.zone == .head)
    }
}

@Suite struct DamageMath {
    @Test func falloff() {
        let m4 = def("m4a1")
        #expect(WeaponMath.damageFalloff(m4, 0) == 1)
        #expect(WeaponMath.damageFalloff(m4, 35) == 1)
        #expect(approx(WeaponMath.damageFalloff(m4, (35 + 110) / 2), (1 + 0.65) / 2, 6))
        #expect(approx(WeaponMath.damageFalloff(m4, 110), 0.65, 6))
        #expect(approx(WeaponMath.damageFalloff(m4, 400), 0.65, 6))
        var previous = Double.infinity
        for d in stride(from: 0.0, through: 300, by: 5) {
            let value = WeaponMath.damageFalloff(m4, d)
            #expect(value <= previous)
            previous = value
        }
        #expect(WeaponMath.damageFalloff(start: 10, end: 10, min: 0.5, distance: 9) == 1)
        #expect(WeaponMath.damageFalloff(start: 10, end: 10, min: 0.5, distance: 11) == 0.5)
    }

    @Test func zonesAndDamage() {
        let m24 = def("m24")
        #expect(WeaponMath.zoneMultiplier(m24, .head) == m24.headshotMultiplier)
        #expect(WeaponMath.zoneMultiplier(m24, .limb) == m24.limbMultiplier)
        #expect(WeaponMath.zoneMultiplier(m24, .torso) == 1)
        #expect(approx(WeaponMath.damageAt(m24, 10, .torso), m24.damage, 6))
        #expect(approx(WeaponMath.damageAt(m24, 10, .head), m24.damage * m24.headshotMultiplier, 6))
        #expect(approx(WeaponMath.damageAt(m24, 900, .limb), m24.damage * m24.falloffMin * m24.limbMultiplier, 6))
    }

    @Test func shotInterval() {
        #expect(approx(WeaponMath.shotInterval(def("m4a1").roundsPerMinute), 0.075, 6))
        #expect(approx(WeaponMath.shotInterval(def("m24").roundsPerMinute), 60 / 42, 6))
    }

    @Test func damageGridMatchesTypeScriptExactly() throws {
        let root = try fixture("weapons.json") as! [String: Any]
        let grid = root["damage"] as! [String: [[Any]]]
        let distances: [Double] = [0, 5, 14, 20, 35, 50, 72.5, 110, 150, 400, 900]
        for (id, rows) in grid {
            for (z, zone) in [HitZone.head, .torso, .limb].enumerated() {
                for (i, d) in distances.enumerated() {
                    #expect(WeaponMath.damageAt(def(id), d, zone) == double(rows[z][i]), "\(id) \(zone) \(d)")
                }
            }
        }
    }
}

@Suite struct SampleCone {
    let axis = Vec3(0.3, 0.2, -0.9).normalized()

    @Test func zeroSpreadReturnsTheAxis() {
        var random = SeededRandom(seed: 1)
        let out = WeaponMath.sampleCone(axis: axis, halfAngleDegrees: 0, random: { random.next() })
        #expect(out.distance(to: axis) < 1e-9)
    }

    @Test func unitLengthAndInsideTheCone() {
        var random = SeededRandom(seed: 42)
        for _ in 0 ..< 2000 {
            let out = WeaponMath.sampleCone(axis: axis, halfAngleDegrees: 3, random: { random.next() })
            #expect(approx(out.length, 1, 6))
            #expect(out.angle(to: axis) <= 3 * DEG + 1e-6)
        }
    }

    @Test func centredAndEven() {
        var random = SeededRandom(seed: 7)
        var mean = Vec3.zero
        let half = 4.0, count = 8000
        var sumAngle = 0.0
        var inner = 0
        for _ in 0 ..< count {
            let out = WeaponMath.sampleCone(axis: axis, halfAngleDegrees: half, random: { random.next() })
            mean = mean + out
            let angle = out.angle(to: axis) / DEG
            sumAngle += angle
            if angle < half / 2 { inner += 1 }
        }
        #expect(mean.normalized().angle(to: axis) / DEG < 0.1)
        #expect(approx(sumAngle / Double(count), (2.0 / 3.0) * half, 1))
        #expect(approx(Double(inner) / Double(count), 0.25, 1))
    }

    @Test func repeatableAndWorksStraightUp() {
        var a = SeededRandom(seed: 99), b = SeededRandom(seed: 99)
        #expect(WeaponMath.sampleCone(axis: axis, halfAngleDegrees: 5, random: { a.next() })
            == WeaponMath.sampleCone(axis: axis, halfAngleDegrees: 5, random: { b.next() }))
        var r = SeededRandom(seed: 3)
        let up = Vec3(0, 1, 0)
        let out = WeaponMath.sampleCone(axis: up, halfAngleDegrees: 2, random: { r.next() })
        #expect(out.angle(to: up) <= 2 * DEG + 1e-6)
        #expect((out.x + out.y + out.z).isFinite)
    }
}

@Suite struct ClosestPointOnSegment {
    @Test func projectsAndClamps() {
        let a = Vec3(0, 0, 0), b = Vec3(10, 0, 0)
        #expect(WeaponMath.closestPointOnSegment(a, b, Vec3(4, 3, 0)) == Vec3(4, 0, 0))
        #expect(WeaponMath.closestPointOnSegment(a, b, Vec3(-5, 1, 0)).x == 0)
        #expect(WeaponMath.closestPointOnSegment(a, b, Vec3(25, 1, 0)).x == 10)
    }
}

@Suite struct Loadout {
    @Test func keepsTheM7ForVeteranAndElite() {
        #expect(issuedWeapons(mode: .skirmish, difficulty: "recruit") == ["m4a1", "mp5", "m24", "m249"])
        #expect(!issuedWeapons(mode: .survival, difficulty: "regular").contains("m7"))
        #expect(issuedWeapons(mode: .skirmish, difficulty: "veteran").contains("m7"))
        #expect(issuedWeapons(mode: .coop, difficulty: "elite").contains("m7"))
    }

    @Test func issuesEveryWeaponInADuel() {
        let all = ["m4a1", "mp5", "m24", "m249", "m7", "scarh"]
        #expect(issuedWeapons(mode: .duel, difficulty: "recruit") == all)
        #expect(issuedWeapons(mode: .duel, difficulty: "elite") == all)
    }

    @Test func issuesTheScarHAlongsideTheM7() {
        #expect(!issuedWeapons(mode: .skirmish, difficulty: "regular").contains("scarh"))
        #expect(issuedWeapons(mode: .skirmish, difficulty: "veteran") == ["m4a1", "mp5", "m24", "m249", "m7", "scarh"])
        #expect(issuedWeapons(mode: .coop, difficulty: "elite").contains("scarh"))
    }
}
