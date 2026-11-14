// Ported from tests/weapons/ballistics.test.ts at commit 185029e: combat.raycast is stubbed by a
// resolver, exactly as the TypeScript test stubs it.
import Foundation
import IronvaleContract
import IronvaleCore
@testable import IronvaleSim
@testable import IronvaleWorld
import Testing

private let DEG = Double.pi / 180
private let FORWARD = Vec3(0, 0, -1)
private let BUCKSHOT = variant(def("mp5"), ["pellets": 9, "damage": 15, "falloffStart": 8, "falloffEnd": 32, "range": 70])

private typealias Resolver = (Vec3, Vec3, Double) -> (distance: Double, combatant: (any Combatant)?, hit: CombatantHit?, world: RayHit?)

private final class StubCombat: ShotResolver {
    var resolve: Resolver
    var casts: [(origin: Vec3, direction: Vec3, max: Double, ignore: Int)] = []
    var lookup: [Int: any Combatant] = [:]

    init(_ resolve: @escaping Resolver) { self.resolve = resolve }

    func get(_ id: Int) -> (any Combatant)? { lookup[id] }

    func raycast(origin: Vec3, direction: Vec3, maxDistance: Double, ignoreId: Int, ignoreTeam _: Team?) -> ShotResult {
        casts.append((origin, direction, maxDistance, ignoreId))
        let r = resolve(origin, direction, maxDistance)
        return ShotResult(world: r.world, combatant: r.combatant, combatantHit: r.hit,
                          end: origin.adding(direction, scaledBy: r.distance), distance: r.distance)
    }
}

private final class Setup {
    let events = EventBus()
    let player = Dummy(id: 1, kind: .local, team: .bravo, name: "dummy", x: 0, z: 0, eyeHeight: 1.64)
    let bot = Dummy(id: 2, kind: .bot, team: .bravo, name: "dummy", x: 0, z: -30, eyeHeight: 1.64)
    let cameraPosition = Vec3(0, 1.7, 0)
    var time = 10.0
    let combat: StubCombat
    var ballistics: Ballistics!
    var log: [String: [GameEvent]] = [:]

    init(_ resolve: @escaping Resolver = { _, _, max in (max, nil, nil, nil) }) {
        combat = StubCombat(resolve)
        combat.lookup = [1: player, 2: bot]
        var random = SeededRandom(seed: 11)
        let player = player, camera = cameraPosition
        ballistics = Ballistics(events: events, combat: combat, player: { player }, cameraPosition: { camera },
                                time: { [unowned self] in time }, random: { random.next() })
        events.on { [unowned self] event in log[event.name, default: []].append(event) }
    }

    func count(_ name: String) -> Int { log[name]?.count ?? 0 }

    func advance(_ seconds: Double) {
        time += seconds
        ballistics.flush()
    }
}

private func bodyHit(_ target: any Combatant, _ distance: Double, _ zone: HitZone) -> Resolver {
    { origin, direction, _ in (distance, target, CombatantHit(distance: distance, zone: zone, point: origin.adding(direction, scaledBy: distance)), nil) }
}

private func wallHit(_ distance: Double) -> Resolver {
    { origin, direction, _ in
        (distance, nil, nil, RayHit(point: origin.adding(direction, scaledBy: distance), normal: direction.negated, distance: distance, surface: .concrete))
    }
}

/// A damage target with the TS test's eye height and kind.
private func target() -> Dummy { Dummy(id: 7, kind: .bot, team: .bravo, name: "dummy", x: 0, z: 0, eyeHeight: 1.64) }

