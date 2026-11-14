// Ported from tests/weapons/grenade-math.test.ts, grenade-hand.test.ts and grenades.test.ts at
// commit 185029e, on the same worlds (exported by sim-fixtures), plus the stepGrenade trajectories
// recorded from the TypeScript.
import Foundation
@testable import IronvaleSim
import IronvaleWorld
import Testing

private let math = GrenadeMath()
private let G = simData.grenade
private let STEP = G.step

@Suite struct GrenadeMathTests {
    let world: CollisionWorld

    init() throws { world = try testWorld("grenadeMath") }

    private func run(_ body: inout GrenadeBody, _ seconds: Double = G.fuse) -> (first: Vec3?, lowest: Double, bounces: Int) {
        var first: Vec3?
        var lowest = Double.infinity
        var bounces = 0
        var t = 0.0
        while t < seconds, !body.resting {
            math.step(&body, world: world, dt: STEP)
            if body.impact > 0 {
                bounces += 1
                if first == nil { first = body.position }
            }
            lowest = min(lowest, body.position.y)
            t += STEP
        }
        return (first, lowest, bounces)
    }

    @Test func throwVelocity() {
        let v = math.throwVelocity(Vec3(0, 0, -1))
        #expect(approx(v.length, G.throwSpeed, 5))
        let angle = atan2(v.y, -v.z) * (180 / Double.pi)
        #expect(angle > 6 && angle < 15)
        #expect(approx(v.x, 0, 6))
        let up = math.throwVelocity(Vec3(0, 0.7071, -0.7071))
        #expect(up.y > v.y + 5)
        #expect(math.throwVelocity(Vec3(1, 0, 0)).x > 15)
    }

    @Test func ballisticInFreeFlight() {
        let origin = Vec3(40, 30, 40), velocity = Vec3(6, 4, -3)
        var body = GrenadeBody(position: origin, velocity: velocity)
        for _ in 0 ..< Int((1 / STEP).rounded()) { math.step(&body, world: world, dt: STEP) }
        #expect(approx(body.position.x, origin.x + velocity.x, 3))
        #expect(approx(body.position.z, origin.z + velocity.z, 3))
        #expect(abs(body.position.y - (origin.y + velocity.y - 0.5 * G.gravity)) < 0.12)
        #expect(body.impact == 0)
    }

    @Test func levelThrowLandsAbout15mOut() {
        var body = GrenadeBody(position: Vec3(20, 1.45, 40), velocity: math.throwVelocity(Vec3(1, 0, 0)))
        let (first, lowest, bounces) = run(&body)
        let landed = first!.x - 20
        #expect(landed > 13 && landed < 18)
        #expect(bounces >= 2)
        #expect(body.resting)
        let rest = body.position.x - 20
        #expect(rest > landed && rest < 22)
        #expect(lowest > 0)
        #expect(approx(body.position.y, G.radius, 1))
    }

    @Test func losesHeightOnEachBounce() {
        var body = GrenadeBody(position: Vec3(40, 2, 40))
        var peak = 0.0
        var bounced = false
        var t = 0.0
        while t < 1.5 {
            math.step(&body, world: world, dt: STEP)
            t += STEP
            if body.impact > 0, !bounced {
                bounced = true
                #expect(body.surface == .concrete)
                #expect(body.impact > 5)
            } else if bounced, body.impact > 0 { break }
            if bounced { peak = max(peak, body.position.y) }
        }
        #expect(bounced)
        #expect(peak > 0.1 && peak < 0.7)
    }

    @Test func bouncesOffAWall() {
        var body = GrenadeBody(position: Vec3(0, 1.5, 0), velocity: Vec3(0, 2, -14))
        var hitWall = false
        var t = 0.0
        while t < G.fuse, !body.resting {
            math.step(&body, world: world, dt: STEP)
            if body.impact > 0, body.surface == .metal {
                hitWall = true
                #expect(body.velocity.z > 0)
            }
            #expect(body.position.z > -4.8)
            t += STEP
        }
        #expect(hitWall)
    }

