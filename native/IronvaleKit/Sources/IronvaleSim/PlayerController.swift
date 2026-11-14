// Ported from src/player/controller.ts at commit 185029e. Statement order inside `update` is the
// TypeScript's (weapons map 4.7) and is checked against Contract/sim/player-*.json within 1e-5 m.
import Foundation
import IronvaleWorld

/// A box an interior zone covers (`InteriorZone.box`).
public struct ZoneBox: Sendable, Equatable {
    public let min: Vec3
    public let max: Vec3

    public init(min: Vec3, max: Vec3) {
        self.min = min
        self.max = max
    }

    /// `Box3.containsPoint`.
    public func contains(_ p: Vec3) -> Bool {
        !(p.x < min.x || p.x > max.x || p.y < min.y || p.y > max.y || p.z < min.z || p.z > max.z)
    }
}

/// First-person body: walking, sprinting, crouching, jumping, the camera rig and health with delayed regeneration.
public final class PlayerController: Combatant {
    public let kind = CombatantKind.local
    public let name = "You"
    public let id: Int
    public let team: Team
    public private(set) var position = Vec3.zero
    public private(set) var velocity = Vec3.zero

    public var yaw = 0.0
    public var pitch = 0.0
    public private(set) var onGround = false
    public private(set) var sprinting = false
    public private(set) var crouching = false
    public private(set) var indoors = false
    public private(set) var lookYaw = 0.0
    public private(set) var lookPitch = 0.0
    public private(set) var health = 100.0
    public private(set) var alive = true
    /// When false the body ignores input (menus, death).
    public var controllable = true
    /// The rendered camera (`engine.camera`) and its field of view (`engine.setFov`).
    public private(set) var camera = SimCamera()

    private var eye: Double
    private var surface = Surface.concrete
    private var sinceGrounded = 0.0
    private var strideProgress = 0.0
    private var bobPhase = 0.0
    private var bobAmount = 0.0
    private var landDip = 0.0
    private var landDipVelocity = 0.0
    private var roll = 0.0
    private var recoilPitch = 0.0
    private var recoilYaw = 0.0
    private var recoilReturnPitch = 0.0
    private var recoilReturnYaw = 0.0
    private var sinceHurt = Double.infinity
    private var mobility = 1.0
    private var blockSprint = false
    private var aimBlend = 0.0
    private var zoom = 1.0
    private var nudgeYaw = 0.0
    private var nudgePitch = 0.0

    private let c: SimConstants.Controller
    private let input: any ActionInput
    private let settings: () -> PlayerSettings
    private let events: EventBus
    private let world: () -> CollisionWorld?
    private let interiors: () -> [ZoneBox]
    private let random: () -> Double

    public init(id: Int, team: Team, input: any ActionInput, settings: @escaping () -> PlayerSettings, events: EventBus,
                world: @escaping () -> CollisionWorld?, interiors: @escaping () -> [ZoneBox],
                random: @escaping () -> Double, constants: SimConstants.Controller = SimData.shared.constants.controller) {
        self.id = id
        self.team = team
        self.input = input
        self.settings = settings
        self.events = events
        self.world = world
        self.interiors = interiors
        self.random = random
        c = constants
        eye = constants.STAND_EYE
    }

    /// `Math.hypot(velocity.x, velocity.z)`.
    public var speed: Double { jsHypot(velocity.x, velocity.z) }

    public func eyePosition() -> Vec3 { Vec3(position.x, position.y + eye, position.z) }

    public func hitTest(origin: Vec3, direction: Vec3, maxDistance: Double) -> CombatantHit? {
        hitTestHumanoid(feet: position, crouching: crouching, origin: origin, direction: direction, maxDistance: maxDistance)
    }

    public func applyDamage(_ info: DamageInfo) {
        if !alive { return }
        health = max(0, health - info.amount)
        sinceHurt = 0
        events.emit(.playerHurt(amount: info.amount, health: health, direction: info.direction.negated))
        // A hit jolts the view a little (`randFloat(0.6, 1.4)`, `randFloatSpread(1.6)`).
        let jolt = 0.6 + random() * (1.4 - 0.6)
        let spread = 1.6 * (0.5 - random())
        addRecoil(pitchDegrees: jolt, yawDegrees: spread, recovery: 0.9)
        if health <= 0 {
            alive = false
            events.emit(.died(victimId: id, killerId: info.attackerId, weaponId: info.weaponId, headshot: info.zone == .head))
        }
    }

    public func setWeaponModifiers(mobility: Double, aimBlend: Double, zoom: Double, blockSprint: Bool = false) {
        self.blockSprint = blockSprint
        self.mobility = mobility
        self.aimBlend = aimBlend
        self.zoom = zoom
    }