@Suite struct BallisticsEvents {
    @Test func oneShotOneTrace() {
        let s = Setup()
        let muzzle = Vec3(0.1, 1.5, -0.5)
        s.ballistics.fire(shooter: s.player, weapon: def("m4a1"), muzzle: muzzle, direction: FORWARD, spreadDegrees: 0)
        #expect(s.count("shotFired") == 1)
        if case let .shotFired(shooter, _, _, _, local) = s.log["shotFired"]![0] {
            #expect(local)
            #expect(shooter == 1)
        }
        #expect(s.count("bulletTrace") == 1)
        if case let .bulletTrace(_, _, from, _, _) = s.log["bulletTrace"]![0] { #expect(from == muzzle) }
        #expect(s.combat.casts[0].max == def("m4a1").range)
        #expect(s.combat.casts[0].ignore == 1)
    }

    @Test func everyPelletOneShotEvent() {
        let s = Setup()
        s.ballistics.fire(shooter: s.player, weapon: BUCKSHOT, muzzle: .zero, direction: FORWARD, spreadDegrees: 3)
        #expect(s.count("shotFired") == 1)
        #expect(s.count("bulletTrace") == 9)
        #expect(s.combat.casts.count == 9)
        #expect(Set(s.combat.casts.map { "\($0.direction)" }).count == 9)
        for cast in s.combat.casts { #expect(cast.direction.angle(to: FORWARD) <= 3 * DEG + 1e-6) }
    }

    @Test func spreadGivenOrHip() {
        let tight = Setup()
        tight.ballistics.fire(shooter: tight.bot, weapon: def("m4a1"), muzzle: .zero, direction: FORWARD, spreadDegrees: 0)
        #expect(tight.combat.casts[0].direction.angle(to: FORWARD) < 1e-6)
        let loose = Setup()
        for _ in 0 ..< 200 { loose.ballistics.fire(shooter: loose.bot, weapon: def("m4a1"), muzzle: .zero, direction: FORWARD) }
        let widest = loose.combat.casts.map { $0.direction.angle(to: FORWARD) / DEG }.max()!
        #expect(widest <= def("m4a1").spreadHip + 1e-6)
        #expect(widest > def("m4a1").spreadHip * 0.8)
    }

    @Test func eyeForThePlayerMuzzleForOthers() {
        let s = Setup()
        let muzzle = Vec3(0.2, 1.4, -0.6)
        s.ballistics.fire(shooter: s.player, weapon: def("m4a1"), muzzle: muzzle, direction: FORWARD, spreadDegrees: 0)
        s.ballistics.fire(shooter: s.bot, weapon: def("m4a1"), muzzle: muzzle, direction: FORWARD, spreadDegrees: 0)
        #expect(s.combat.casts[0].origin == s.cameraPosition)
        #expect(s.combat.casts[1].origin == muzzle)
    }

    @Test func worldImpact() {
        let s = Setup(wallHit(12))
        s.ballistics.fire(shooter: s.player, weapon: def("m4a1"), muzzle: .zero, direction: FORWARD, spreadDegrees: 0)
        #expect(s.count("bulletImpact") == 1)
        if case let .bulletImpact(_, _, hit) = s.log["bulletImpact"]![0] { #expect(hit.distance == 12) }
        #expect(s.count("combatantHit") == 0)
    }
}

@Suite struct BallisticsDamage {
    @Test func falloffAndZone() {
        let mp5 = def("mp5")
        let t = target()
        let s = Setup(bodyHit(t, 32, .head))
        s.ballistics.fire(shooter: s.player, weapon: mp5, muzzle: .zero, direction: FORWARD, spreadDegrees: 0)
        #expect(t.damage.count == 1)
        let info = t.damage[0]
        #expect(approx(info.amount, mp5.damage * 0.75 * mp5.headshotMultiplier, 5))
        #expect(info.zone == .head && info.attackerId == 1 && info.weaponId == "mp5")
        #expect(info.direction.angle(to: FORWARD) < 1e-6)
        #expect(s.count("combatantHit") == 1)
        if case let .combatantHit(_, targetId, _, _, _, fatal) = s.log["combatantHit"]![0] {
            #expect(targetId == 7 && !fatal)
        }
        #expect(s.count("bulletImpact") == 0)
    }

    @Test func flagsTheFatalHit() {
        let t = target()
        let s = Setup(bodyHit(t, 20, .head))
        s.ballistics.fire(shooter: s.player, weapon: def("m24"), muzzle: .zero, direction: FORWARD, spreadDegrees: 0)
        #expect(!t.alive)
        if case let .combatantHit(_, _, _, _, _, fatal) = s.log["combatantHit"]![0] { #expect(fatal) }
    }

    @Test func sumsPellets() {
        let t = target()
        let s = Setup(bodyHit(t, 5, .torso))
        s.ballistics.fire(shooter: s.player, weapon: BUCKSHOT, muzzle: .zero, direction: FORWARD, spreadDegrees: 1)
        #expect(t.damage.count <= 9)
        #expect(t.damage.reduce(0) { $0 + $1.amount } >= 100)
        #expect(!t.alive)
    }
}

@Suite struct BulletTravelTime {
    @Test func instantInside80m() {
        let t = target()
        let s = Setup(bodyHit(t, 79, .torso))
        s.ballistics.fire(shooter: s.player, weapon: def("m24"), muzzle: .zero, direction: FORWARD, spreadDegrees: 0)
        #expect(t.damage.count == 1)
    }

    @Test func landsAfterFlightTime() {
        let t = target()
        let s = Setup(bodyHit(t, 395, .torso))
        s.ballistics.fire(shooter: s.player, weapon: def("m24"), muzzle: .zero, direction: FORWARD, spreadDegrees: 0)
        #expect(s.count("bulletTrace") == 1)
        #expect(t.damage.isEmpty)
        s.advance(0.45)
        #expect(t.damage.isEmpty)
        s.advance(0.06)
        #expect(t.damage.count == 1)
        #expect(s.count("combatantHit") == 1)
        s.advance(1)
        #expect(t.damage.count == 1)
    }

    @Test func delaysDistantImpacts() {
        let s = Setup(wallHit(440))
        s.ballistics.fire(shooter: s.player, weapon: def("m4a1"), muzzle: .zero, direction: FORWARD, spreadDegrees: 0)
        #expect(s.count("bulletImpact") == 0)
        s.advance(0.51)
        #expect(s.count("bulletImpact") == 1)
    }

    @Test func sparesADeadTarget() {
        let t = target()
        let s = Setup(bodyHit(t, 395, .torso))
        s.ballistics.fire(shooter: s.player, weapon: def("m24"), muzzle: .zero, direction: FORWARD, spreadDegrees: 0)
        t.alive = false
        s.advance(1)
        #expect(t.damage.isEmpty)
        #expect(s.count("combatantHit") == 0)
    }

    @Test func forgetsOnClockRestart() {
        let t = target()
        let s = Setup(bodyHit(t, 395, .torso))
        s.ballistics.fire(shooter: s.player, weapon: def("m24"), muzzle: .zero, direction: FORWARD, spreadDegrees: 0)
        s.time = 0
        s.advance(0)
        s.advance(30)
        #expect(t.damage.isEmpty)
    }
}

@Suite struct NearMisses {
    let botMuzzle = Vec3(0.8, 1.6, -30)
    let towardPlayer = Vec3(0, 0, 1)

    @Test func withinOnePointTwoMetres() {
        let s = Setup { _, _, max in (min(max, 60), nil, nil, nil) }
        s.ballistics.fire(shooter: s.bot, weapon: def("m4a1"), muzzle: botMuzzle, direction: towardPlayer, spreadDegrees: 0)
        #expect(s.count("nearMiss") == 1)
        if case let .nearMiss(point, _, _) = s.log["nearMiss"]![0] { #expect(point.distance(to: Vec3(0.8, 1.6, 0)) < 0.05) }
    }

    @Test func quietForAWideMiss() {
        let s = Setup { _, _, max in (min(max, 60), nil, nil, nil) }
        s.ballistics.fire(shooter: s.bot, weapon: def("m4a1"), muzzle: Vec3(3, 1.6, -30), direction: towardPlayer, spreadDegrees: 0)
        #expect(s.count("nearMiss") == 0)
    }

    @Test func quietWhenStoppedShort() {
        let s = Setup(wallHit(20))
        s.ballistics.fire(shooter: s.bot, weapon: def("m4a1"), muzzle: botMuzzle, direction: towardPlayer, spreadDegrees: 0)
        #expect(s.count("nearMiss") == 0)
    }

    @Test func quietWhenItHitsThePlayer() {
        let s = Setup()
        s.combat.resolve = bodyHit(s.player, 30, .torso)
        s.ballistics.fire(shooter: s.bot, weapon: def("m4a1"), muzzle: botMuzzle, direction: towardPlayer, spreadDegrees: 0)
        #expect(s.count("nearMiss") == 0)
    }

    @Test func neverForOwnShotsAndOncePerShell() {
        let own = Setup()
        own.ballistics.fire(shooter: own.player, weapon: def("m4a1"), muzzle: Vec3(0, 1.6, -1), direction: FORWARD, spreadDegrees: 0)
        #expect(own.count("nearMiss") == 0)
        let shell = Setup { _, _, max in (min(max, 60), nil, nil, nil) }
        shell.ballistics.fire(shooter: shell.bot, weapon: BUCKSHOT, muzzle: botMuzzle, direction: towardPlayer, spreadDegrees: 0.5)
        #expect(shell.count("nearMiss") == 1)
    }
}

@Suite struct OtherShootersCasings {
    @Test func selfLoaderEjectsAtOnce() {
        let s = Setup()
        s.ballistics.fire(shooter: s.bot, weapon: def("m4a1"), muzzle: Vec3(0, 1.5, -30), direction: FORWARD, spreadDegrees: 0)
        #expect(s.count("casingEjected") == 1)
        if case let .casingEjected(kind, _, _) = s.log["casingEjected"]![0] { #expect(kind == "rifle") }
    }

    @Test func boltWaits() {
        let s = Setup()
        s.ballistics.fire(shooter: s.bot, weapon: def("m24"), muzzle: Vec3(0, 1.5, -30), direction: FORWARD, spreadDegrees: 0)
        #expect(s.count("casingEjected") == 0)
        s.advance(1)
        #expect(s.count("casingEjected") == 1)
    }

    @Test func playerCasingsAreTheViewModels() {
        let s = Setup()
        s.ballistics.fire(shooter: s.player, weapon: def("m4a1"), muzzle: .zero, direction: FORWARD, spreadDegrees: 0)
        s.advance(1)
        #expect(s.count("casingEjected") == 0)
    }
}
