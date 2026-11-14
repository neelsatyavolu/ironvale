// Ported from src/net/remote-soldier.ts at commit cbe0add.
//
// A body simulated on the other machine: the other player, or (for a co-op guest) one of the host's
// bots. It is a Combatant, so bullets and bots treat it like anyone else, but it never decides its
// own fate: damage dealt here is forwarded, and death arrives as a message. The web drives a
// SoldierVisual from here; the native client publishes a SoldierPose (IronvaleSim SoldierDrawList)
// that the renderer turns into the same animation calls.
import IronvaleSim
import IronvaleWorld
import enum IronvaleWire.WeaponID

public struct RemoteFlags: Sendable, Equatable {
    public var crouching: Bool
    public var aiming: Bool
    public var reloading: Bool
    public var running: Bool
    public var onGround: Bool
    public var alive: Bool
    public var health: Double
    public var weapon: WeaponID

    public init(crouching: Bool, aiming: Bool, reloading: Bool, running: Bool, onGround: Bool, alive: Bool, health: Double, weapon: WeaponID) {
        self.crouching = crouching
        self.aiming = aiming
        self.reloading = reloading
        self.running = running
        self.onGround = onGround
        self.alive = alive
        self.health = health
        self.weapon = weapon
    }
}

public final class RemoteSoldier: Combatant {
    static let standEye = 1.64
    static let crouchEye = 1.08
    static let chestStand = 1.25
    static let chestCrouch = 0.8
    /// Metres per footstep, as the local player's.
    static let strideWalk = 1.55
    static let strideRun = 2.1
    static let minStepSpeed = 0.8
    /// A jump this large between frames is a respawn or a correction, not walking.
    static let teleportDistance = 3.0
    static let firingPoseSeconds = 0.12

    public struct Options {
        public var id: Int
        public var wireId: Int
        public var team: Team
        public var uniform: Team
        public var name: String
        public var weapon: WeaponID
        public var delayMs: Double
        public var maxExtrapolationMs: Double
        public var deriveVelocity: Bool
        public var onDamage: (RemoteSoldier, DamageInfo) -> Void
    }

    public let kind = CombatantKind.remote
    public let id: Int
    public let wireId: Int
    public let team: Team
    public let uniform: Team
    public var name: String
    public private(set) var position = Vec3.zero
    public private(set) var velocity = Vec3.zero
    public private(set) var alive = false
    public private(set) var health = 100.0
    public private(set) var crouching = false
    public var weapon: WeaponID
    public private(set) var yaw = 0.0
    public private(set) var pitch = 0.0
    /// Seconds since death, for clearing bodies away.
    public private(set) var corpseTime = 0.0
    /// Lives at or below this number are over; state from them must not bring the body back.
    public private(set) var endedLife = -1
    /// Shown at all: false until the owner has said where the body is.
    public private(set) var visible = false

    private let options: Options
    private let events: EventBus
    private let world: () -> CollisionWorld?
    private var buffer: SnapshotBuffer
    private var sampled = InterpPose()
    private var last = Vec3.zero
    private var placed = false
    private var aiming = false
    private var reloading = false
    private var running = false
    private var onGround = true
    private var stride = 0.0
    private var firingTime = 0.0
    private var dead = false
    private var fallen = false
    private var epoch = -1
    /// Revivals so far (`SoldierActor.life`).
    private var lives = 0
    private var deathDirection = Vec3(0, 0, -1)
    private var flinches = 0
    private var flinchZone = HitZone.torso

    public init(options: Options, events: EventBus, world: @escaping () -> CollisionWorld?) {
        self.options = options
        self.events = events
        self.world = world
        id = options.id
        wireId = options.wireId
        team = options.team
        uniform = options.uniform
        name = options.name
        weapon = options.weapon
        buffer = SnapshotBuffer(maxExtrapolationMs: options.maxExtrapolationMs, deriveVelocity: options.deriveVelocity)
    }

    /// How the renderer should pose this body now (what the web hands `SoldierVisual`), or nil
    /// while it is hidden.
    public var actor: SoldierActor? {
        guard visible else { return nil }
        return SoldierActor(id: id, kind: kind, team: team, uniform: uniform, position: position, yaw: yaw, pitch: pitch,
                            speed: jsHypot(velocity.x, velocity.z), crouching: crouching, aiming: aiming || firingTime > 0,
                            firing: firingTime > 0, reloading: reloading, alive: !dead, deathDirection: dead ? deathDirection : nil,
                            hits: flinches, lastHitZone: flinches > 0 ? flinchZone : nil, life: lives)
    }

