// Ported from src/characters/soldier.ts at commit f14381f: the third-person soldier for bots and the
// other network player. Clips for the legs and body, a procedural upper body for aiming, arm IK
// onto the rifle, hit reactions, death and the dropped rifle. The renderer reads `jointMatrices`
// (root space) and `gunPosition`/`gunRotation`; the caller sets `position` and `yaw` each frame.
import Foundation
import simd

/// What the game tells a soldier each frame (SoldierVisual.setState in src/game/contracts.ts).
public struct SoldierState: Sendable, Equatable {
    public var speed = 0.0
    public var crouching = false
    public var aimPitch = 0.0
    public var aiming = false
    public var firing = false
    public var reloading = false
    public init(speed: Double = 0, crouching: Bool = false, aimPitch: Double = 0, aiming: Bool = false,
                firing: Bool = false, reloading: Bool = false) {
        self.speed = speed; self.crouching = crouching; self.aimPitch = aimPitch
        self.aiming = aiming; self.firing = firing; self.reloading = reloading
    }
}

@MainActor
public final class Soldier {
    // soldier.ts module constants that are THREE.Vector3 literals (not extractable).
    static let rightElbow = Vec3(0.55, -0.8, 0.25).normalizedThree
    static let leftElbow = Vec3(-0.3, -0.92, 0.1).normalizedThree
    static let rightEye = Vec3(0.032, 0.085, -0.085)
    /// soldier.ts BOUNDS: a fixed cull sphere wide enough for a fallen body.
    public static let boundsCenter = Vec3(0, 0.9, 0)
    public static let boundsRadius = 2.4

    private static var nextSlot = 0

    public let rig: SoldierRig
    public let team: Team
    /// Root transform: feet position and yaw (yaw 0 faces -Z), as `root.position` and `root.rotation.y`.
    public var position = Vec3.zero
    public var yaw = 0.0

    public private(set) var skeleton: Skeleton
    public private(set) var gunPosition = Vec3.zero
    public private(set) var gunRotation = Quat.identity
    public private(set) var pivotYaw = 0.0
    /// Times the skeleton has been posed (LOD checks read it).
    public private(set) var poseCount = 0
    public private(set) var dead = false
    public var visibility: VisibilityTracker

    private let t: CharacterTables
    private let tuning: CharacterTables.Tuning
    private var hold: GunHold
    private var holdInput = HoldInput()
    private var pose: Pose
    private var sample: Pose
    private var deathFrom: Pose
    private var weights = GaitWeights()
    private var flinchState: Flinch
    private var recoil: Recoil
    private var drop: GunDrop
    private let slot: Int
    private var lastPosition = Vec3.zero
    private var hasLastPosition = false
    private var state = SoldierState()
    private var frame = 0
    private var clock = 0.0
    private var phase = 0.0
    private var crouch = 0.0
    private var aim = 0.0
    private var carry = 0.0
    private var aimHold = 0.0
    private var pitch = 0.0
    private var reloadTime = -1.0
    private var hipYaw = 0.0
    private var reverse = false
    private var deadTime = 0.0
    private var deathYaw = 0.0
    private var deathVariant = DeathVariant.back
    private var corpseAtRest = false
    private let bone: (hips: Int, spine: Int, spine1: Int, spine2: Int, neck: Int, head: Int, leftShoulder: Int, rightShoulder: Int)
    private let spineShare: (Double, Double, Double)

    public init(rig: SoldierRig, team: Team) {
        self.rig = rig
        self.team = team
        t = rig.tables
        tuning = rig.tables.tuning
        hold = GunHold(tables: t)
        flinchState = Flinch(tables: t)
        recoil = Recoil(tables: t)
        drop = GunDrop(tables: t)
        visibility = VisibilityTracker(tables: t)
        skeleton = Skeleton(rig: rig)
        let count = t.clipBones.count
        pose = Pose(bones: count)
        sample = Pose(bones: count)
        deathFrom = Pose(bones: count)
        bone = (t.boneIndex("Hips"), t.boneIndex("Spine"), t.boneIndex("Spine1"), t.boneIndex("Spine2"),
                t.boneIndex("Neck"), t.boneIndex("Head"), t.boneIndex("LeftShoulder"), t.boneIndex("RightShoulder"))
        spineShare = (t.spineShare["Spine"] ?? 0, t.spineShare["Spine1"] ?? 0, t.spineShare["Spine2"] ?? 0)
        slot = Self.nextSlot
        Self.nextSlot += 1
        poseNow()
    }