    @Test func nothingAtRest() {
        var body = GrenadeBody(position: Vec3(40, G.radius, 40))
        body.resting = true
        math.step(&body, world: world, dt: STEP)
        #expect(body.position.y == G.radius)
    }

    @Test func arcEndsWhereTheGrenadeEnds() {
        let origin = Vec3(0, 1.45, 3)
        let velocity = math.throwVelocity(Vec3(0.2, 0.1, -1).normalized())
        let points = math.predictArc(origin: origin, velocity: velocity, world: world)
        #expect(points.count > 10 && points.count <= G.maxArcPoints)
        var body = GrenadeBody(position: origin, velocity: velocity)
        _ = run(&body)
        let last = points[points.count - 1]
        #expect(approx(last.x, body.position.x, 5))
        #expect(approx(last.y, body.position.y, 5))
        #expect(approx(last.z, body.position.z, 5))
        #expect(points[0].x == origin.x)
    }

    @Test func blast() {
        #expect(math.blastDamage(0) >= 100)
        #expect(math.blastDamage(G.lethalRadius) >= 100)
        #expect(math.blastDamage(G.lethalRadius + 0.5) < 100)
        #expect(math.blastDamage(G.blastRadius) == 0)
        #expect(math.blastDamage(50) == 0)
        var previous = Double.infinity
        for d in stride(from: 0.0, through: 9, by: 0.25) {
            #expect(math.blastDamage(d) <= previous)
            previous = math.blastDamage(d)
        }
        #expect(math.blastDamage(5.5) > 20 && math.blastDamage(5.5) < 80)
        let blast = Vec3(0, 0.1, -4)
        #expect(math.blastDamageAt(blast: blast, chest: Vec3(2, 1.2, -4), world: world) >= 100)
        #expect(math.blastDamageAt(blast: blast, chest: Vec3(0, 1.2, -6), world: world) == 0)
        #expect(math.blastDamageAt(blast: Vec3(7, 0.1, -4), chest: Vec3(7, 1.2, -6.5), world: world) > 0)
        #expect(math.blastDamageAt(blast: blast, chest: Vec3(0, 1.2, 6), world: world) == 0)
        #expect(math.blastShake(2) > math.blastShake(10))
        #expect(math.blastShake(10) > 0)
        #expect(math.blastShake(G.shakeRadius) == 0)
        #expect(math.blastShake(0) <= 1)
    }

    @Test func blastCurveMatchesTypeScriptExactly() throws {
        let root = try fixture("weapons.json") as! [String: Any]
        for pair in root["blast"] as! [[Any]] {
            #expect(math.blastDamage(double(pair[0])) == double(pair[1]), "\(pair)")
        }
    }

    @Test func trajectoriesMatchTypeScript() throws {
        let root = try fixture("weapons.json") as! [String: Any]
        var maxError = 0.0
        for launch in root["grenade"] as! [[String: Any]] {
            var body = GrenadeBody(position: Vec3(doubles(launch["origin"])), velocity: Vec3(doubles(launch["velocity"])))
            for (i, raw) in (launch["steps"] as! [[Any]]).enumerated() {
                math.step(&body, world: world, dt: STEP)
                let r = raw.map(double)
                let error = max(abs(body.position.x - r[0]), abs(body.position.y - r[1]), abs(body.position.z - r[2]))
                maxError = max(maxError, error)
                #expect(error < 1e-6, "step \(i) of \(launch["origin"]!)")
                #expect((body.resting ? 1.0 : 0) == r[6])
                #expect(abs(body.impact - r[7]) < 1e-6)
                #expect(Double(body.surface.rawValue) == r[8])
            }
        }
        print("grenade trajectories: max position error \(maxError) m")
    }
}

@Suite struct GrenadeHandTests {
    let DT = 1.0 / 60

