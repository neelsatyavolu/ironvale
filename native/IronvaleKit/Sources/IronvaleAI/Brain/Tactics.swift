// Ported from src/ai/tactics.ts at commit cbe0add.
import Foundation

private let coverRadius = 12.0
private let holdCoverRadius = 10.0
private let reloadCoverRadius = 8.0
private let advanceRadius = 10.0
private let relocateAfter = 8.0
private let suppressMin = 1.2
private let suppressSpread = 1.5
private let hurtFraction = 0.35
private let huntAfter = 3.0
private let pushSlack = 1.3
private let flankMinDistance = 12.0
private let turnRelease = 1.5

/// One decision step while the soldier knows about an enemy.
func fight(_ bot: Bot, _ env: BotManager, _ dt: Double) {
    if !bot.awareness.alerted {
        bot.fireMode = .none
        bot.coverNode = -1
        bot.crouching = false
        bot.watch = .none
        bot.setState(.investigate, "lost the enemy")
        bot.moveTo(bot.lastKnown.x, bot.lastKnown.y, bot.lastKnown.z, speed: Speed.walk)
        bot.idleTimer = 4
        return
    }
    bot.watch = .enemy
    if !bot.targetVisible, bot.unseenTime > turnRelease { bot.fireTurnUntil = -.infinity }
    bot.fireMode = bot.targetVisible && takeFireTurn(bot, env) ? .target : .none
    bot.tacticTimer -= dt
    bot.phaseTimer -= dt
    if !bot.fellBack, bot.health < bot.maxHealth * hurtFraction {
        startFallback(bot, env)
        return
    }
    let reloading = bot.weapon.reloading
    if reloading, !bot.soughtReloadCover, bot.state == .strafe || bot.state == .hold || bot.state == .suppress {
        bot.soughtReloadCover = true
        if startCover(bot, env, CoverOrder(radius: reloadCoverRadius), "reloading") { return }
    }
    if !reloading { bot.soughtReloadCover = false }
    if let rethink = step(bot, env, dt) { chooseTactic(bot, env, rethink) }
}

private func step(_ bot: Bot, _ env: BotManager, _ dt: Double) -> String? {
    switch bot.state {
    case .cover: inCover(bot, env)
    case .strafe: inStrafe(bot, env)
    case .push: inPush(bot, env)
    case .flank: inFlank(bot, env)
    case .suppress: inSuppress(bot, env)
    case .fallback: inFallback(bot, env)
    case .hold: inHold(bot, env, dt)
    default: nil
    }
}

/// Pick what to do next in a fight; the first rule that applies wins.
func chooseTactic(_ bot: Bot, _ env: BotManager, _ why: String) {
    let squad = env.squad
    let role = bot.roleDef
    let profile = bot.profile
    let distance = flatDistance(bot.position, bot.lastKnown)
    let seen = bot.targetVisible
    let hit = bot.preferCover
    let wantCover = hit || env.random() < profile.coverUse
    let mayAdvance = bot.state == .push || squad.canPush(profile.pushFraction)
    bot.preferCover = false
    bot.failedPeeks = 0
    bot.tacticTimer = tacticSeconds(env)

    if hit, startCover(bot, env, CoverOrder(radius: coverRadius), why) { return }

    if !seen, bot.unseenTime > 0.6, bot.unseenTime < huntAfter, bot.state != .suppress, bot.role != .marksman,
       bot.weapon.magazine > 4, !bot.weapon.reloading, canSeePoint(bot, env, bot.lastKnown, standing: false) {
        bot.halt()
        bot.phaseTimer = suppressMin + env.random() * suppressSpread
        bot.setState(.suppress, why)
        return
    }

    let lost = !seen && bot.unseenTime > huntAfter
    let far = distance > role.maxRange

    if role.holds {
        if distance < role.minRange {
            if !startCover(bot, env, CoverOrder(radius: retreatCoverRadius, range: role.idealRange), why) { startHold(bot, why) }
            return
        }
        if far || (!seen && bot.unseenTime > relocateAfter) {
            let approach = max(role.minRange + 5, min(role.idealRange, distance * 0.7))
            if startCover(bot, env, CoverOrder(radius: advanceRadius, range: approach, approach: approach, needSight: true), why) { return }
        }
        let exposed = bot.coverNode < 0 || coverAgainst(env.grid, bot.coverNode, bot.lastKnown.x, bot.lastKnown.z) == 0
        if !exposed, bot.state == .cover { return }
        if wantCover, startCover(bot, env, CoverOrder(radius: holdCoverRadius, needSight: true), why) { return }
        startHold(bot, why)
        return
    }

    if role.pushes, distance > role.idealRange * pushSlack, mayAdvance {
        startPush(bot, Speed.run, why)
        return
    }

    if !role.pushes, bot.state != .flank, distance > flankMinDistance, squad.canFlank(), env.random() < profile.flankChance,
       startFlank(bot, env, why) {
        return
    }

    if lost || far {
        if lost, !role.pushes, squad.pushing == 0 {
            startPush(bot, Speed.jog, why)
            return
        }
        if !far, canSeePoint(bot, env, bot.lastKnown, standing: true) {
            if bot.state != .cover { startHold(bot, why) }
            return
        }
        let approach = role.pushes ? role.maxRange : role.idealRange
        if startCover(bot, env, CoverOrder(radius: advanceRadius, range: approach, approach: approach, needSight: true), why) { return }
        if startCover(bot, env, CoverOrder(radius: advanceRadius, range: approach, approach: approach), why) { return }
        startHold(bot, why)
        return
    }

    if wantCover, startCover(bot, env, CoverOrder(radius: coverRadius, range: role.idealRange), why) { return }
    startStrafe(bot, why)
}
