// Ported from src/characters/death.ts at commit f14381f.
import Foundation

public enum DeathVariant: String, Sendable { case back, front }

public struct DeathPlan: Sendable, Equatable {
    public let variant: DeathVariant
    public let turn: Double
}

public struct DeathFrame: Sendable, Equatable {
    public var clipTime = 0.0
    public var blend = 0.0
    public var ikWeight = 1.0
    public var turn = 0.0
    public var settled = false
    public init() {}
}

public enum Death {
    static func smooth(_ t: Double) -> Double { t * t * (3 - 2 * t) }
    static func clamp01(_ t: Double) -> Double { min(1, max(0, t)) }

    /// Which way to fall for a bullet travelling (`x`, `z`) in the soldier's frame (facing -Z).
    public static func plan(x: Double, z: Double, tables: CharacterTables = .shared) -> DeathPlan {
        let death = tables.death
        let clampTurn = { (a: Double) in min(death.maxTurn, max(-death.maxTurn, a)) }
        if (x * x + z * z).squareRoot() < 1e-4 { return DeathPlan(variant: .back, turn: 0) }
        let angle = atan2(x, z)
        if abs(angle) > .pi - death.frontCone {
            let offFront = angle > 0 ? angle - .pi : angle + .pi
            return DeathPlan(variant: .front, turn: clampTurn(offFront))
        }
        return DeathPlan(variant: .back, turn: clampTurn(angle))
    }

    public static func variant(_ variant: DeathVariant, tables: CharacterTables = .shared) -> CharacterTables.DeathVariant {
        guard let v = tables.death.variants[variant.rawValue] else { preconditionFailure("no death variant \(variant)") }
        return v
    }

    /// Where the death animation is `elapsed` seconds after the fatal hit.
    public static func frame(_ variant: DeathVariant, elapsed: Double, tables: CharacterTables = .shared) -> DeathFrame {
        let death = tables.death
        let time = max(0, elapsed)
        let v = Self.variant(variant, tables: tables)
        let end = tables.clip(v.clip).duration
        var out = DeathFrame()
        out.clipTime = min(end, v.start + time * v.rate)
        out.blend = smooth(clamp01(time / death.blendTime))
        out.ikWeight = 1 - smooth(clamp01(time / death.ikRelease))
        let turn = clamp01(time / death.turnTime)
        out.turn = 1 - (1 - turn) * (1 - turn)
        out.settled = v.start + time * v.rate >= end
        return out
    }
}

/// The rifle after its owner dies: thrown by the hit, falls, and comes to rest on its side.
public struct GunDrop: Sendable {
    private var active = false
    private var landed = false
    private var velocity = Vec3.zero
    private var spinAxis = Vec3.zero
    private var spinRate = 0.0
    private var flat = Quat.identity
    private let gravity: Double
    private let dropSpeed: Double
    private let restHeight: Double

    public init(tables: CharacterTables = .shared) {
        gravity = tables.gravity
        dropSpeed = tables.dropSpeed
        restHeight = tables.restHeight
    }

    public mutating func release(direction: Vec3) {
        active = true
        landed = false
        velocity = Vec3(direction.x * 0.9, dropSpeed, direction.z * 0.9)
        spinAxis = Vec3(0.6, 0.3, 0.7).normalizedThree
        spinRate = 5
    }

    public mutating func update(position: inout Vec3, rotation: inout Quat, dt: Double) {
        if !active { return }
        if !landed {
            velocity.y -= gravity * dt
            position += velocity * dt
            rotation = Quat.axisAngle(spinAxis, spinRate * dt) * rotation
            if position.y > restHeight { return }
            position.y = restHeight
            landed = true
            let forward = rotation.rotate(Vec3(0, 0, -1))
            let yaw = atan2(-forward.x, -forward.z)
            flat = Quat.axisAngle(Vec3(0, 1, 0), yaw) * Quat.axisAngle(Vec3(0, 0, 1), .pi / 2)
            return
        }
        if rotation.angle(to: flat) < 1e-3 {
            active = false
            return
        }
        rotation = rotation.slerp(flat, min(1, dt * 16))
        position.x += velocity.x * dt * 0.3
        position.z += velocity.z * dt * 0.3
        velocity *= exp(-dt * 8)
    }

    public mutating func reset() {
        active = false
        landed = false
    }
}