    @Test func restockAndThrow() {
        let hand = GrenadeHand()
        #expect(hand.count == 0)
        hand.restock()
        #expect(hand.count == 1)
        #expect(!hand.update(DT, held: true, cancel: false, allowed: true))
        #expect(hand.aiming)
        for _ in 0 ..< 30 { #expect(!hand.update(DT, held: true, cancel: false, allowed: true)) }
        #expect(hand.count == 1)
        #expect(approx(hand.lowered, 1, 5))
        #expect(hand.update(DT, held: false, cancel: false, allowed: true))
        #expect(!hand.aiming)
        #expect(hand.count == 0)
    }

    @Test func onlyOne() {
        let hand = GrenadeHand()
        hand.restock()
        hand.update(DT, held: true, cancel: false, allowed: true)
        #expect(hand.update(DT, held: false, cancel: false, allowed: true))
        #expect(!hand.update(DT, held: true, cancel: false, allowed: true))
        #expect(!hand.aiming)
        #expect(!hand.update(DT, held: false, cancel: false, allowed: true))
        #expect(hand.count == 0)
    }

    @Test func cancelNeedsAFreshPress() {
        let hand = GrenadeHand()
        hand.restock()
        hand.update(DT, held: true, cancel: false, allowed: true)
        #expect(!hand.update(DT, held: true, cancel: true, allowed: true))
        #expect(!hand.aiming)
        #expect(hand.count == 1)
        #expect(!hand.update(DT, held: true, cancel: false, allowed: true))
        #expect(!hand.aiming)
        #expect(!hand.update(DT, held: false, cancel: false, allowed: true))
        #expect(hand.count == 1)
        hand.update(DT, held: true, cancel: false, allowed: true)
        #expect(hand.aiming)
    }

    @Test func busyHands() {
        let hand = GrenadeHand()
        hand.restock()
        hand.update(DT, held: true, cancel: false, allowed: false)
        #expect(!hand.aiming)
        hand.update(DT, held: false, cancel: false, allowed: true)
        hand.update(DT, held: true, cancel: false, allowed: true)
        #expect(hand.aiming)
        hand.update(DT, held: true, cancel: false, allowed: false)
        #expect(!hand.aiming)
        #expect(hand.count == 1)
    }

    @Test func followThroughThenRaise() {
        let hand = GrenadeHand()
        hand.restock()
        for _ in 0 ..< 30 { hand.update(DT, held: true, cancel: false, allowed: true) }
        hand.update(DT, held: false, cancel: false, allowed: true)
        #expect(hand.lowered > 0.5)
        for _ in 0 ..< 90 { hand.update(DT, held: false, cancel: false, allowed: true) }
        #expect(hand.lowered == 0)
    }

    @Test func onlyARestockRefills() {
        let hand = GrenadeHand()
        hand.restock()
        hand.update(DT, held: true, cancel: false, allowed: true)
        hand.update(DT, held: false, cancel: false, allowed: true)
        hand.cancel()
        #expect(hand.count == 0)
        hand.restock()
        #expect(hand.count == 1)
        hand.update(DT, held: true, cancel: false, allowed: true)
        hand.cancel()
        #expect(!hand.aiming)
        #expect(hand.lowered == 0)
        #expect(hand.count == 1)
    }
}

/// A combatant that records damage, as the `Dummy` in grenades.test.ts.
final class Dummy: Combatant {
    let id: Int
    let kind: CombatantKind
    let team: Team
    let name: String
    var position: Vec3
    let velocity = Vec3.zero
    let crouching = false
    var alive = true
    var health = 100.0
    var damage: [DamageInfo] = []
    let eyeHeight: Double
    private let events: EventBus?

    init(id: Int, kind: CombatantKind, team: Team, name: String, x: Double, z: Double, eyeHeight: Double = 1.6, events: EventBus? = nil) {
        self.id = id
        self.kind = kind
        self.team = team
        self.name = name
        position = Vec3(x, 0, z)
        self.eyeHeight = eyeHeight
        self.events = events
    }

    func eyePosition() -> Vec3 { Vec3(position.x, eyeHeight, position.z) }
    func hitTest(origin _: Vec3, direction _: Vec3, maxDistance _: Double) -> CombatantHit? { nil }

