// Ported from src/ai/body.ts and src/ai/bot.ts at commit cbe0add: the walking capsule (BotBody) and
// the soldier on top of it (Bot) are one class here. The brain (Brain.swift, Tactics*.swift) writes
// the public fields a few times a second; `update` carries them out every frame.
//
// One deliberate difference: the web takes the shot origin from the posed carbine
// (`visual.muzzleWorld()`); the native AI is renderer-free, so the muzzle is a fixed point ahead of
// the eye along the aim (`muzzleOffset`), and the web's own sanity rules still apply (a muzzle more
// than 1.5 m from the eye or behind a wall falls back to the eye).
import Foundation
import IronvaleContract
import IronvaleCore
import IronvaleSim
import IronvaleWorld

/// Body measurements, the same as the player's.
public enum Body {
    public static let radius = 0.34
    public static let standHeight = 1.8
    public static let crouchHeight = 1.2
    public static let standEye = 1.64
    public static let crouchEye = 1.08
    public static let chestStand = 1.2
    public static let chestCrouch = 0.75
}

/// Movement speeds in m/s, before the weapon's mobility.
public enum Speed {
    public static let walk = 1.7
    public static let jog = 3.4
    public static let run = 5.2
    public static let crouch = 1.8
    public static let strafe = 2.6
}

private let acceleration = 22.0
private let gravity = 17.5
private let strideWalk = 1.55
private let strideRun = 2.1
private let arriveDistance = 0.15
private let cornerDistance = 0.45
private let goalTolerance = 1.6
private let stuckInterval = 0.75
private let stuckDistance = 0.2
private let maxRepaths = 3
private let separation = 0.85

private let deg = Double.pi / 180
private let fireArc = 9 * deg
private let firingPoseSeconds = 0.12
private let muzzleReach = 1.5
private let flinchDegrees = 2.5
private let mateClearance = 0.8
private let mateCone = 0.06
private let pitchLimit = 60 * deg
/// Muzzle ahead of the eye along the aim, right of it and below it, in metres (renderer-free stand-in).
private let muzzleOffset = (forward: 0.62, right: 0.08, down: 0.1)

public enum FireMode: Sendable { case none, target, lastKnown }
public enum Watch: String, Sendable { case none, enemy, point }
public enum Phase: Sendable { case moving, hiding, peeking }

public final class Bot: Combatant, SquadMember {
    public let kind = CombatantKind.bot
    public let id: Int
    public let team: Team
    public let uniform: Team
    public let name: String
    public let role: BotRole
    public let roleDef: RoleDef
    public let profile: DifficultyProfile
    public let weaponDef: WeaponDef
    public internal(set) var weapon: BotWeapon
    public internal(set) var aim: AimModel
    public internal(set) var awareness = Awareness()
    public let maxHealth: Double
    public internal(set) var health: Double
    public internal(set) var yaw: Double

    // ---- body
    public internal(set) var position: Vec3
    public internal(set) var velocity = Vec3.zero
    let path = PathHandle()
    public internal(set) var goal = Vec3.zero
    public internal(set) var home: Vec3
    public internal(set) var alive = true
    public internal(set) var crouching = false
    public internal(set) var moving = false
    var arrived = false
    var pathFailed = false
    public internal(set) var onGround = false
    var moveSpeed = 0.0
    private var waypoint = 0
    private var wishX = 0.0, wishZ = 0.0
    private var stuckTimer = 0.0
    private var stuckCount = 0
    private var repaths = 0
    private var stuckFrom = Vec3.zero
    private var surface = Surface.concrete
    private var stride = 0.0
    private let mobility: Double

