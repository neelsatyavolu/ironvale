// Ported from src/weapons/models/arms.ts and lib/guns-c-ik.ts at commit a487033: the skinned
// first-person arms, posed every frame by two-bone IK so the hands sit on the gun's grip anchors.
// Shoulder, hand and finger tables come from Contract/viewmodel.json (lib/guns-c-arms-pose.ts).
import Foundation
import simd

/// lib/guns-c-ik.ts: two-bone inverse kinematics.
enum TwoBoneIK {
    static func perpendicularTo(_ unit: RVec3, _ hint: RVec3, epsilon: Double) -> RVec3 {
        var out = hint - unit * simd_dot(hint, unit)
        if simd_length_squared(out) < epsilon {
            // The hint is parallel to the axis: fall back to whichever world axis is least aligned.
            out = abs(unit.x) < 0.9 ? RVec3(1, 0, 0) : RVec3(0, 1, 0)
            out -= unit * simd_dot(out, unit)
        }
        return out.unit
    }

    static func solveElbow(shoulder: RVec3, wrist: RVec3, upper: Double, fore: Double, pole: RVec3, epsilon: Double) -> RVec3 {
        var direction = wrist - shoulder
        let distance = simd_length(direction)
        direction = distance < epsilon ? RVec3(0, 0, -1) : direction * (1 / distance)
        let reach = min(max(distance, abs(upper - fore) + epsilon), upper + fore)
        let along = (upper * upper - fore * fore + reach * reach) / (2 * reach)
        let height = max(0, upper * upper - along * along).squareRoot()
        let perpendicular = perpendicularTo(direction, pole, epsilon: epsilon)
        return shoulder + direction * along + perpendicular * height
    }

    static func clampReach(shoulder: RVec3, wrist: RVec3, minReach: Double, maxReach: Double, epsilon: Double) -> RVec3 {
        var direction = wrist - shoulder
        let distance = simd_length(direction)
        if distance >= minReach, distance <= maxReach { return shoulder }
        direction = distance < epsilon ? RVec3(0, 0, -1) : direction * (1 / distance)
        return wrist + direction * -(distance > maxReach ? maxReach : minReach)
    }

    /// Rotation that turns local -Z onto `aim` and local +X as close to `hint` as the aim allows.
    static func basisQuaternion(_ aim: RVec3, _ hint: RVec3, epsilon: Double) -> RQuat {
        let axisZ = -aim
        let axisX = perpendicularTo(axisZ, hint, epsilon: epsilon)
        let axisY = simd_cross(axisZ, axisX)
        return RQuat.fromRotation(RMat.basis(axisX, axisY, axisZ))
    }

    /// The part of `q` that turns about `axis`, scaled by `share`, the short way round.
    static func twistAbout(_ q: RQuat, _ axis: RVec3, _ share: Double) -> RQuat {
        let projection = q.x * axis.x + q.y * axis.y + q.z * axis.z
        let sign: Double = q.w < 0 ? -1 : 1
        let angle = 2 * atan2(projection * sign, q.w * sign)
        return RQuat.axisAngle(axis, angle * share)
    }
}

/// One arm: bones, rest-pose measurements and the per-frame solve (arms.ts Arm).
final class Arm {
    private let upperBone: RigNode
    private let foreBone: RigNode
    private let handBone: RigNode
    private let upperLength: Double
    private let foreLength: Double
    private let upperReference: RQuat
    private let foreReference: RQuat
    private let wristOffset: RVec3
    private let wristRotation: RQuat
    private let restBendInverse: RQuat
    private let foreAxis: RVec3
    private let parentInverse: simd_double4x4
    private let parentRotationInverse: RQuat
    private let home: RVec3
    private let pole: RVec3
    private let hand: ViewModelTables.Arms.Hand
    private let epsilon: Double

    enum BuildError: Error, CustomStringConvertible {
        case missingBone(String)
        var description: String {
            switch self { case .missingBone(let p): "Arms model has no bone matching ^\(p)" }
        }
    }

    static func bone(_ root: RigNode, _ prefix: String) throws -> RigNode {
        guard let found = root.first(where: { $0.name.hasPrefix(prefix) }) else { throw BuildError.missingBone(prefix) }
        return found
    }