    public func addRecoil(pitchDegrees: Double, yawDegrees: Double, recovery: Double) {
        let deg = Double.pi / 180
        let pitch = pitchDegrees * deg
        let yaw = yawDegrees * deg
        recoilPitch += pitch
        recoilYaw += yaw
        recoilReturnPitch += pitch * recovery
        recoilReturnYaw += yaw * recovery
    }

    public func nudgeView(yaw: Double, pitch: Double) {
        nudgeYaw += yaw
        nudgePitch += pitch
    }

    public func respawn(position: Vec3, yaw: Double) {
        self.position = position
        velocity = .zero
        self.yaw = yaw
        pitch = 0
        health = 100
        alive = true
        crouching = false
        eye = c.STAND_EYE
        recoilPitch = 0
        recoilYaw = 0
        recoilReturnPitch = 0
        recoilReturnYaw = 0
        sinceHurt = .infinity
        events.emit(.spawned(combatantId: id))
        applyCamera(0)
    }

    public func update(_ dt: Double) {
        let controls = settings()
        let active = controllable && alive

        lookYaw = 0
        lookPitch = 0
        if active { look(dt, controls) }
        recoverRecoil(dt)

        // Movement intent in the horizontal plane.
        let forward = active ? num(input.isDown(.moveForward)) - num(input.isDown(.moveBack)) : 0
        let strafe = active ? num(input.isDown(.moveRight)) - num(input.isDown(.moveLeft)) : 0
        let s = JSMath.sin(yaw)
        let co = JSMath.cos(yaw)
        var wish = Vec3(strafe * co - forward * s, 0, -strafe * s - forward * co)
        if wish.lengthSq > 0 { wish = wish.normalized() }

        let wantsCrouch = active && input.isDown(.crouch)
        if wantsCrouch {
            crouching = true
        } else if crouching, canStand() {
            crouching = false
        }

        // Holding breath shares Shift with sprint; aiming wins.
        sprinting = active && input.isDown(.sprint) && forward > 0 && !crouching && onGround && !blockSprint && aimBlend < 0.3

        var maxSpeed = crouching ? c.CROUCH_SPEED : sprinting ? c.SPRINT_SPEED : c.WALK_SPEED
        maxSpeed *= mobility * MathUtils.lerp(1, c.AIM_SPEED_FACTOR, aimBlend)

        if onGround {
            applyFriction(dt)
            accelerate(wish, maxSpeed, c.GROUND_ACCEL, dt)
        } else {
            accelerate(wish, maxSpeed, c.AIR_ACCEL, dt)
        }

        sinceGrounded = onGround ? 0 : sinceGrounded + dt
        if active, input.wasPressed(.jump), sinceGrounded < c.COYOTE_TIME, !crouching {
            velocity.y = c.JUMP_SPEED
            sinceGrounded = c.COYOTE_TIME
            onGround = false
            events.emit(.jumped(ownerId: id, position: position, local: true))
        }

        velocity.y -= c.GRAVITY * dt
        let fallSpeed = -velocity.y
        let wasGrounded = onGround
        let height = crouching ? c.CROUCH_HEIGHT : c.STAND_HEIGHT
        if let world = world() {
            let result = world.moveCapsule(position: position, velocity: velocity, dt: dt, radius: c.RADIUS, height: height)
            position = result.position
            velocity = result.velocity
            onGround = result.onGround
            if let ground = result.groundSurface { surface = ground }
        }
        if onGround, velocity.y < 0 { velocity.y = 0 }

        if onGround, !wasGrounded, fallSpeed > 3 {
            landDipVelocity -= min(fallSpeed, 12) * 0.22
            events.emit(.landed(ownerId: id, position: position, surface: surface, speed: fallSpeed, local: true))
            strideProgress = 0
        }

        // Fell out of the world: put the player back on the ground above.
        if let world = world(), position.y < world.bounds.min.y - 20 {
            let ground = world.groundHeight(x: position.x, z: position.z, fromY: world.bounds.max.y + 5, maxDrop: 500)
            position.y = (ground ?? 0) + 0.1
            velocity = .zero
        }

        footsteps(dt)
        regenerate(dt)
        let eyeAt = eyePosition()
        indoors = interiors().contains { $0.contains(eyeAt) }

        let eyeTarget = crouching ? c.CROUCH_EYE : c.STAND_EYE
        eye = MathUtils.damp(eye, eyeTarget, 12, dt)
        applyCamera(dt, strafe: strafe, gentle: controls.preset == "trackpad")
    }

    @inline(__always) private func num(_ flag: Bool) -> Double { flag ? 1 : 0 }

    private func look(_ dt: Double, _ controls: PlayerSettings) {
        let look = input.consumeLook(dt: dt)
        // Sensitivity is degrees per 1000 px; scale with zoom so aimed turns match what is on screen.
        let aimScale = MathUtils.lerp(1, controls.adsSensitivity * zoom, aimBlend)
        let scale = (controls.sensitivity / 1000) * (Double.pi / 180) * aimScale
        lookYaw = -look.dx * scale
        lookPitch = -look.dy * scale * (controls.invertY ? -1 : 1)
        yaw += lookYaw
        pitch += lookPitch
        yaw += nudgeYaw
        pitch += nudgePitch
        nudgeYaw = 0
        nudgePitch = 0
        pitch = MathUtils.clamp(pitch, -c.MAX_PITCH, c.MAX_PITCH)
    }

