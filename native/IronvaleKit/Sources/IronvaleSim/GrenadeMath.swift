// Ported from src/weapons/grenade-math.ts at commit 185029e. `GRENADE` comes from
// Contract/weapons.json, the private constants from Contract/sim/sim.json.
import IronvaleWorld

/// One grenade's simulation state.
public struct GrenadeBody: Sendable, Equatable {
    public var position = Vec3.zero
    public var velocity = Vec3.zero
    public var resting = false
    /// Speed into the surface of a hard bounce during the last step, m/s; 0 when there was none.
    public var impact = 0.0
    /// What the last hard bounce hit.
    public var surface = Surface.concrete

    public init(position: Vec3 = .zero, velocity: Vec3 = .zero) {
        self.position = position
        self.velocity = velocity
    }
}

public struct GrenadeMath: Sendable {
    public let g: GrenadeFigures
    public let c: SimConstants.GrenadeMath

    public init(data: SimData = .shared) {
        g = data.grenade
        c = data.constants.grenadeMath
    }

    /// Velocity of a grenade thrown while looking along `forward` (unit length).
    public func throwVelocity(_ forward: Vec3) -> Vec3 {
        Vec3(forward.x, forward.y + g.upBias, forward.z).normalized().scaled(g.throwSpeed)
    }

    /// Advance a grenade by one step: gravity, then travel, bouncing off or rolling along whatever is in the way.
    public func step(_ body: inout GrenadeBody, world: CollisionWorld, dt: Double) {
        body.impact = 0
        if body.resting { return }
        let radius = g.radius
        body.velocity.y -= g.gravity * dt

        var remaining = dt
        var contact = 0
        while contact < c.CONTACTS_PER_STEP && remaining > 1e-6 {
            defer { contact += 1 }
            let speed = body.velocity.length
            if speed < 1e-5 { return }
            let travel = speed * remaining
            let direction = body.velocity.divided(by: speed)
            guard let hit = world.raycast(origin: body.position, direction: direction, maxDistance: travel + radius * c.LOOKAHEAD_RADII) else {
                body.position = body.position.adding(direction, scaledBy: travel)
                return
            }
            let normal = hit.normal
            // How fast the centre closes on the surface per metre travelled, and how far it can go before touching.
            let closing = -direction.dot(normal)
            let gap = hit.distance * closing - radius
            if gap < 0 {
                // Already closer than its own radius (a grazing approach): push it back out.
                body.position = body.position.adding(normal, scaledBy: -gap)
            } else {
                let advance = closing > 1e-6 ? gap / closing : travel
                if advance >= travel {
                    body.position = body.position.adding(direction, scaledBy: travel)
                    return
                }
                body.position = body.position.adding(direction, scaledBy: advance)
                remaining -= advance / speed
            }

            let into = -body.velocity.dot(normal)
            if into <= 0 { continue }
            if into > g.bounceSpeed {
                // Hard bounce: split into the part along the surface and the part into it.
                body.velocity = body.velocity.adding(normal, scaledBy: into).scaled(g.friction)
                body.velocity = body.velocity.adding(normal, scaledBy: into * g.restitution)
                body.impact = max(body.impact, into)
                body.surface = hit.surface
                continue
            }
            // Rolling contact: no rebound, and friction in proportion to the push into the surface.
            body.velocity = body.velocity.adding(normal, scaledBy: into)
            let along = body.velocity.length
            let slowed = max(0, along - g.rollFriction * into)
            if normal.y > c.REST_NORMAL_Y, slowed < g.restSpeed {
                body.velocity = .zero
                body.resting = true
                return
            }
            if along > 1e-6 { body.velocity = body.velocity.scaled(slowed / along) }
        }
    }

    /// The path a grenade thrown from `origin` at `velocity` takes until it rests or the fuse runs out.
    public func predictArc(origin: Vec3, velocity: Vec3, world: CollisionWorld, capacity: Int? = nil) -> [Vec3] {
        var body = GrenadeBody(position: origin, velocity: velocity)
        let limit = min(g.maxArcPoints, capacity ?? g.maxArcPoints)
        var points: [Vec3] = []
        var time = 0.0
        while points.count < limit {
            // The web stores the arc in a Float32Array.
            points.append(Vec3(Double(Float(body.position.x)), Double(Float(body.position.y)), Double(Float(body.position.z))))
            if time >= g.fuse || body.resting { break }
            step(&body, world: world, dt: g.step)
            time += g.step
        }
        return points
    }

    /// Damage at `distance` metres from the blast with nothing in the way.
    public func blastDamage(_ distance: Double) -> Double {
        if !(distance < g.blastRadius) { return 0 }
        if distance <= g.lethalRadius {
            return g.maxDamage - (g.maxDamage - g.lethalDamage) * (max(0, distance) / g.lethalRadius)
        }
        return (g.lethalDamage * (g.blastRadius - distance)) / (g.blastRadius - g.lethalRadius)
    }

    /// Damage to a body whose chest is at `chest`: by distance, and none behind solid cover.
    public func blastDamageAt(blast: Vec3, chest: Vec3, world: CollisionWorld) -> Double {
        let from = Vec3(blast.x, blast.y + c.BLAST_LIFT, blast.z)
        let damage = blastDamage(from.distance(to: chest))
        if damage <= 0 { return 0 }
        return world.lineOfSight(from, chest) ? damage : 0
    }

    /// Strength of the view shake, 0 - 1, for a blast `distance` metres from the eye.
    public func blastShake(_ distance: Double) -> Double {
        let reach = 1 - distance / g.shakeRadius
        return reach <= 0 ? 0 : min(1, reach * reach)
    }
}

/// Hold-to-aim, release-to-throw logic for the player's grenade (src/weapons/grenade-hand.ts).
public final class GrenadeHand {
    public var count = 0
    public private(set) var aiming = false
    /// 0 with the gun up, 1 with it lowered out of the way.
    public private(set) var lowered = 0.0
    private var wasHeld = false
    private var followThrough = 0.0
    private let c: SimConstants.GrenadeHand

    public init(constants: SimConstants.GrenadeHand = SimData.shared.constants.grenadeHand) {
        c = constants
    }

    /// A new match: the grenade is back.
    public func restock() {
        count = c.GRENADES_PER_MATCH
        cancel()
        wasHeld = false
    }

    /// Stop aiming and bring the gun straight up (death, respawn). The grenade is kept.
    public func cancel() {
        aiming = false
        lowered = 0
        followThrough = 0
        // A key still down does not start a new aim until it has been let go.
        wasHeld = true
    }

    /// Advance one frame. Returns true on the frame the grenade leaves the hand.
    @discardableResult
    public func update(_ dt: Double, held: Bool, cancel: Bool, allowed: Bool) -> Bool {
        let pressed = held && !wasHeld
        wasHeld = held
        var thrown = false
        if aiming {
            if cancel || !allowed {
                aiming = false
            } else if !held {
                aiming = false
                count -= 1
                followThrough = c.FOLLOW_THROUGH_SECONDS
                thrown = true
            }
        } else if pressed, count > 0, allowed, !cancel {
            aiming = true
        }
        followThrough = max(0, followThrough - dt)
        let down = aiming || followThrough > 0
        let change = down ? dt / c.LOWER_SECONDS : -dt / c.RAISE_SECONDS
        lowered = min(1, max(0, lowered + change))
        return thrown
    }
}