    // ---- set by the brain
    public internal(set) var state = BotState.patrol
    var stateTime = 0.0
    public internal(set) var target: (any Combatant)?
    public internal(set) var targetVisible = false
    var aimAtHead = false
    var unseenTime = Double.infinity
    var sightedTime = 0.0
    var lastKnown = Vec3.zero
    var infoTime = -Double.infinity
    var fireMode = FireMode.none
    public internal(set) var watch = Watch.none
    var watchPoint = Vec3.zero
    var restYaw: Double
    public internal(set) var coverNode = -1
    var tacticTimer = 0.0
    public internal(set) var phase = Phase.moving
    var phaseTimer = 0.0
    var idleTimer = 0.0
    var scanTimer = 0.0
    var thinkTimer = 0.0
    var lastThink = 0.0
    var fireTurnUntil = -Double.infinity
    var fireTurnAgain = -Double.infinity
    var fellBack = false
    var soughtReloadCover = false
    var preferCover = false
    var strafeSide = 1.0
    var failedPeeks = 0

    // ---- stimuli
    var noisePending = false
    var investigatePending = false
    var noiseKind = NoiseKind.shot
    var noisePoint = Vec3.zero
    var hitPending = false
    var hitFrom = Vec3.zero

    public internal(set) var corpseTime = 0.0
    private var aimPitch = 0.0
    private var firingTime = 0.0
    private var yawError = 0.0
    private var aimPoint = Vec3.zero
    // ---- what the renderer reads
    private var deathDirection: Vec3?
    private var hits = 0
    private var lastHitZone: HitZone?
    private let life: Int
    /// Shots fired this life (for stats and tests).
    public private(set) var shotsFired = 0

    unowned let env: BotManager

    init(env: BotManager, id: Int, team: Team, uniform: Team, name: String, role: BotRole, difficulty: String,
         spawn: Vec3, yaw: Double, life: Int) {
        self.env = env
        self.id = id
        self.team = team
        self.uniform = uniform
        self.name = name
        self.role = role
        let roleDef = env.roleDef(role)
        let profile = env.profile(difficulty)
        let weaponDef = env.weapon(roleDef.weapon, difficulty: difficulty)
        self.roleDef = roleDef
        self.profile = profile
        self.weaponDef = weaponDef
        mobility = weaponDef.mobility
        weapon = BotWeapon(
            def: weaponDef,
            timing: BurstTiming(
                burstMin: max(1, Int(JS.round(Double(roleDef.burstMin) * profile.burstLength))),
                burstMax: max(1, Int(JS.round(Double(roleDef.burstMax) * profile.burstLength))),
                pauseMin: roleDef.pauseMin * profile.burstPause,
                pauseMax: roleDef.pauseMax * profile.burstPause
            ),
            random: { [unowned env] in env.random() }
        )
        aim = AimModel(profile: profile)
        maxHealth = profile.health
        health = profile.health
        position = spawn
        home = spawn
        self.yaw = yaw
        restYaw = yaw
        self.life = life
    }

    public var firing: Bool { alive && fireTurnUntil > env.time }
    public var pitch: Double { aimPitch }
    public var speed: Double { hypot(velocity.x, velocity.z) }
    var inCombat: Bool { state != .patrol && state != .investigate && state != .dead }

    public func eyePosition() -> Vec3 {
        Vec3(position.x, position.y + (crouching ? Body.crouchEye : Body.standEye), position.z)
    }

    public func hitTest(origin: Vec3, direction: Vec3, maxDistance: Double) -> CombatantHit? {
        hitTestHumanoid(feet: position, crouching: crouching, origin: origin, direction: direction, maxDistance: maxDistance)
    }

    public func applyDamage(_ info: DamageInfo) {
        if !alive { return }
        let attacker = env.game.combat.get(info.attackerId)
        // Stray rounds from the squad's own crossfire do not hurt.
        if let attacker, attacker.team == team { return }
        health = max(0, health - info.amount)
        if health <= 0 {
            die(info)
            return
        }
        hits += 1
        lastHitZone = info.zone
        aim.disturb(flinchDegrees)
        if let attacker {
            hitPending = true
            hitFrom = attacker.position
        }
    }

    /// Take in a noise for the next think; the more urgent kind wins.
    func hear(_ kind: NoiseKind, _ point: Vec3) {
        if noisePending, kind.urgency < noiseKind.urgency { return }
        noisePending = true
        noiseKind = kind
        noisePoint = point
    }

