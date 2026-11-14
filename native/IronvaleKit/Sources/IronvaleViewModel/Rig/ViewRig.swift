// Ported from src/weapons/view/rig.ts and poses.ts at commit a487033: the first-person view model,
// one gun (and the arms) parented to the camera, posed every frame from layered procedural motion:
// hip to sights, breathing, look lag, walk bob, sprint carry, lowered, reload and bolt work, air drop,
// spring recoil and wall retraction; depth compressed about the eye to a 54 degree view-model lens
// through the root's z scale. Constants come from Contract/viewmodel.json.
import Foundation
import simd

/// rig.ts ViewFrame: everything the rig needs to know about one frame.
public struct ViewFrame: Sendable {
    public var dt: Double
    public var machine: MachineView
    /// 0 hip, 1 aimed (linear; eased here).
    public var aim: Double
    public var sprint: Double
    public var lowered: Double
    public var speed: Double
    public var verticalSpeed: Double
    public var onGround: Bool
    public var lookYaw: Double
    public var lookPitch: Double
    public var hidden: Bool

    public init(dt: Double, machine: MachineView, aim: Double = 0, sprint: Double = 0, lowered: Double = 0, speed: Double = 0,
                verticalSpeed: Double = 0, onGround: Bool = true, lookYaw: Double = 0, lookPitch: Double = 0, hidden: Bool = false) {
        self.dt = dt
        self.machine = machine
        self.aim = aim
        self.sprint = sprint
        self.lowered = lowered
        self.speed = speed
        self.verticalSpeed = verticalSpeed
        self.onGround = onGround
        self.lookYaw = lookYaw
        self.lookPitch = lookPitch
        self.hidden = hidden
    }
}

/// `world.raycast(eye, forward, far)` distance, or nil for no hit. Camera space is the rig's world here
/// only when the camera node sits at the origin; the owner maps it to the real camera.
public typealias WallProbe = (_ origin: RVec3, _ direction: RVec3, _ far: Double) -> Double?

public final class ViewRig {
    /// The camera: the owner sets its transform (identity in camera space) and `fovDegrees` each frame.
    public let camera = RigNode(name: "camera")
    public var fovDegrees = 78.0
    /// src/core/freeze.ts: the breathing clock holds still.
    public var frozen = false
    public let root = RigNode(name: "view_model")
    public let holder = RigNode(name: "holder")
    public let arms: FirstPersonArms?
    public private(set) var gun: GunView?

    private let tables: ViewModelTables
    private let r: ViewModelTables.Rig
    private var time = 0.0
    private var bobPhase = 0.0
    private var bobAmount = 0.0
    private var turnYaw = 0.0
    private var turnPitch = 0.0
    private var retract = 0.0
    private var pitch = 0.0
    private var yaw = 0.0
    private var roll = 0.0
    private var offset = RVec3.zero
    private var kick: Spring
    private var rise: Spring
    private var cant: Spring
    private var twist: Spring
    private var drop: Spring
    private var jolt: Spring

    public init(tables: ViewModelTables, arms: FirstPersonArms?) {
        self.tables = tables
        r = tables.rig
        let step = tables.motion.MAX_SPRING_STEP
        kick = Spring(r.springs["kick"], maxStep: step)
        rise = Spring(r.springs["rise"], maxStep: step)
        cant = Spring(r.springs["cant"], maxStep: step)
        twist = Spring(r.springs["twist"], maxStep: step)
        drop = Spring(r.springs["drop"], maxStep: step)
        jolt = Spring(r.springs["jolt"], maxStep: step)
        self.arms = arms
        root.add(holder)
        if let arms { holder.add(arms.root) }
        root.visible = false
        camera.add(root)
    }

    /// Swap the gun in the hands. Only the shown gun is in the scene graph.
    public func show(_ next: GunView) {
        if gun === next { return }
        if let gun { holder.remove(gun.model.root) }
        gun = next
        next.parts.reset()
        holder.add(next.model.root)
        kick.reset()
        rise.reset()
        cant.reset()
        twist.reset()
        jolt.reset()
        retract = 0
    }