    func applyDamage(_ info: DamageInfo) {
        if !alive { return }
        damage.append(info)
        health = max(0, health - info.amount)
        if health > 0 { return }
        alive = false
        events?.emit(.died(victimId: id, killerId: info.attackerId, weaponId: info.weaponId, headshot: false))
    }
}

private final class GrenadeRig {
    let events = EventBus()
    let combat: Combat
    let player: Dummy
    let grenades: GrenadeSystem
    var log: [String] = []
    var deaths: [(Int, Int, String)] = []
    var hits: [(Int, Bool, String)] = []
    var blast: Vec3?

    init(world: CollisionWorld) {
        combat = Combat { world }
        player = Dummy(id: combat.allocateId(), kind: .local, team: .alpha, name: "You", x: 0, z: 20, events: events)
        combat.add(player)
        let player = player
        grenades = GrenadeSystem(events: events, combat: combat, world: { world }, localId: { player.id })
        events.on { [unowned self] event in
            switch event {
            case let .grenadeThrown(_, _, _, local): log.append("thrown:\(local)")
            case .grenadeBounced: log.append("bounce")
            case let .grenadeExploded(_, position, local):
                log.append("exploded:\(local)")
                blast = position
            case let .died(victim, killer, weapon, _): deaths.append((victim, killer, weapon))
            case let .combatantHit(weapon, target, _, _, _, fatal): hits.append((target, fatal, weapon))
            default: break
            }
        }
    }

    func add(_ kind: CombatantKind, _ team: Team, _ name: String, _ x: Double, _ z: Double) -> Dummy {
        let dummy = Dummy(id: combat.allocateId(), kind: kind, team: team, name: name, x: x, z: z, events: events)
        combat.add(dummy)
        return dummy
    }

    func run(_ seconds: Double) {
        var t = 0.0
        while t < seconds {
            grenades.update(1.0 / 60)
            t += 1.0 / 60
        }
    }

    func place(_ owner: any Combatant, _ x: Double, _ z: Double, authoritative: Bool = true) {
        grenades.launch(owner: owner, origin: Vec3(x, G.radius + 0.01, z), velocity: .zero, authoritative: authoritative)
    }

    var exploded: Bool { log.contains { $0.hasPrefix("exploded") } }
}

@Suite struct GrenadeSystemTests {
    let world: CollisionWorld
    let grenadeId = simData.contract.weapons.grenadeId

    init() throws { world = try testWorld("grenades") }

    @Test func fliesBouncesAndGoesOffOnTime() {
        let rig = GrenadeRig(world: world)
        rig.grenades.launch(owner: rig.player, origin: Vec3(20, 1.5, 20), velocity: Vec3(12, 3, 0), authoritative: true)
        #expect(rig.log == ["thrown:true"])
        rig.run(G.fuse - 0.1)
        #expect(rig.log.filter { $0 == "bounce" }.count >= 1)
        #expect(!rig.exploded)
        #expect(rig.grenades.flights.filter(\.active).count == 1)
        rig.run(0.2)
        #expect(rig.log.last == "exploded:true")
        #expect(!rig.grenades.flights.contains { $0.active })
        #expect(rig.blast!.x > 28)
    }

    @Test func killsInsideTheLethalRadius() {
        let rig = GrenadeRig(world: world)
        let near = rig.add(.bot, .bravo, "Near", 2, 0)
        let mid = rig.add(.bot, .bravo, "Mid", 5.5, 0)
        let far = rig.add(.bot, .bravo, "Far", 12, 0)
        rig.place(rig.player, 0, 0)
        rig.run(G.fuse + 0.1)
        #expect(!near.alive)
        #expect(near.damage.first?.attackerId == rig.player.id)
        #expect(near.damage.first?.weaponId == grenadeId)
        #expect(near.damage.first?.zone == .torso)
        #expect(rig.deaths.count == 1 && rig.deaths[0] == (near.id, rig.player.id, grenadeId))
        #expect(mid.alive && mid.health < 100 && mid.health > 0)
        #expect(far.damage.isEmpty)
        #expect(rig.hits.map(\.0) == [near.id, mid.id])
        #expect(rig.hits.map(\.1) == [true, false])
        #expect(rig.hits.allSatisfy { $0.2 == grenadeId })
    }