    public var rootRotation: Quat { Quat.eulerXYZ(0, yaw, 0) }

    /// World position of the carbine's muzzle (`muzzleWorld`).
    public func muzzleWorld() -> Vec3 {
        let muzzle = t.carbine.muzzle.vec3
        return position + rootRotation.rotate(gunPosition + gunRotation.rotate(muzzle))
    }

    public func setState(_ state: SoldierState) { self.state = state }

    public func flinch(_ zone: HitZone) {
        if !dead { flinchState.hit(zone) }
    }

    /// `direction` is the fatal bullet's travel direction in world space.
    public func die(direction: Vec3) {
        if dead { return }
        dead = true
        corpseAtRest = false
        deadTime = 0
        deathFrom = pose
        let local = rootRotation.inverse.rotate(direction)
        let plan = Death.plan(x: local.x, z: local.z, tables: t)
        deathVariant = plan.variant
        deathYaw = plan.turn
        drop.release(direction: local)
    }

    public func revive() {
        dead = false
        corpseAtRest = false
        deadTime = 0
        deathYaw = 0
        pivotYaw = 0
        flinchState.reset()
        recoil.reset()
        drop.reset()
        aim = 0
        carry = 0
        aimHold = 0
        reloadTime = -1
        hipYaw = 0
        hasLastPosition = false
        poseNow()
    }

    public func update(_ dt: Double) {
        let step = min(max(dt, 0), 0.1)
        frame += 1
        visibility.tick()
        clock += step
        if dead {
            deadTime += step
            drop.update(position: &gunPosition, rotation: &gunRotation, dt: step)
            if corpseAtRest { return }
        } else {
            advance(step)
        }
        let interval = PoseLOD.interval(visible: visibility.visible, distance: visibility.distance, tables: t)
        if PoseLOD.shouldPose(frame: frame, slot: slot, interval: interval) { poseNow() }
    }

    /// Pose now, whatever the level-of-detail schedule says.
    public func refresh() { poseNow() }

    private func approach(_ value: Double, _ target: Double, _ step: Double) -> Double {
        value < target ? min(target, value + step) : max(target, value - step)
    }

    private func advance(_ dt: Double) {
        trackHeading(dt)
        crouch = approach(crouch, state.crouching ? 1 : 0, dt / tuning.crouchTime)
        aimHold = state.firing ? tuning.aimHold : max(0, aimHold - dt)
        let wantsAim = state.aiming || aimHold > 0
        aim = approach(aim, wantsAim && !state.reloading ? 1 : 0, dt / tuning.aimTime)
        let wantsCarry = !wantsAim && !state.reloading && !state.crouching && state.speed > tuning.carrySpeed
        carry = approach(carry, wantsCarry ? 1 : 0, dt / tuning.carryTime)
        pitch += (clamp(state.aimPitch, -tuning.maxPitch, tuning.maxPitch) - pitch) * min(1, dt * 14)
        reloadTime = state.reloading ? (max(0, reloadTime) + dt / tuning.reloadSeconds).truncatingRemainder(dividingBy: 1) : -1
        recoil.update(dt, firing: state.firing)
        flinchState.update(dt)
        weights = Locomotion.gaitWeights(speed: state.speed, crouch: crouch)
        phase = Locomotion.advancePhase(phase, speed: state.speed, weights: weights, dt: dt, reverse: reverse, tables: t)
    }

    private func trackHeading(_ dt: Double) {
        var target = 0.0
        if hasLastPosition && dt > 1e-5 {
            let dx = position.x - lastPosition.x
            let dz = position.z - lastPosition.z
            if (dx * dx + dz * dz).squareRoot() / dt > tuning.minHeadingSpeed {
                let forward = -dx * sin(yaw) - dz * cos(yaw)
                let left = -dx * cos(yaw) + dz * sin(yaw)
                let heading = Locomotion.resolveHeading(atan2(left, forward), wasReverse: reverse, tables: t)
                reverse = heading.reverse
                target = heading.hipYaw
            } else {
                reverse = false
            }
        }
        lastPosition = position
        hasLastPosition = true
        hipYaw += (target - hipYaw) * min(1, dt * tuning.headingRate)
    }