    /// A shot was fired: jolt the gun back, up and a little sideways. `side` is -1 to 1.
    public func fired(aim: Double, side: Double) {
        guard let gun else { return }
        let recoil = gun.def.recoil
        let eased = Motion.smoothstep(aim)
        gun.parts.fired()
        kick.kick(recoil.kickback * r.KICK_IMPULSE)
        rise.kick((0.012 + recoil.vertical * 0.008) * r.KICK_IMPULSE * (1 - (1 - r.AIMED_RISE) * eased))
        cant.kick(side * 0.014 * r.KICK_IMPULSE * (1 - 0.5 * eased))
        twist.kick(side * (0.004 + recoil.horizontal * 0.006) * r.KICK_IMPULSE * (1 - 0.6 * eased))
    }

    /// A reload or action stage happened: a small bump so the motion lands with the sound.
    public func stage(_ stage: String) {
        jolt.kick(stage == "magIn" || stage == "boltForward" ? 0.26 : 0.14)
    }

    public func landed(speed: Double) {
        drop.kick(-min(speed, 12) * 0.022)
    }

    /// Muzzle position in the camera node's parent space (world, when the camera node carries the camera pose).
    public var muzzleWorld: RVec3 {
        guard let gun else { return camera.worldPosition }
        gun.model.muzzle.updateWorldMatrixFromRoot()
        return gun.model.muzzle.worldPosition
    }

    /// Ejection port and the direction casings leave in (the port's +X).
    public var ejectionWorld: (position: RVec3, direction: RVec3) {
        guard let gun else { return (camera.worldPosition, RVec3(1, 0, 0)) }
        let port = gun.model.ejection
        port.updateWorldMatrixFromRoot()
        let m = port.matrixWorld
        return (port.worldPosition, RVec3(m[0][0], m[0][1], m[0][2]).unit)
    }

    /// The view-model depth compression for the current camera lens.
    public var depthScale: Double {
        tan(r.VIEW_MODEL_FOV / 2 * .pi / 180) / tan(fovDegrees / 2 * .pi / 180)
    }