    func setState(_ next: BotState, _ reason: String) {
        if next == state { return }
        env.transition(self, from: state, to: next, reason: reason)
        state = next
        stateTime = 0
    }

    func update(_ dt: Double) {
        if !alive {
            corpseTime += dt
            return
        }
        stateTime += dt
        steer(dt)
        integrate(dt)
        footsteps(dt)
        face(dt)
        shoot(dt)
    }

    /// The pose the renderer draws (`syncVisual`).
    public var actor: SoldierActor {
        SoldierActor(id: id, kind: .bot, team: team, uniform: uniform, position: position, yaw: yaw, pitch: aimPitch, speed: speed,
                     crouching: crouching, aiming: watch == .enemy, firing: firingTime > 0, reloading: weapon.reloading,
                     alive: alive, deathDirection: deathDirection, hits: hits, lastHitZone: lastHitZone, life: life)
    }

    // MARK: - body

    func moveTo(_ x: Double, _ y: Double, _ z: Double, speed: Double, avoid: PathAvoid? = nil) {
        goal = Vec3(x, y, z)
        beginMove(speed)
        repaths = 0
        env.paths.request(path, start: (position.x, position.y, position.z), goal: (x, y, z), avoid: avoid)
    }

    /// Step straight to a nearby point the caller knows is reachable.
    func moveDirect(_ x: Double, _ y: Double, _ z: Double, speed: Double) {
        if path.status == .queued { env.paths.cancel(path) }
        goal = Vec3(x, y, z)
        beginMove(speed)
        repaths = maxRepaths
        path.setDirect(x, y, z)
    }

    func halt() {
        if path.status == .queued { env.paths.cancel(path) }
        moving = false
    }

    private func beginMove(_ speed: Double) {
        moveSpeed = speed
        moving = true
        arrived = false
        pathFailed = false
        waypoint = 0
        stuckTimer = 0
        stuckCount = 0
        stuckFrom = position
    }

    private func steer(_ dt: Double) {
        wishX = 0
        wishZ = 0
        if moving { followPath(dt) }
        for other in env.bots where other.id != id && other.alive {
            let dx = position.x - other.position.x
            let dz = position.z - other.position.z
            let distance = hypot(dx, dz)
            if distance >= separation || distance < 1e-4 || abs(position.y - other.position.y) > 1.5 { continue }
            let push = ((separation - distance) / distance) * 3
            wishX += dx * push
            wishZ += dz * push
        }
    }

    private func followPath(_ dt: Double) {
        if path.status == .queued { return }
        if path.status != .ready {
            moving = false
            pathFailed = true
            return
        }
        var dx = 0.0, dz = 0.0, distance = 0.0
        while waypoint < path.count {
            let p = path.point(waypoint)
            dx = p.x - position.x
            dz = p.z - position.z
            distance = hypot(dx, dz)
            if distance > (waypoint == path.count - 1 ? arriveDistance : cornerDistance) { break }
            waypoint += 1
        }
        if waypoint >= path.count {
            let short = hypot(goal.x - position.x, goal.z - position.z) > goalTolerance
            if path.partial, short, repaths < maxRepaths {
                repath()
                return
            }
            moving = false
            arrived = !short
            pathFailed = short
            return
        }
        let last = waypoint == path.count - 1
        var speed = moveSpeed * mobility
        if crouching { speed = min(speed, Speed.crouch) }
        if last { speed *= MathUtils.clamp(distance / 0.8, 0.4, 1) }
        wishX = (dx / distance) * speed
        wishZ = (dz / distance) * speed

        stuckTimer += dt
        if stuckTimer < stuckInterval { return }
        stuckTimer = 0
        let moved = stuckFrom.distance(to: position)
        stuckFrom = position
        if moved >= stuckDistance {
            stuckCount = 0
        } else {
            stuckCount += 1
            if stuckCount >= maxRepaths || repaths >= maxRepaths {
                moving = false
                pathFailed = true
            } else {
                repath()
            }
        }
    }