    private func poseNow() {
        poseCount += 1
        var alive = 1.0
        var ik = 1.0
        if dead {
            let f = Death.frame(deathVariant, elapsed: deadTime, tables: t)
            let clipName = Death.variant(deathVariant, tables: t).clip
            sampleClip(rig.clips[clipName]!, f.clipTime, &sample)
            pose = deathFrom
            blendPose(&pose, sample, f.blend)
            alive = 1 - f.blend
            ik = f.ikWeight
            pivotYaw = deathYaw * f.turn
            corpseAtRest = f.settled
        } else {
            var total = 0.0
            for clip in GaitClip.allCases {
                let weight = weights[clip]
                if weight <= 0 { continue }
                let time = clip.isMoving ? Locomotion.clipTime(clip, phase: phase, tables: t) : clock
                total += weight
                if total == weight {
                    sampleClip(rig.clips[clip.name]!, time, &pose)
                } else {
                    sampleClip(rig.clips[clip.name]!, time, &sample)
                    blendPose(&pose, sample, weight / total)
                }
            }
        }
        let settle = tuning.collarSettle * ik
        steerBone(&pose, bone.leftShoulder, rig.restLocal[bone.leftShoulder], settle)
        steerBone(&pose, bone.rightShoulder, rig.restLocal[bone.rightShoulder], settle)
        setAdjustments(alive)
        skeleton.apply(pose)
        if ik > 0 { holdRifle(ik) }
    }

    private func setAdjustments(_ alive: Double) {
        skeleton.clearAdjust()
        if alive <= 0 { return }
        let (clipChest, clipHead) = skeleton.measure(pose)
        let f = flinchState
        let aimed = (0.4 + 0.6 * aim) * (1 - carry)
        let moving = 1 - weights[.idle] - weights[.crouchIdle]
        let standing = tuning.readyLean + (tuning.aimLean - tuning.readyLean) * aim
            + (tuning.crouchLean + tuning.crouchMoveLean * moving) * crouch
            - min(tuning.maxPaceLean, state.speed * tuning.paceLean)
        let lean = standing + (tuning.carryLean - standing) * carry
        let blade = (tuning.bladeReady + (tuning.bladeAimed - tuning.bladeReady) * aim) * (1 - carry)
        let holdWeight = (tuning.chestHold + (tuning.carryHold - tuning.chestHold) * carry) * alive
        let kick = recoil.value * alive

        let hips = Quat.eulerXYZ(f.hipsPitch * alive, hipYaw * alive, f.hipsRoll * alive)
        skeleton.adjust[bone.hips] = hips
        let chestNow = hips * clipChest
        var chestFix = Quat.eulerXYZ(lean + pitch * aimed * tuning.chestPitchShare, blade, 0) * chestNow.inverse
        chestFix = Quat.identity.slerp(chestFix, holdWeight)
        skeleton.adjust[bone.spine] = Quat.identity.slerp(chestFix, spineShare.0)
        skeleton.adjust[bone.spine1] = Quat.eulerXYZ(f.torsoPitch * alive, 0, 0) * Quat.identity.slerp(chestFix, spineShare.1)
        skeleton.adjust[bone.spine2] = Quat.eulerXYZ(kick * 0.02, f.torsoYaw * alive, 0) * Quat.identity.slerp(chestFix, spineShare.2)

        let headNow = chestFix * hips * clipHead
        let sighting = aim * (1 - carry)
        let upright = sighting * (1 - crouch)
        var headFix = Quat.eulerXYZ(pitch * aimed + tuning.sightNod * upright, 0, tuning.cheekRoll * sighting) * headNow.inverse
        headFix = Quat.identity.slerp(headFix, holdWeight * tuning.headHold)
        skeleton.adjust[bone.neck] = Quat.eulerXYZ(f.headPitch * 0.4 * alive, 0, 0) * Quat.identity.slerp(headFix, 0.45)
        skeleton.adjust[bone.head] = Quat.eulerXYZ(f.headPitch * 0.6 * alive, f.headYaw * alive, 0) * Quat.identity.slerp(headFix, 0.55)
        skeleton.adjust[bone.rightShoulder] = Quat.eulerXYZ(0, 0, tuning.aimShrug * upright * alive)
    }