    /// `model` must have its world matrices current and be at the arms root's origin.
    init(model: RigNode, side: String, tables: ViewModelTables.Arms) throws {
        let right = side == "R"
        hand = tables.hand
        epsilon = tables.EPSILON
        upperBone = try Self.bone(model, "\(side)_arm")
        foreBone = try Self.bone(model, "\(side)_elbow")
        handBone = try Self.bone(model, "\(side)_wrist")
        guard let parent = upperBone.parent else { throw BuildError.missingBone("\(side)_arm parent") }

        let shoulder = upperBone.worldPosition, elbow = foreBone.worldPosition, wrist = handBone.worldPosition
        let knuckles = try tables.FINGERS.map { try Self.bone(model, "\(side)_\($0)1").worldPosition }
        upperLength = simd_distance(shoulder, elbow)
        foreLength = simd_distance(elbow, wrist)

        let forward = (knuckles[1] - wrist).unit
        var across = knuckles[0] - knuckles[3]
        across = (across - forward * simd_dot(across, forward)).unit
        let palmNormal = right ? simd_cross(across, forward) : simd_cross(forward, across)
        let knuckleCentre = knuckles.reduce(RVec3.zero, +) * (1 / Double(knuckles.count))
        let palm = wrist + (knuckleCentre - wrist) * tables.hand.palmAlong + across * tables.hand.palmAcross + palmNormal * tables.hand.palmDepth
        var gripFrame = RMat.basis(simd_cross(forward, across), across, -forward)
        gripFrame[3] = SIMD4(palm, 1)
        let gripRotationInverse = RQuat.fromRotation(gripFrame).inverse
        wristOffset = RMat.apply(gripFrame.inverse, wrist)
        let handRest = handBone.worldQuaternion
        wristRotation = gripRotationInverse * handRest

        let upperDirection = (elbow - shoulder).unit
        let foreDirection = (wrist - elbow).unit
        let hinge = simd_cross(upperDirection, foreDirection).unit
        let upperRest = upperBone.worldQuaternion, foreRest = foreBone.worldQuaternion
        upperReference = TwoBoneIK.basisQuaternion(upperDirection, hinge, epsilon: tables.EPSILON).inverse * upperRest
        foreReference = TwoBoneIK.basisQuaternion(foreDirection, hinge, epsilon: tables.EPSILON).inverse * foreRest
        restBendInverse = (foreRest.inverse * handRest).inverse
        foreAxis = handBone.position.unit
        parentInverse = parent.matrixWorld.inverse
        parentRotationInverse = parent.worldQuaternion.inverse
        let anchors = tables.shoulders[side]
        home = anchors?.home.vec3 ?? .zero
        pole = anchors?.pole.vec3 ?? RVec3(0, -1, 0)

        if let curls = tables.fingerCurls[side] {
            try Self.poseFingers(model, side: side, curls: curls, fingers: tables.FINGERS, right: right,
                                 forward: forward, across: across, palmNormal: palmNormal)
        }
    }

    /// Rotate `joint` by `degrees` about `axis` (rig space), on top of its rest pose.
    private static func curl(_ joint: RigNode, _ axis: RVec3, _ degrees: Double) {
        let local = joint.worldQuaternion.inverse.rotate(axis).unit
        joint.quaternion = joint.quaternion * RQuat.axisAngle(local, degrees * .pi / 180)
        joint.updateMatrixWorld()
    }

    private static func poseFingers(_ model: RigNode, side: String, curls: ViewModelTables.Arms.Curls, fingers: [String], right: Bool,
                                    forward: RVec3, across: RVec3, palmNormal: RVec3) throws {
        let closeAxis = right ? across : -across
        let opposeAxis = right ? -forward : forward
        let spreadAxis = right ? -palmNormal : palmNormal
        curl(try bone(model, "\(side)_point1"), spreadAxis, curls.pointSpread)
        for finger in fingers {
            for (index, degrees) in curls.finger(finger).enumerated() {
                curl(try bone(model, "\(side)_\(finger)\(index + 1)"), closeAxis, degrees)
            }
        }
        curl(try bone(model, "\(side)_palm"), closeAxis, curls.cup)
        curl(try bone(model, "\(side)_thumb1"), spreadAxis, curls.thumbSpread)
        for (index, degrees) in curls.thumb.enumerated() {
            curl(try bone(model, "\(side)_thumb\(index + 1)"), opposeAxis, degrees)
        }
    }