    private func recoverRecoil(_ dt: Double) {
        // Kick is applied to the real view angles quickly, then the recoverable share eases back.
        let applyRate = 1 - JSMath.exp(-dt * 38)
        let kickPitch = recoilPitch * applyRate
        let kickYaw = recoilYaw * applyRate
        recoilPitch -= kickPitch
        recoilYaw -= kickYaw
        pitch = MathUtils.clamp(pitch + kickPitch, -c.MAX_PITCH, c.MAX_PITCH)
        yaw += kickYaw

        let returnRate = 1 - JSMath.exp(-dt * 6.5)
        let backPitch = recoilReturnPitch * returnRate
        let backYaw = recoilReturnYaw * returnRate
        recoilReturnPitch -= backPitch
        recoilReturnYaw -= backYaw
        pitch -= backPitch
        yaw -= backYaw
    }

    private func applyFriction(_ dt: Double) {
        let speed = self.speed
        if speed < 1e-4 { return }
        let drop = max(speed, 1.2) * c.FRICTION * dt
        let factor = max(0, speed - drop) / speed
        velocity.x *= factor
        velocity.z *= factor
    }

    private func accelerate(_ wish: Vec3, _ maxSpeed: Double, _ accel: Double, _ dt: Double) {
        let current = velocity.x * wish.x + velocity.z * wish.z
        let add = min(maxSpeed - current, accel * dt)
        if add <= 0 { return }
        velocity.x += wish.x * add
        velocity.z += wish.z * add
    }

    private func canStand() -> Bool {
        guard let world = world() else { return true }
        let head = Vec3(position.x, position.y + c.CROUCH_HEIGHT - 0.1, position.z)
        return world.raycast(origin: head, direction: Vec3(0, 1, 0), maxDistance: c.STAND_HEIGHT - c.CROUCH_HEIGHT + 0.15) == nil
    }

    private func footsteps(_ dt: Double) {
        if !onGround || speed < 0.8 {
            strideProgress = min(strideProgress, 0.5)
            return
        }
        let stride = sprinting ? c.STRIDE_RUN : c.STRIDE_WALK
        strideProgress += (speed * dt) / stride
        if strideProgress < 1 { return }
        strideProgress -= 1
        // Crouch-walking is quiet enough to skip.
        if crouching { return }
        events.emit(.footstep(ownerId: id, position: position, surface: surface, running: sprinting, local: true))
    }

    private func regenerate(_ dt: Double) {
        sinceHurt += dt
        if !alive || health >= 100 || sinceHurt < c.REGEN_DELAY { return }
        health = min(100, health + c.REGEN_PER_SECOND * dt)
    }

    private func applyCamera(_ dt: Double, strafe: Double = 0, gentle: Bool = false) {
        let gameplay = settings()
        let moving = onGround && speed > 0.5
        let target = moving ? min(1, speed / c.SPRINT_SPEED) : 0
        bobAmount = MathUtils.damp(bobAmount, target, 8, dt)
        let stride = sprinting ? c.STRIDE_RUN : c.STRIDE_WALK
        if moving { bobPhase += ((speed * dt) / stride) * Double.pi }
        // Aiming steadies the head; trackpad players get a slightly calmer bob.
        let bobScale = gameplay.headBob * bobAmount * (1 - aimBlend * 0.75) * (gentle ? 0.8 : 1)
        let bobY = JSMath.sin(bobPhase * 2) * 0.028 * bobScale
        let bobX = JSMath.cos(bobPhase) * 0.02 * bobScale

        // Critically damped spring for the landing dip.
        landDipVelocity += (-landDip * 140 - landDipVelocity * 20) * dt
        landDip += landDipVelocity * dt

        roll = MathUtils.damp(roll, -strafe * 0.012 * (onGround ? 1 : 0.3), 8, dt)

        let s = JSMath.sin(yaw)
        let co = JSMath.cos(yaw)
        camera.position = Vec3(position.x + bobX * co, position.y + eye + bobY + landDip, position.z - bobX * s)
        camera.pitch = pitch
        camera.yaw = yaw
        camera.roll = roll + bobX * 0.25
        camera.fov = fovForZoom(gameplay.fov, MathUtils.lerp(1, zoom, MathUtils.smooth(aimBlend)))
    }
}

/// Zoom multiplies the tangent of the half field of view, the way optical magnification works.
public func fovForZoom(_ baseFov: Double, _ zoom: Double) -> Double {
    let deg = Double.pi / 180
    let half = tan((baseFov * deg) / 2) * zoom
    return (2 * atan(half)) / deg
}