    @Test func pushesTheVictimAway() {
        let rig = GrenadeRig(world: world)
        let bot = rig.add(.bot, .bravo, "East", 2, 0)
        rig.place(rig.player, 0, 0)
        rig.run(G.fuse + 0.1)
        #expect(bot.damage[0].direction.x > 0.5)
        #expect(approx(bot.damage[0].direction.length, 1, 5))
    }

    @Test func blockedByAWall() {
        let rig = GrenadeRig(world: world)
        let open = rig.add(.bot, .bravo, "Open", 1.5, -3.5)
        let covered = rig.add(.bot, .bravo, "Covered", 0, -6.2)
        rig.place(rig.player, 0, -4)
        rig.run(G.fuse + 0.1)
        #expect(!open.alive)
        #expect(covered.damage.isEmpty && covered.health == 100)
    }

    @Test func hurtsTheThrowerWithNoHitMarker() {
        let rig = GrenadeRig(world: world)
        rig.place(rig.player, rig.player.position.x + 1, rig.player.position.z)
        rig.run(G.fuse + 0.1)
        #expect(!rig.player.alive)
        #expect(rig.deaths.count == 1 && rig.deaths[0] == (rig.player.id, rig.player.id, grenadeId))
        #expect(rig.hits.isEmpty)
    }

    @Test func sparesTheThrowersSide() {
        let rig = GrenadeRig(world: world)
        let friend = rig.add(.remote, .alpha, "Friend", 1.5, 0)
        let enemy = rig.add(.bot, .bravo, "Enemy", -1.5, 0)
        rig.place(rig.player, 0, 0)
        rig.run(G.fuse + 0.1)
        #expect(friend.damage.isEmpty)
        #expect(!enemy.alive)
    }

    @Test func showsThePeersGrenadeWithoutDamage() {
        let rig = GrenadeRig(world: world)
        let peer = rig.add(.remote, .bravo, "Peer", 3, 0)
        rig.place(peer, 2, 0, authoritative: false)
        #expect(rig.log == ["thrown:false"])
        rig.run(G.fuse + 0.5)
        #expect(!rig.exploded)
        rig.grenades.detonate(ownerId: peer.id, position: Vec3(2.3, 0.05, 0.2))
        #expect(rig.log.last == "exploded:false")
        #expect(approx(rig.blast!.x, 2.3, 5))
        #expect(rig.player.damage.isEmpty && peer.damage.isEmpty)
        rig.grenades.detonate(ownerId: peer.id, position: Vec3(2.3, 0.05, 0.2))
        #expect(rig.log.filter { $0.hasPrefix("exploded") }.count == 1)
    }

    @Test func shownGrenadeGoesOffByItself() {
        let rig = GrenadeRig(world: world)
        let peer = rig.add(.remote, .bravo, "Peer", 3, 0)
        let bystander = rig.add(.bot, .alpha, "Bystander", 2.5, 0)
        rig.place(peer, 2, 0, authoritative: false)
        rig.run(G.fuse + 2)
        #expect(rig.log.last == "exploded:false")
        #expect(bystander.damage.isEmpty)
    }

    @Test func ignoresAFarBlastPosition() {
        let rig = GrenadeRig(world: world)
        let peer = rig.add(.remote, .bravo, "Peer", 3, 0)
        rig.place(peer, 2, 0, authoritative: false)
        rig.run(1)
        rig.grenades.detonate(ownerId: peer.id, position: Vec3(60, 0, 60))
        #expect(approx(rig.blast!.x, 2, 1))
    }

    @Test func clearRemovesFlights() {
        let rig = GrenadeRig(world: world)
        let bot = rig.add(.bot, .bravo, "Near", 1, 0)
        rig.place(rig.player, 0, 0)
        rig.run(1)
        rig.grenades.clear()
        rig.run(3)
        #expect(!rig.exploded)
        #expect(bot.damage.isEmpty)
    }
}