    /// Pose the arm so the hand's grip frame sits at `position` / `quaternion` (rig space).
    func solve(position: RVec3, quaternion: RQuat) {
        let handQ = quaternion * wristRotation
        let wrist = quaternion.rotate(wristOffset) + position
        let shoulder = TwoBoneIK.clampReach(shoulder: home, wrist: wrist, minReach: hand.minReach,
                                            maxReach: (upperLength + foreLength) * hand.maxReach, epsilon: epsilon)
        let elbow = TwoBoneIK.solveElbow(shoulder: shoulder, wrist: wrist, upper: upperLength, fore: foreLength, pole: pole, epsilon: epsilon)
        let upperDirection = (elbow - shoulder).unit
        let foreDirection = (wrist - elbow).unit
        let hinge = simd_cross(pole, wrist - shoulder)
        let upper = TwoBoneIK.basisQuaternion(upperDirection, hinge, epsilon: epsilon) * upperReference
        var fore = TwoBoneIK.basisQuaternion(foreDirection, hinge, epsilon: epsilon) * foreReference
        // Roll of the hand away from its rest relation to the forearm, in forearm space.
        let twist = fore.inverse * handQ * restBendInverse
        fore = fore * TwoBoneIK.twistAbout(twist, foreAxis, hand.forearmTwistShare)

        upperBone.position = RMat.apply(parentInverse, shoulder)
        upperBone.quaternion = parentRotationInverse * upper
        foreBone.quaternion = upper.inverse * fore
        handBone.quaternion = fore.inverse * handQ
    }
}

/// arms.ts FirstPersonArms: both arms on one skinned model.
public final class FirstPersonArms {
    public let root = RigNode(name: "fp_arms")
    /// The cloned glTF scene (scaled to metres and turned to face -Z).
    public let model: RigNode
    private let left: Arm
    private let right: Arm
    private let tuckPosition: RVec3
    private let tuckQuaternion: RQuat
    private var supportPosition: RVec3
    private var supportQuaternion: RQuat
    private var supportWeight = 0.0
    private var updated = false
    private let blendSeconds: Double

    /// `scene` holds the arms glTF's root nodes (ViewModelAssets builds it from the IVM).
    public init(scene: RigNode, tables: ViewModelTables.Arms) throws {
        model = scene
        model.scale = RVec3(repeating: tables.SOURCE_SCALE)
        model.quaternion = RQuat.eulerXYZ(0, .pi, 0)
        root.add(model)
        root.updateMatrixWorld()
        left = try Arm(model: model, side: "L", tables: tables)
        right = try Arm(model: model, side: "R", tables: tables)
        let z = -(tables.tuck.fingers.vec3.unit)
        var y = tables.tuck.thumb.vec3
        y = (y - z * simd_dot(y, z)).unit
        tuckQuaternion = RQuat.fromRotation(RMat.basis(simd_cross(y, z), y, z))
        tuckPosition = tables.tuck.position.vec3
        supportPosition = tuckPosition
        supportQuaternion = tuckQuaternion
        blendSeconds = tables.supportBlendSeconds
    }

    /// Pose both arms onto the grips. `dt` is the frame time; the first update snaps the off hand into place.
    public func update(trigger: RigNode, support: RigNode?, dt: Double) {
        let step = (updated ? min(0.1, dt) : 1) / blendSeconds
        updated = true
        root.updateWorldMatrixFromRoot()
        let rootInverse = root.matrixWorld.inverse
        trigger.updateWorldMatrixFromRoot()
        let grip = RMat.decompose(rootInverse * trigger.matrixWorld)
        right.solve(position: grip.position, quaternion: grip.quaternion)
        if let support {
            support.updateWorldMatrixFromRoot()
            let s = RMat.decompose(rootInverse * support.matrixWorld)
            supportPosition = s.position
            supportQuaternion = s.quaternion
        }
        supportWeight = Motion.clamp(supportWeight + (support != nil ? step : -step), 0, 1)
        let weight = supportWeight * supportWeight * (3 - 2 * supportWeight)
        let position = tuckPosition + (supportPosition - tuckPosition) * weight
        left.solve(position: position, quaternion: tuckQuaternion.slerp(supportQuaternion, weight))
    }
}
