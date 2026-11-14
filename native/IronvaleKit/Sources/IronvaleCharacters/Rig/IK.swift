// Ported from src/characters/ik.ts at commit f14381f. Two-bone arm IK in the soldier's model space.
import Foundation

public struct JointRest: Sendable {
    public let q: Quat
    public let p: Vec3
    public init(q: Quat, p: Vec3) { self.q = q; self.p = p }
}

public enum ArmSide: String, Sendable { case left, right }

public struct ArmRest: Sendable {
    public let side: ArmSide
    public let upper: JointRest
    public let lower: JointRest
    public let hand: JointRest
    public let fingers: Vec3
    public let thumb: Vec3
    public init(side: ArmSide, upper: JointRest, lower: JointRest, hand: JointRest, fingers: Vec3, thumb: Vec3) {
        self.side = side; self.upper = upper; self.lower = lower; self.hand = hand; self.fingers = fingers; self.thumb = thumb
    }
}

public struct ArmSetup: Sendable {
    public let upperLength: Double
    public let lowerLength: Double
    public let upperOffset: Quat
    public let lowerOffset: Quat
    public let handOffset: Quat
    public let palmLocal: Vec3
    public let lowerAxis: Vec3
    public let handRest: Quat
    let twistShare: Double
    let maxReach: Double
}

public struct ArmSolution: Sendable {
    public var upper = Quat.identity
    public var lower = Quat.identity
    public var hand = Quat.identity
    public var elbow = Vec3.zero
    public var wrist = Vec3.zero
    public init() {}
}

public enum ArmIK {
    /// Rotation whose X axis is `x` and whose Y axis is `y` made perpendicular to it.
    public static func quatFromBasis(_ x: Vec3, _ y: Vec3) -> Quat {
        let bx = x.normalizedThree
        let bz = bx.cross(y).normalizedThree
        let by = bz.cross(bx)
        return Quat.fromBasis(bx, by, bz)
    }

    public static func calibrate(_ rest: ArmRest, tables: CharacterTables = .shared) -> ArmSetup {
        let upperDir = rest.lower.p - rest.upper.p
        let lowerDir = rest.hand.p - rest.lower.p
        let hinge = upperDir.cross(Vec3(0, 0, -1)).normalizedThree
        let upperFrame = quatFromBasis(upperDir, hinge)
        let lowerFrame = quatFromBasis(lowerDir, hinge)

        let fingers = (rest.fingers - rest.hand.p).normalizedThree
        var thumb = rest.thumb - rest.hand.p
        thumb = (thumb + fingers * -thumb.dot(fingers)).normalizedThree
        let gripZ = -fingers
        let gripX = thumb.cross(gripZ)
        let gripRest = quatFromBasis(gripX, thumb)
        let palmNormal = gripX * (rest.side == .right ? -1 : 1)
        let palm = fingers * tables.palmForward + palmNormal * tables.palmDepth
        return ArmSetup(
            upperLength: upperDir.length,
            lowerLength: lowerDir.length,
            upperOffset: upperFrame.inverse * rest.upper.q,
            lowerOffset: lowerFrame.inverse * rest.lower.q,
            handOffset: gripRest.inverse * rest.hand.q,
            palmLocal: rest.hand.q.inverse.rotate(palm),
            lowerAxis: rest.lower.q.inverse.rotate(lowerDir.normalizedThree),
            handRest: rest.lower.q.inverse * rest.hand.q,
            twistShare: tables.forearmTwistShare,
            maxReach: tables.maxReach)
    }

    /// Places the palm on a grip. `shoulder` is the upper arm joint, `pole` where the elbow should point.
    public static func solve(_ setup: ArmSetup, shoulder: Vec3, gripPosition: Vec3, gripRotation: Quat, pole: Vec3) -> ArmSolution {
        let l1 = setup.upperLength, l2 = setup.lowerLength
        var out = ArmSolution()
        out.hand = gripRotation * setup.handOffset
        let toWrist = gripPosition - out.hand.rotate(setup.palmLocal) - shoulder
        let wanted = toWrist.length
        let reach = min(max(wanted, abs(l1 - l2) + 0.01), (l1 + l2) * setup.maxReach)
        let dir = wanted > 1e-6 ? toWrist / wanted : Vec3(0, 0, -1)
        out.wrist = shoulder + dir * reach

        var side = pole + dir * -pole.dot(dir)
        if side.lengthSquared < 1e-8 { side = Vec3(dir.z, 0, -dir.x) }
        side = side.normalizedThree
        let along = (l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach)
        let across = max(0, 1 - along * along).squareRoot()
        let elbowDir = dir * along + side * across
        out.elbow = shoulder + elbowDir * l1
        let foreDir = (out.wrist - out.elbow).normalizedThree
        var hingeAxis = elbowDir.cross(foreDir)
        if hingeAxis.lengthSquared < 1e-8 { hingeAxis = -dir.cross(side) }
        hingeAxis = hingeAxis.normalizedThree

        out.upper = quatFromBasis(elbowDir, hingeAxis) * setup.upperOffset
        out.lower = quatFromBasis(foreDir, hingeAxis) * setup.lowerOffset

        let relative = out.lower.inverse * out.hand * setup.handRest.inverse
        let axis = setup.lowerAxis
        let projection = relative.x * axis.x + relative.y * axis.y + relative.z * axis.z
        var twist = Quat(axis.x * projection, axis.y * projection, axis.z * projection, relative.w)
        if twist.lengthSquared < 1e-10 { return out }
        twist = twist.normalized
        out.lower = out.lower * Quat.identity.slerp(twist, setup.twistShare)
        return out
    }
}
