// Ported from src/ai/brain.ts and src/ai/tactics-util.ts at commit cbe0add.
import Foundation
import IronvaleSim
import IronvaleWorld

private let hitGuessError = 3.0
private let noiseErrorFraction = 0.1
private let radioRange = 150.0
private let radioDelay = 0.7
private let shareInterval = 0.4
private let hitReaction = 0.25
private let patrolRadiusMin = 4.0
private let patrolRadiusSpread = 8.0
private let investigateSeconds = 4.0
private let sweepJogBias = 0.3

/// One decision step for one soldier: sense, then act on the current state.
func think(_ bot: Bot, _ env: BotManager, _ dt: Double) {
    sense(bot, env, dt)
    if bot.inCombat {
        fight(bot, env, dt)
    } else if bot.awareness.alerted {
        bot.watch = .enemy
        chooseTactic(bot, env, bot.targetVisible ? "enemy spotted" : "alerted")
    } else {
        roam(bot, env, dt)
    }
}

private func sense(_ bot: Bot, _ env: BotManager, _ dt: Double) {
    let profile = bot.profile
    let target = nearestEnemy(bot, env)
    if target !== bot.target {
        bot.target = target
        bot.aim.reset()
    }

    var inView = false
    var distance = Double.infinity
    if let target, let world = env.world {
        let eye = bot.eyePosition()
        var chest = target.position
        chest.y += target.crouching ? Body.chestCrouch : Body.chestStand
        distance = eye.distance(to: chest)
        let targetSpeed = hypot(target.velocity.x, target.velocity.z)
        let range = effectiveVisionRange(profile.visionRange, fogDensity: env.fogDensity, targetCrouching: target.crouching, targetSpeed: targetSpeed)
        let half = bot.awareness.alerted ? Vision.halfAngleAlert : Vision.halfAngleCalm
        if distance < Vision.proximity
            || inVisionCone(eye: (eye.x, eye.y, eye.z), yaw: bot.yaw, target: (chest.x, chest.y, chest.z), halfAngle: half, range: range) {
            let chestInView = world.lineOfSight(eye, chest)
            inView = chestInView || world.lineOfSight(eye, target.eyePosition())
            bot.aimAtHead = inView && !chestInView
        }
    }
    let wasAlerted = bot.awareness.alerted
    let reaction = profile.reactionTime * (0.75 + 0.5 * min(1, distance / profile.visionRange))
    bot.awareness.update(dt, visible: inView, reactionTime: reaction, memorySeconds: profile.memorySeconds)
    bot.targetVisible = bot.awareness.canEngage

    if bot.targetVisible, let target {
        if bot.unseenTime > 2 { bot.aim.reset() }
        bot.unseenTime = 0
        bot.lastKnown = target.position
        bot.infoTime = env.time
        env.squad.report(botId: bot.id, botPosition: bot.position, enemyPosition: target.position, time: env.time)
        if !wasAlerted { env.callout(bot, .spotted) }
    } else if !(bot.phase == .hiding && (bot.state == .cover || bot.state == .fallback)) {
        bot.unseenTime += dt
    }

    if bot.hitPending {
        bot.hitPending = false
        bot.preferCover = true
        bot.tacticTimer = min(bot.tacticTimer, hitReaction)
        if !bot.targetVisible { learn(bot, env, bot.hitFrom, hitGuessError) }
        env.callout(bot, .hurt)
    }

    if bot.noisePending {
        bot.noisePending = false
        let underFire = bot.noiseKind == .nearMiss || bot.noiseKind == .impact
        if bot.targetVisible {
            if underFire { bot.tacticTimer = min(bot.tacticTimer, 1) }
        } else if bot.awareness.alerted || underFire {
            learn(bot, env, bot.noisePoint, bot.position.distance(to: bot.noisePoint) * noiseErrorFraction)
        } else {
            bot.investigatePending = true
        }
    }

    let squad = env.squad
    if !bot.targetVisible, squad.spotterId != bot.id, squad.contactTime > bot.infoTime + shareInterval,
       env.time - squad.contactStart >= radioDelay, bot.position.distanceToSquared(squad.spotterPosition) < radioRange * radioRange {
        bot.lastKnown = squad.lastKnown
        bot.infoTime = squad.contactTime
        bot.awareness.alert()
    }
}