    private func repath() {
        repaths += 1
        waypoint = 0
        env.paths.request(path, start: (position.x, position.y, position.z), goal: (goal.x, goal.y, goal.z))
    }

    private func integrate(_ dt: Double) {
        let wishing = wishX != 0 || wishZ != 0
        if !wishing, onGround, speed < 0.05 {
            velocity = .zero
            return
        }
        guard let world = env.world else { return }
        let ax = wishX - velocity.x
        let az = wishZ - velocity.z
        let change = hypot(ax, az)
        let limit = acceleration * dt
        let scale = change > limit ? limit / change : 1
        velocity.x += ax * scale
        velocity.z += az * scale
        velocity.y -= gravity * dt
        let height = crouching ? Body.crouchHeight : Body.standHeight
        let result = world.moveCapsule(position: position, velocity: velocity, dt: dt, radius: Body.radius, height: height)
        position = result.position
        velocity = result.velocity
        onGround = result.onGround
        if let ground = result.groundSurface { surface = ground }
        if onGround, velocity.y < 0 { velocity.y = 0 }
        // Fell out of the level: back to the last place the soldier meant to be.
        if position.y < world.bounds.min.y - 10 {
            position = home
            velocity = .zero
        }
    }

    private func footsteps(_ dt: Double) {
        let speed = speed
        if !onGround || speed < 0.8 {
            stride = min(stride, 0.5)
            return
        }
        let running = speed > Speed.jog + 0.6
        stride += (speed * dt) / (running ? strideRun : strideWalk)
        if stride < 1 { return }
        stride -= 1
        if crouching { return }
        env.game.events.emit(.footstep(ownerId: id, position: position, surface: surface, running: running, local: false))
    }

    // MARK: - soldier

    private func face(_ dt: Double) {
        var desired = restYaw
        var pitch = 0.0
        if watch != .none {
            var point: Vec3
            if watch == .point {
                point = watchPoint
            } else if targetVisible, let target {
                if aimAtHead {
                    point = target.eyePosition()
                } else {
                    point = target.position
                    point.y += target.crouching ? Body.chestCrouch : Body.chestStand
                }
            } else {
                point = lastKnown
                point.y += Body.chestStand
            }
            aimPoint = point
            let dx = point.x - position.x
            let dz = point.z - position.z
            desired = atan2(-dx, -dz)
            let eyeHeight = position.y + (crouching ? Body.crouchEye : Body.standEye)
            pitch = MathUtils.clamp(atan2(point.y - eyeHeight, hypot(dx, dz)), -pitchLimit, pitchLimit)
        } else if speed > 0.4 {
            desired = atan2(-velocity.x, -velocity.z)
        }
        let difference = wrapAngle(desired - yaw)
        let size = abs(difference)
        let rate = profile.turnRate * deg * MathUtils.clamp(size / 0.5, 0.25, 1)
        let turn = min(size, rate * dt)
        yaw = wrapAngle(yaw + jsSign(difference) * turn)
        yawError = size - turn
        aimPitch = MathUtils.damp(aimPitch, pitch, 10, dt)
    }

    /// The renderer-free muzzle: ahead of the eye along the bot's yaw and aim pitch.
    func muzzleWorld() -> Vec3 {
        let eye = eyePosition()
        let forward = Vec3(-sin(yaw) * cos(aimPitch), sin(aimPitch), -cos(yaw) * cos(aimPitch))
        let right = Vec3(cos(yaw), 0, -sin(yaw))
        return eye.adding(forward, scaledBy: muzzleOffset.forward).adding(right, scaledBy: muzzleOffset.right)
            .adding(Vec3(0, -1, 0), scaledBy: muzzleOffset.down)
    }

