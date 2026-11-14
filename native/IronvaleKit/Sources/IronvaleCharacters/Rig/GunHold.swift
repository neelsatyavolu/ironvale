// Ported from src/characters/gun-hold.ts at commit f14381f. Places the rifle from the right
// shoulder and the aim, in the soldier's model space, and gives both hand targets.
import Foundation

public struct HoldInput: Sendable {
    public var aim = 0.0
    public var carry = 0.0
    public var pitch = 0.0
    public var recoil = 0.0
    public var recoilSide = 0.0
    public var reload = -1.0
    public var swayPitch = 0.0
    public var swayYaw = 0.0
    public init() {}
}

public struct GunHold: Sendable {
    struct HoldPose {
        let butt: Vec3
        let pitch: Double
        let yaw: Double
        let roll: Double
        let follow: Double
    }

    // gun-hold.ts AIMED, READY and CARRY (THREE.Vector3 literals, so ported here).
    static let aimed = HoldPose(butt: Vec3(-0.085, 0.06, -0.1), pitch: 0, yaw: 0, roll: 0, follow: 1)
    static let ready = HoldPose(butt: Vec3(-0.05, -0.06, -0.1), pitch: -0.62, yaw: 0.42, roll: 0.18, follow: 0.35)
    static let carry = HoldPose(butt: Vec3(0.04, -0.3, -0.14), pitch: 0.6, yaw: 1.0, roll: 0.4, follow: 0)

    public private(set) var position = Vec3.zero
    public private(set) var quaternion = Quat.identity
    public private(set) var triggerPosition = Vec3.zero
    public private(set) var triggerRotation = Quat.identity
    public private(set) var supportPosition = Vec3.zero
    public private(set) var supportRotation = Quat.identity

    let butt: Vec3
    let trigger: Vec3
    let support: Vec3
    let magazine: Vec3
    let sight: CharacterTables.Sight
    let triggerLocal: Quat
    let supportLocal: Quat
    let magazineLocal: Quat

    public init(tables: CharacterTables = .shared) {
        let c = tables.carbine
        butt = c.butt.vec3
        trigger = c.trigger.position.vec3
        support = c.support.position.vec3
        magazine = c.magazine.position.vec3
        sight = tables.sight
        triggerLocal = Self.gripRotation(c.trigger.fingers.vec3, c.trigger.thumb.vec3)
        supportLocal = Self.gripRotation(c.support.fingers.vec3, c.support.thumb.vec3)
        magazineLocal = Self.gripRotation(c.magazine.fingers.vec3, c.magazine.thumb.vec3)
    }

    static func holdRotation(_ pose: HoldPose, _ pitch: Double) -> Quat {
        Quat.eulerYXZ(pose.pitch + pitch * pose.follow, pose.yaw, pose.roll)
    }

    static func gripRotation(_ fingers: Vec3, _ thumb: Vec3) -> Quat {
        let z = -fingers.normalizedThree
        let y = (thumb + z * -thumb.dot(z)).normalizedThree
        let x = y.cross(z)
        return ArmIK.quatFromBasis(x, y)
    }

    static func smooth(_ t: Double) -> Double { t * t * (3 - 2 * t) }

    /// Places the gun for the right shoulder joint at `shoulder`; with `eye`, slides the
    /// shouldered rifle to put its sights in front of the eye.
    public mutating func update(shoulder: Vec3, input: HoldInput, eye: Vec3? = nil) {
        let aim = Self.smooth(input.aim)
        let carry = Self.smooth(input.carry)
        var q = Self.holdRotation(Self.ready, input.pitch)
        q = q.slerp(Self.holdRotation(Self.aimed, input.pitch), aim)
        q = q.slerp(Self.holdRotation(Self.carry, input.pitch), carry)
        let offset = Self.ready.butt.lerp(Self.aimed.butt, aim).lerp(Self.carry.butt, carry)

        let reloading = input.reload >= 0
        let tilt = reloading ? Self.smooth(min(1, input.reload / 0.15, (1 - input.reload) / 0.15)) : 0
        q = q * Quat.eulerYXZ(input.swayPitch + input.recoil * 0.05 + tilt * 0.35,
                              input.swayYaw + input.recoilSide * input.recoil * 0.02, tilt * 0.45)
        var p = shoulder + offset
        p = p - q.rotate(butt)
        p = p + q.rotate(Vec3(0, 0, input.recoil * 0.03))

        let sighting = aim * (1 - carry)
        if let eye, sighting > 0 {
            let local = q.inverse.rotate(eye - p)
            let raise = min(sight.maxRaise, max(-sight.maxRaise, local.y - sight.height))
            let shift = min(sight.maxShift, max(-sight.maxShift, local.x))
            p = p + q.rotate(Vec3(shift * sighting, raise * sighting, 0))
        }
        position = p
        quaternion = q
        triggerPosition = q.rotate(trigger) + p
        triggerRotation = q * triggerLocal

        var supportPoint = support
        var frame = supportLocal
        if reloading {
            let reach = Self.smooth(min(1, input.reload / 0.2, (1 - input.reload) / 0.2))
            let stroke = sin(min(1, max(0, (input.reload - 0.25) / 0.5)) * .pi)
            var local = magazine
            local.y -= stroke * 0.16
            local.x -= stroke * 0.05
            supportPoint = supportPoint.lerp(local, reach)
            frame = frame.slerp(magazineLocal, reach)
        }
        supportPosition = q.rotate(supportPoint) + p
        supportRotation = q * frame
    }
}