private func nearestEnemy(_ bot: Bot, _ env: BotManager) -> (any Combatant)? {
    var best: (any Combatant)?
    var bestDistance = Double.infinity
    for enemy in env.enemies where enemy.alive {
        let distance = enemy.position.distanceToSquared(bot.position)
        if distance < bestDistance {
            bestDistance = distance
            best = enemy
        }
    }
    return best
}

/// Take `position`, blurred by `error` metres, as the enemy's last known position.
private func learn(_ bot: Bot, _ env: BotManager, _ position: Vec3, _ error: Double) {
    let angle = env.random() * Double.pi * 2
    let radius = env.random() * error
    bot.lastKnown = Vec3(position.x + cos(angle) * radius, position.y, position.z + sin(angle) * radius)
    bot.infoTime = env.time
    bot.awareness.alert()
}

/// Patrol near the post, or go and look at a noise.
private func roam(_ bot: Bot, _ env: BotManager, _ dt: Double) {
    bot.fireMode = .none
    bot.crouching = false
    if bot.investigatePending {
        bot.investigatePending = false
        bot.setState(.investigate, "heard \(bot.noiseKind.rawValue)")
        bot.watch = .point
        bot.watchPoint = bot.noisePoint
        bot.watchPoint.y += Body.chestStand
        bot.moveTo(bot.noisePoint.x, bot.noisePoint.y, bot.noisePoint.z, speed: Speed.jog)
        bot.idleTimer = investigateSeconds + env.random() * 3
        return
    }
    if bot.moving { return }
    bot.watch = .none
    lookAround(bot, env, dt)
    bot.idleTimer -= dt
    if bot.idleTimer > 0 { return }
    if bot.state == .investigate {
        bot.setState(.patrol, "nothing found")
        return
    }
    let bias = env.sweepBias(bot) * (bot.roleDef.holds ? 0.6 : 1)
    let lead = env.enemies.first?.position ?? bot.home
    let angle = env.random() * Double.pi * 2
    let radius = patrolRadiusMin + env.random() * patrolRadiusSpread
    let x = bot.home.x + (lead.x - bot.home.x) * bias + cos(angle) * radius
    let y = bot.home.y + (lead.y - bot.home.y) * bias
    let z = bot.home.z + (lead.z - bot.home.z) * bias + sin(angle) * radius
    let grid = env.grid
    let node = grid.nearestNode(x, y, z, maxRing: 4)
    if node < 0 || grid.wet[node] != 0 { return }
    let sweeping = bias > sweepJogBias
    bot.moveTo(grid.nodeX(node), grid.y(node), grid.nodeZ(node), speed: sweeping ? Speed.jog : Speed.walk)
    bot.idleTimer = (sweeping ? 0.5 : bot.roleDef.holds ? 5 : 2) + env.random() * (sweeping ? 1.5 : 4)
}

// MARK: - tactics-util

private let tacticMin = 3.5
private let tacticSpread = 4.0
private let turnMin = 4.0
private let turnSpread = 3.0
private let turnRest = 2.0

func flatDistance(_ a: Vec3, _ b: Vec3) -> Double { hypot(a.x - b.x, a.z - b.z) }

func tacticSeconds(_ env: BotManager) -> Double { tacticMin + env.random() * tacticSpread }

func lookAround(_ bot: Bot, _ env: BotManager, _ dt: Double) {
    bot.scanTimer -= dt
    if bot.scanTimer > 0 { return }
    bot.scanTimer = 1.2 + env.random() * 2.2
    bot.restYaw = wrapAngle(bot.restYaw + (env.random() - 0.5) * 2.6)
}

/// Only so many soldiers fire at once; the others wait for a turn.
func takeFireTurn(_ bot: Bot, _ env: BotManager) -> Bool {
    let squad = env.squad
    let time = env.time
    if bot.fireTurnUntil > time { return true }
    let cap = bot.profile.attackers
    let contested = squad.engaging + squad.pushing + squad.flanking > cap
    if squad.firing >= cap || (contested && time < bot.fireTurnAgain) { return false }
    bot.fireTurnUntil = time + turnMin + env.random() * turnSpread
    bot.fireTurnAgain = bot.fireTurnUntil + turnRest
    squad.firing += 1
    return true
}

/// Can the soldier (as it is, or standing up) see the chest-high point above `position`?
func canSeePoint(_ bot: Bot, _ env: BotManager, _ position: Vec3, standing: Bool) -> Bool {
    guard let world = env.world else { return false }
    var point = position
    point.y += Body.chestStand
    var eye = bot.eyePosition()
    if standing { eye.y = bot.position.y + Body.standEye }
    return world.lineOfSight(eye, point)
}
