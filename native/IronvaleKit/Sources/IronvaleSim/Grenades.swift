// Ported from src/weapons/grenades.ts and src/weapons/grenade-throw.ts at commit 185029e.
// The owner's flight is authoritative and applies the blast; the peer flies a cosmetic copy.
import IronvaleWorld

public struct GrenadeFlight: Sendable {
    public internal(set) var active = false
    public internal(set) var ownerId = -1
    public internal(set) var team = Team.alpha
    public internal(set) var authoritative = false
    public internal(set) var fuse = 0.0
    var sinceBounce = 0.0
    public internal(set) var body = GrenadeBody()
    var previous = Vec3.zero
    /// Where to draw it this frame, between the last two fixed steps.
    public internal(set) var drawPosition = Vec3.zero
}

/// Flies thrown grenades through the collision world and, for the ones this machine owns, applies the blast.
public final class GrenadeSystem {
    public private(set) var flights: [GrenadeFlight]
    private var accumulator = 0.0
    private let events: EventBus
    private let combat: Combat
    private let world: () -> CollisionWorld?
    private let localId: () -> Int
    private let math: GrenadeMath
    private let c: SimConstants.Grenades
    private let grenadeId: String

    public init(events: EventBus, combat: Combat, world: @escaping () -> CollisionWorld?, localId: @escaping () -> Int, data: SimData = .shared) {
        self.events = events
        self.combat = combat
        self.world = world
        self.localId = localId
        math = GrenadeMath(data: data)
        c = data.constants.grenades
        grenadeId = data.contract.weapons.grenadeId
        flights = Array(repeating: GrenadeFlight(), count: c.POOL_SIZE)
    }

    public func launch(owner: any Combatant, origin: Vec3, velocity: Vec3, authoritative: Bool) {
        guard let index = flights.firstIndex(where: { !$0.active }) else { return }
        var flight = GrenadeFlight()
        flight.active = true
        flight.ownerId = owner.id
        flight.team = owner.team
        flight.authoritative = authoritative
        flight.fuse = math.g.fuse
        flight.sinceBounce = c.BOUNCE_GAP_SECONDS
        flight.body = GrenadeBody(position: origin, velocity: velocity)
        flight.previous = origin
        flight.drawPosition = origin
        flights[index] = flight
        events.emit(.grenadeThrown(ownerId: owner.id, position: origin, velocity: velocity, local: owner.id == localId()))
    }

    /// The other machine says its grenade went off at `position`.
    public func detonate(ownerId: Int, position: Vec3) {
        for index in flights.indices {
            let flight = flights[index]
            if !flight.active || flight.authoritative || flight.ownerId != ownerId { continue }
            let shown = flight.body.position
            explode(index, at: shown.distance(to: position) <= c.DETONATE_TOLERANCE ? position : shown)
            return
        }
    }

    public func clear() {
        for index in flights.indices { flights[index].active = false }
        accumulator = 0
    }

    public func update(_ dt: Double) {
        let step = math.g.step
        accumulator = min(accumulator + dt, step * Double(c.MAX_STEPS_PER_FRAME))
        while accumulator >= step {
            accumulator -= step
            for index in flights.indices where flights[index].active { self.step(index, step) }
        }
        let blend = accumulator / step
        for index in flights.indices where flights[index].active {
            flights[index].drawPosition = Vec3.lerp(flights[index].previous, flights[index].body.position, blend)
        }
    }

    private func step(_ index: Int, _ dt: Double) {
        guard let world = world() else { return }
        var flight = flights[index]
        flight.previous = flight.body.position
        math.step(&flight.body, world: world, dt: dt)
        flight.sinceBounce += dt
        let bounced = flight.body.impact > 0 && flight.sinceBounce >= c.BOUNCE_GAP_SECONDS
        if bounced { flight.sinceBounce = 0 }
        flight.fuse -= dt
        flights[index] = flight
        if bounced {
            events.emit(.grenadeBounced(ownerId: flight.ownerId, position: flight.body.position, speed: flight.body.impact, surface: flight.body.surface))
        }
        if flight.fuse > (flight.authoritative ? 0 : -c.DETONATE_GRACE_SECONDS) { return }
        explode(index, at: flight.body.position)
    }

    private func explode(_ index: Int, at blast: Vec3) {
        let flight = flights[index]
        flights[index].active = false
        events.emit(.grenadeExploded(ownerId: flight.ownerId, position: blast, local: flight.ownerId == localId()))
        guard flight.authoritative, let world = world() else { return }
        for combatant in combat.all() {
            // It hurts whoever threw it, and the other side. Like bullets, it spares the thrower's own side.
            if !combatant.alive || (combatant.id != flight.ownerId && combatant.team == flight.team) { continue }
            let chest = chestOf(combatant)
            let amount = math.blastDamageAt(blast: blast, chest: chest, world: world)
            if amount <= 0 { continue }
            var direction = chest - blast
            let distance = direction.length
            direction = distance > 1e-4 ? direction.divided(by: distance) : Vec3(0, 1, 0)
            combatant.applyDamage(DamageInfo(amount: amount, zone: .torso, attackerId: flight.ownerId,
                                             weaponId: grenadeId, point: chest, direction: direction))
            if combatant.id == flight.ownerId { continue }
            events.emit(.combatantHit(weapon: grenadeId, targetId: combatant.id, attackerId: flight.ownerId,
                                      hit: CombatantHit(distance: distance, zone: .torso, point: chest),
                                      direction: direction, fatal: !combatant.alive))
        }
    }

    private func chestOf(_ combatant: any Combatant) -> Vec3 {
        let feet = combatant.position
        let eye = combatant.eyePosition()
        return Vec3(feet.x, feet.y + (eye.y - feet.y) * c.CHEST_SHARE, feet.z)
    }
}

/// The local player's grenade: hold to aim, release to throw, from where the camera looks.
public final class GrenadeThrow {
    public let hand: GrenadeHand
    public private(set) var origin = Vec3.zero
    public private(set) var velocity = Vec3.zero
    private let math: GrenadeMath
    private let handOffset: Vec3

    public init(data: SimData = .shared) {
        hand = GrenadeHand(constants: data.constants.grenadeHand)
        math = GrenadeMath(data: data)
        handOffset = Vec3(data.constants.grenadeThrow.HAND_OFFSET)
    }

    public var count: Int { hand.count }
    public var aiming: Bool { hand.aiming }
    public var lowered: Double { hand.lowered }
    public func restock() { hand.restock() }
    public func cancel() { hand.cancel() }

    /// Returns true on the frame the grenade leaves the hand; `origin` and `velocity` then hold the throw.
    public func update(_ dt: Double, held: Bool, cancel: Bool, allowed: Bool, camera: SimCamera, world: CollisionWorld?) -> Bool {
        let thrown = hand.update(dt, held: held, cancel: cancel, allowed: allowed)
        if !thrown, !hand.aiming { return false }
        line(camera: camera, world: world)
        return thrown
    }

    /// Work out the throw from where the camera is looking now.
    private func line(camera: SimCamera, world: CollisionWorld?) {
        let eye = camera.position
        velocity = math.throwVelocity(camera.direction)
        let reach = camera.rotate(handOffset)
        let length = reach.length
        let along = reach.divided(by: length)
        // Standing against a wall, the hand would be inside it: throw from the eye instead.
        let blocked = world?.raycast(origin: eye, direction: along, maxDistance: length + math.g.radius * 2) != nil
        origin = blocked ? eye : eye.adding(along, scaledBy: length)
    }
}