    public func update(_ frame: ViewFrame, wall: WallProbe?) {
        guard let gun else { return }
        let dt = frame.dt
        root.visible = !frame.hidden
        if !frozen { time += dt }
        gun.parts.update(dt, machine: frame.machine)

        let aimed = Motion.smoothstep(frame.aim)
        let hip = 1 - aimed
        offset = .zero
        pitch = 0
        yaw = 0
        roll = 0

        // Base pose: hip to sights, with a small dip and roll through the move.
        let position = gun.hipPosition + (gun.aimPosition - gun.hipPosition) * aimed
        let quaternion = gun.hipQuaternion.slerp(gun.aimQuaternion, aimed)
        let mid = sin(Double.pi * aimed)
        offset.y -= 0.012 * mid
        roll -= 0.07 * mid

        // Breathing at rest.
        offset.y += sin(time * 1.6) * 0.0012 * hip
        pitch += sin(time * 1.1) * 0.003 * hip

        // Look lag: the gun trails the view a little when turning.
        if dt > 0 {
            let rateYaw = Motion.clamp(frame.lookYaw / dt, -r.MAX_TURN_RATE, r.MAX_TURN_RATE)
            let ratePitch = Motion.clamp(frame.lookPitch / dt, -r.MAX_TURN_RATE, r.MAX_TURN_RATE)
            turnYaw = Motion.damp(turnYaw, rateYaw, 9, dt)
            turnPitch = Motion.damp(turnPitch, ratePitch, 9, dt)
        }
        let swayScale = r.AIMED_SWAY + (1 - r.AIMED_SWAY) * hip
        yaw -= turnYaw * r.SWAY_ROTATION * swayScale
        pitch -= turnPitch * r.SWAY_ROTATION * swayScale
        roll -= turnYaw * r.SWAY_ROTATION * 0.8 * hip
        offset.x += turnYaw * r.SWAY_SHIFT * hip
        offset.y -= turnPitch * r.SWAY_SHIFT * hip

        // Walk bob, in step with ground speed.
        let sprint = Motion.smoothstep(frame.sprint)
        let stride = frame.onGround ? Motion.clamp01(frame.speed / r.RUN_SPEED) : 0
        bobAmount = Motion.damp(bobAmount, stride, 8, dt)
        if frame.onGround { bobPhase += ((frame.speed * dt) / r.STRIDE) * .pi }
        let bob = bobAmount * (r.AIMED_BOB + (1 - r.AIMED_BOB) * hip) * (1 + sprint * 0.9)
        let swing = cos(bobPhase)
        let step = abs(sin(bobPhase))
        offset.x += swing * 0.007 * bob
        offset.y -= step * 0.009 * bob
        roll += swing * 0.014 * bob
        yaw += swing * 0.012 * bob * sprint

        add(gun.def.sprintPose, sprint)
        add(tables.poses.lowered, Motion.smoothstep(frame.lowered))
        add(gun.def.reloadPose, gun.parts.tilt)
        add(gun.def.workPose, gun.parts.work)
        offset.y -= 0.012 * gun.parts.seat * gun.parts.tilt
        pitch -= 0.03 * gun.parts.seat * gun.parts.tilt

        // Jumping, falling and landing.
        let airTarget = frame.onGround ? 0 : Motion.clamp(-frame.verticalSpeed * 0.004, -0.03, 0.03)
        let dropValue = drop.step(dt, target: airTarget)
        offset.y += dropValue
        pitch += dropValue * 1.4

        // Recoil and handling bumps.
        let kickLimit = gun.def.recoil.kickback * 2.5 + 0.02
        offset.z += min(kick.step(dt), kickLimit)
        pitch += rise.step(dt)
        roll += cant.step(dt)
        yaw += twist.step(dt)
        let joltValue = jolt.step(dt)
        offset.y -= joltValue * 0.012
        roll += joltValue * 0.03

        // Keep the barrel out of walls: swing it up and in when something is closer than the muzzle.
        let depth = depthScale
        retract = Motion.damp(retract, wallAngle(wall, reach: (gun.barrelLength - position.z) * depth), 12, dt)
        if retract > 0.001 { add(tables.poses.againstWall, retract) }

        // Rotate about the shoulder at the hip and about the eye when aimed, so the sights stay on the axis.
        let turn = RQuat.eulerYXZ(pitch, yaw, roll)
        let pivot = (quaternion.rotate(r.SHOULDER.vec3) + position) * hip
        holder.position = turn.rotate(position - pivot) + pivot + offset
        holder.quaternion = turn * quaternion

        // Hands follow the gun: matrices first, then the targets, then the arms.
        root.scale.z = depth
        camera.updateMatrixWorld()
        gun.updateHands()
        arms?.update(trigger: gun.triggerTarget, support: gun.supportTarget, dt: dt)
    }

    private func add(_ pose: PoseOffset, _ weight: Double) {
        guard weight > 0 else { return }
        offset += RVec3(pose.x, pose.y, pose.z) * weight
        pitch += pose.pitch * weight
        yaw += pose.yaw * weight
        roll += pose.roll * weight
    }

    /// Angle the barrel must swing off the line of sight so the muzzle stays short of whatever is in front of the eye.
    private func wallAngle(_ wall: WallProbe?, reach: Double) -> Double {
        guard let wall, reach > 0 else { return 0 }
        camera.updateWorldMatrixFromRoot()
        let m = camera.matrixWorld
        let forward = -RVec3(m[2][0], m[2][1], m[2][2]).unit
        guard let distance = wall(camera.worldPosition, forward, reach + r.WALL_MARGIN) else { return 0 }
        let room = max(0, distance - r.WALL_MARGIN)
        return min(r.WALL_MAX_ANGLE, acos(min(1, room / reach)))
    }
}
