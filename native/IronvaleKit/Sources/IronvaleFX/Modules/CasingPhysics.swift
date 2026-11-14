// Ported from src/fx/casing-physics.ts at commit a487033.
import Darwin
import IronvaleWorld

public struct CasingTuning: Sendable {
    public var gravity: Double
    public var restitution: Double
    public var friction: Double
    public var maxBounces: Int
    public var restSpeed: Double

    public static let standard = CasingTuning(gravity: 9.81, restitution: 0.38, friction: 0.45, maxBounces: 2, restSpeed: 0.55)
}

/// Simulation state for one casing.
public struct CasingBody: Sendable {
    public var position = D3.zero
    public var velocity = D3.zero
    public var bounces = 0
    public var landed = false
    public var resting = false
    public var surface: Surface?

    public init() {}
}

public enum CasingStep: String, Sendable { case flying, bounced, landed, rested, resting }

public enum CasingPhysics {
    static let groundNormalY = 0.5

    /// Bounce a velocity off a surface (reflectVelocity).
    public static func reflect(_ velocity: D3, _ normal: D3, _ restitution: Double, _ friction: Double) -> D3 {
        let into = velocity.dot(normal)
        if into >= 0 { return velocity }
        let keep = 1 - friction
        return (velocity * keep).adding(normal, -into * (keep + restitution))
    }

    /// Advance one casing by `dt`, sweeping a ray along the frame's motion.
    public static func step(_ body: inout CasingBody, _ dt: Double, world: CollisionWorld?, radius: Double, tuning: CasingTuning) -> CasingStep {
        if body.resting { return .resting }
        body.velocity.y -= tuning.gravity * dt
        let speed = body.velocity.length
        let travel = speed * dt
        if travel < 1e-6 { return .flying }
        let direction = body.velocity * (1 / speed)
        guard let hit = world?.raycast(origin: body.position.vec3, direction: direction.vec3, maxDistance: travel + radius) else {
            body.position = body.position.adding(body.velocity, dt)
            return .flying
        }
        let normal = D3(hit.normal)
        body.position = D3(hit.point).adding(normal, radius)
        body.surface = hit.surface
        body.velocity = reflect(body.velocity, normal, tuning.restitution, tuning.friction)
        if normal.y < groundNormalY { return .bounced }
        let firstContact = !body.landed
        body.landed = true
        let rebound = body.velocity.dot(normal)
        if body.bounces >= tuning.maxBounces || rebound < tuning.restSpeed {
            body.resting = true
            body.velocity = .zero
            return firstContact ? .landed : .rested
        }
        body.bounces += 1
        return firstContact ? .landed : .bounced
    }
}