    /// Put the body somewhere before any state has arrived.
    public func place(x: Double, y: Double, z: Double, yaw: Double) {
        position = Vec3(x, y, z)
        last = position
        self.yaw = yaw
        placed = true
        visible = true
    }

    /// A state message. `snapshot.time` is on this machine's clock; `life` identifies the life it belongs to.
    public func push(_ snapshot: InterpSnapshot, flags: RemoteFlags, life: Int) {
        // A new life starts somewhere else: forget the old path so the body is not shown where it fell.
        if snapshot.epoch != epoch, snapshot.time > buffer.newestTime {
            epoch = snapshot.epoch
            buffer.reset()
        }
        guard snapshot.epoch == epoch, buffer.push(snapshot) else { return }
        visible = true
        if snapshot.time < buffer.newestTime { return }
        crouching = flags.crouching
        aiming = flags.aiming
        reloading = flags.reloading
        running = flags.running
        onGround = flags.onGround
        weapon = flags.weapon
        health = flags.health
        let nowAlive = flags.alive && life > endedLife
        if nowAlive, !alive {
            revive()
        } else if !nowAlive, alive, !flags.alive {
            markDead()
        }
    }

    public func eyePosition() -> Vec3 { Vec3(position.x, position.y + (crouching ? Self.crouchEye : Self.standEye), position.z) }
    public func chestPosition() -> Vec3 { Vec3(position.x, position.y + (crouching ? Self.chestCrouch : Self.chestStand), position.z) }

    public func hitTest(origin: Vec3, direction: Vec3, maxDistance: Double) -> CombatantHit? {
        hitTestHumanoid(feet: position, crouching: crouching, origin: origin, direction: direction, maxDistance: maxDistance)
    }

    /// The shooter's machine decided this hit. The body's owner applies it and reports back.
    public func applyDamage(_ info: DamageInfo) {
        if !alive { return }
        flinch(info.zone)
        options.onDamage(self, info)
    }

    /// Where a shot from this body should appear to start. The web asks the soldier visual for its
    /// rifle's muzzle; the sim has no visual, so it takes the sender's muzzle when it is near the
    /// eye and the eye otherwise (the web's own fallback).
    public func muzzle(fallback: Vec3) -> Vec3 {
        let eye = eyePosition()
        return fallback.distanceToSquared(eye) < 9 ? fallback : eye
    }

    public func fired() { firingTime = Self.firingPoseSeconds }

    public func flinch(_ zone: HitZone) {
        guard !dead else { return }
        flinches += 1
        flinchZone = zone
    }

    /// The owner reported this body's death.
    public func die(direction: Vec3, life: Int) {
        endedLife = max(endedLife, life)
        markDead()
        if fallen { return }
        fallen = true
        deathDirection = direction
    }

    /// `now`: this machine's clock in milliseconds. The body is shown `delayMs` behind it.
    public func update(_ dt: Double, now: Double) {
        if dead {
            corpseTime += dt
            return
        }
        let mode = buffer.sample(now - options.delayMs, into: &sampled)
        if mode == .empty { return }
        let pose = sampled
        position = Vec3(pose.x, pose.y, pose.z)
        velocity = Vec3(pose.vx, pose.vy, pose.vz)
        yaw = pose.yaw
        pitch = pose.pitch
        firingTime = max(0, firingTime - dt)
        footsteps()
    }

    private func revive() {
        lives += 1
        alive = true
        dead = false
        fallen = false
        corpseTime = 0
        stride = 0
        placed = false
    }

    private func markDead() {
        if dead { return }
        alive = false
        dead = true
        corpseTime = 0
        velocity = .zero
    }

    /// Count strides along the path the body is shown walking and emit a footstep for each.
    private func footsteps() {
        let travelled = jsHypot(position.x - last.x, position.z - last.z)
        let jumped = !placed || travelled > Self.teleportDistance
        last = position
        placed = true
        let speed = jsHypot(velocity.x, velocity.z)
        if jumped || !alive || !onGround || speed < Self.minStepSpeed {
            stride = min(stride, 0.5)
            return
        }
        stride += travelled / (running ? Self.strideRun : Self.strideWalk)
        if stride < 1 { return }
        stride -= 1
        // Crouch-walking is quiet enough to skip, as it is for the local player.
        if crouching { return }
        events.emit(.footstep(ownerId: id, position: position, surface: surfaceBelow(), running: running, local: false))
    }

    private func surfaceBelow() -> Surface {
        let probe = Vec3(position.x, position.y + 0.5, position.z)
        return world()?.raycast(origin: probe, direction: Vec3(0, -1, 0), maxDistance: 1.5)?.surface ?? .concrete
    }
}