    private func shoot(_ dt: Double) {
        let tracking = fireMode == .target && targetVisible && (target?.alive ?? false)
        aim.update(dt, tracking: tracking)
        sightedTime = tracking ? sightedTime + dt : 0
        let ready = !tracking || readyToFire(weaponDef, sightedTime: sightedTime, reactionTime: profile.reactionTime)
        let wantsFire = (tracking || fireMode == .lastKnown) && watch == .enemy && ready
        let fired = weapon.update(dt, trigger: wantsFire && yawError < fireArc && !mateInLine())
        if weapon.reloadStarted {
            env.callout(self, .reloading)
            emitAction(weaponDef.reloadStyle == "belt" ? "beltOpen" : "magOut")
        }
        if weapon.reloadFinished { emitAction(weaponDef.reloadStyle == "belt" ? "beltClose" : "magIn") }
        firingTime = fired ? firingPoseSeconds : max(0, firingTime - dt)
        guard fired, let world = env.world else { return }

        let eye = eyePosition()
        var muzzle = muzzleWorld()
        // Never start a bullet from a muzzle that is stale or poking through a wall, and when the eye
        // has the target but the gun is still below the cover, shoot from the eye.
        let usable = muzzle.distanceToSquared(eye) < muzzleReach * muzzleReach && world.lineOfSight(eye, muzzle)
        if !usable || (tracking && !world.lineOfSight(muzzle, aimPoint)) { muzzle = eye }
        var direction = aimPoint - muzzle
        let distance = direction.length
        if distance < 1e-3 { return }
        direction = direction.divided(by: distance)
        var crossing = 0.0
        if tracking, let target {
            let along = target.velocity.dot(direction)
            let across = max(0, target.velocity.lengthSq - along * along).squareRoot()
            crossing = (across / distance) / deg
        }
        let spread = botShotSpread(weaponDef, aimSpread: aim.spread(targetAngularSpeed: crossing, moving: speed > 1),
                                   distance: distance, minRange: roleDef.minRange)
        shotsFired += 1
        env.game.ballistics.fire(shooter: self, weapon: weaponDef, muzzle: muzzle, direction: direction, spreadDegrees: spread)
    }

    /// true when a squad mate stands in or near the line of fire.
    private func mateInLine() -> Bool {
        let ax = position.x, az = position.z
        let dx = aimPoint.x - ax, dz = aimPoint.z - az
        let lengthSq = dx * dx + dz * dz
        if lengthSq < 1e-6 { return false }
        let length = lengthSq.squareRoot()
        for other in env.bots where other.id != id && other.alive && abs(other.position.y - position.y) <= 2.5 {
            let t = ((other.position.x - ax) * dx + (other.position.z - az) * dz) / lengthSq
            if t <= 0 || t >= 1 { continue }
            let off = hypot(other.position.x - (ax + dx * t), other.position.z - (az + dz * t))
            if off < mateClearance + t * length * mateCone { return true }
        }
        return false
    }

    private func emitAction(_ stage: String) {
        var at = position
        at.y += Body.chestStand
        env.game.events.emit(.weaponAction(shooterId: id, weapon: weaponDef.id, stage: stage, position: at, local: false))
    }

    private func die(_ info: DamageInfo) {
        let from = state
        alive = false
        state = .dead
        env.transition(self, from: from, to: .dead, reason: "killed by \(info.weaponId)")
        halt()
        fireMode = .none
        velocity = .zero
        coverNode = -1
        deathDirection = info.direction
        env.game.events.emit(.died(victimId: id, killerId: info.attackerId, weaponId: info.weaponId, headshot: info.zone == .head))
        env.callout(self, .death)
    }
}

/// Wrap an angle to -PI .. PI (`wrapAngle` in bot.ts, with JS `%`).
public func wrapAngle(_ angle: Double) -> Double {
    let wrapped = fmod(angle + Double.pi, Double.pi * 2)
    return (wrapped < 0 ? wrapped + Double.pi * 2 : wrapped) - Double.pi
}

/// `Math.sign`.
func jsSign(_ x: Double) -> Double { x > 0 ? 1 : x < 0 ? -1 : x }