    private func holdRifle(_ weight: Double) {
        let stride = phase * .pi * 2
        let moving = 1 - weights[.idle] - weights[.crouchIdle]
        holdInput.aim = aim
        holdInput.carry = carry
        holdInput.pitch = pitch
        holdInput.recoil = recoil.value
        holdInput.recoilSide = recoil.side
        holdInput.reload = reloadTime
        holdInput.swayPitch = sin(clock * 1.7) * 0.006 + sin(stride * 2) * 0.012 * moving - flinchState.gunDip
        holdInput.swayYaw = sin(clock * 1.1 + 1) * 0.005 + sin(stride) * 0.014 * moving
        let head = bone.head
        let eye = (skeleton.modelQ[head] * rig.restModel[head].inverse).rotate(Self.rightEye) + skeleton.modelP[head]
        let right = rig.right, left = rig.left
        hold.update(shoulder: skeleton.modelP[right.upper], input: holdInput, eye: eye)
        if !dead {
            gunPosition = hold.position
            gunRotation = hold.quaternion
        }
        var elbow = Self.rightElbow
        elbow.y += 0.1 * aim
        let rightArm = ArmIK.solve(right.setup, shoulder: skeleton.modelP[right.upper], gripPosition: hold.triggerPosition,
                                   gripRotation: hold.triggerRotation, pole: elbow.normalizedThree)
        let leftArm = ArmIK.solve(left.setup, shoulder: skeleton.modelP[left.upper], gripPosition: hold.supportPosition,
                                  gripRotation: hold.supportRotation, pole: Self.leftElbow)
        skeleton.setArm(right, rightArm, weight: weight)
        skeleton.setArm(left, leftArm, weight: weight)
    }

    // MARK: - Render data

    /// Root-space matrix of every IVM node (pivot turn included), from the posed clip bones and the
    /// rest or gripping locals of the others. `out` must hold `rig.model.nodes.count` matrices.
    public func nodeMatrices(into out: inout [simd_float4x4]) {
        let pivot = Quat.eulerXYZ(0, pivotYaw, 0)
        var q = [Quat](repeating: .identity, count: rig.model.nodes.count)
        var p = [Vec3](repeating: .zero, count: rig.model.nodes.count)
        for (i, node) in rig.model.nodes.enumerated() {
            let b = rig.nodeBone[i]
            if b >= 0 {
                q[i] = pivot * skeleton.modelQ[b]
                p[i] = pivot.rotate(skeleton.modelP[b])
            } else if let parent = node.parent {
                q[i] = q[parent] * rig.nodeLocalRotation[i]
                p[i] = p[parent] + q[parent].rotate(rig.nodeLocalTranslation[i])
            } else {
                q[i] = pivot * rig.nodeLocalRotation[i]
                p[i] = pivot.rotate(rig.nodeLocalTranslation[i])
            }
            out[i] = Self.matrix(q[i], p[i])
        }
    }

    /// Skinning palette in root space: joint node matrix x inverse bind matrix, one per skin joint.
    public func jointMatrices(into out: inout [simd_float4x4], nodes scratch: inout [simd_float4x4]) {
        nodeMatrices(into: &scratch)
        let ibm = rig.inverseBindMatrices
        for (j, node) in rig.skin.joints.enumerated() { out[j] = scratch[node] * ibm[j] }
    }

    public var gunMatrix: simd_float4x4 { Self.matrix(gunRotation, gunPosition) }

    public var rootMatrix: simd_float4x4 { Self.matrix(rootRotation, position) }

    static func matrix(_ q: Quat, _ p: Vec3) -> simd_float4x4 {
        let x = q.x, y = q.y, z = q.z, w = q.w
        let c0 = SIMD4<Float>(Float(1 - 2 * (y * y + z * z)), Float(2 * (x * y + w * z)), Float(2 * (x * z - w * y)), 0)
        let c1 = SIMD4<Float>(Float(2 * (x * y - w * z)), Float(1 - 2 * (x * x + z * z)), Float(2 * (y * z + w * x)), 0)
        let c2 = SIMD4<Float>(Float(2 * (x * z + w * y)), Float(2 * (y * z - w * x)), Float(1 - 2 * (x * x + y * y)), 0)
        return simd_float4x4(columns: (c0, c1, c2, SIMD4(Float(p.x), Float(p.y), Float(p.z), 1)))
    }
}
