// Ported from src/characters/skeleton.ts at commit f14381f. Forward kinematics over the clip bones
// in model space (feet at the origin, facing -Z), with per-bone corrections and arm IK on top.
import Foundation

public struct Skeleton: Sendable {
    /// Model-space rotation and position of each clip bone after `apply`.
    public private(set) var modelQ: [Quat]
    public private(set) var modelP: [Vec3]
    /// Extra model-space rotation per bone. Identity means none.
    public var adjust: [Quat]
    let parents: [Int]
    let offsets: [Vec3]
    let restModel: [Quat]
    let spineChain: [Int]
    let spine2: Int
    let head: Int

    public init(rig: SoldierRig) {
        let count = rig.tables.clipBones.count
        modelQ = [Quat](repeating: .identity, count: count)
        modelP = [Vec3](repeating: .zero, count: count)
        adjust = [Quat](repeating: .identity, count: count)
        parents = rig.parents
        offsets = rig.offsets
        restModel = rig.restModel
        let t = rig.tables
        spineChain = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"].map(t.boneIndex)
        spine2 = t.boneIndex("Spine2")
        head = t.boneIndex("Head")
    }

    /// How far the clip alone has turned the chest and the head from rest, in model space.
    public func measure(_ pose: Pose) -> (chest: Quat, head: Quat) {
        var chain = Quat.identity
        var chest = Quat.identity
        for index in spineChain {
            chain = chain * pose.rotation(index)
            if index == spine2 { chest = chain * restModel[index].inverse }
        }
        return (chest, chain * restModel[head].inverse)
    }

    public mutating func clearAdjust() {
        for i in adjust.indices { adjust[i] = .identity }
    }

    /// Runs the pose through the bones with `adjust` folded in.
    public mutating func apply(_ pose: Pose) {
        for i in modelQ.indices {
            let parent = parents[i]
            let parentQ: Quat
            if parent < 0 {
                parentQ = .identity
                modelP[i] = Vec3(Double(pose.hips[0]), Double(pose.hips[1]), Double(pose.hips[2]))
            } else {
                parentQ = modelQ[parent]
                modelP[i] = parentQ.rotate(offsets[i]) + modelP[parent]
            }
            var q = parentQ * pose.rotation(i)
            let a = adjust[i]
            if a.w < 0.9999995 { q = a * q }
            modelQ[i] = q
        }
    }

    public mutating func setArm(_ arm: ArmRig, _ solution: ArmSolution, weight: Double) {
        if weight <= 0 { return }
        setBone(arm.upper, solution.upper, weight)
        setBone(arm.lower, solution.lower, weight)
        setBone(arm.hand, solution.hand, weight)
    }

    private mutating func setBone(_ index: Int, _ target: Quat, _ weight: Double) {
        let parent = parents[index]
        modelQ[index] = weight >= 1 ? target : modelQ[index].slerp(target, weight)
        let parentQ = parent < 0 ? Quat.identity : modelQ[parent]
        modelP[index] = parentQ.rotate(offsets[index]) + (parent < 0 ? .zero : modelP[parent])
    }
}
