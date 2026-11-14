// Ported from src/ai/tactics-cover.ts at commit cbe0add.
import Foundation
import IronvaleWorld

private let coverTries = 4
private let longMove = 18.0
/// How far a soldier will run for cover when backing off.
let retreatCoverRadius = 24.0
private let minCoverDistance = 5.0
private let flushDistance = 5.0
private let hideMin = 0.7
private let hideSpread = 1.3
private let peekMin = 1.5
private let peekSpread = 1.8
private let holderPeekFactor = 1.8
private let topUpFraction = 0.4
private let recoverMin = 5.0
private let recoverSpread = 3.0
private let retreatDistance = 12.0
private let turnWait = 0.5

struct CoverOrder {
    var radius: Double
    var range: Double?
    var approach: Double?
    var needSight = false
}

/// Run to the best cover the order allows. Returns false when there is none.
func startCover(_ bot: Bot, _ env: BotManager, _ order: CoverOrder, _ why: String) -> Bool {
    let grid = env.grid
    let position = bot.position
    let threat = bot.lastKnown
    let distance = flatDistance(position, threat)
    let approach = order.approach ?? 0
    let scale = approach > 0 && distance > approach ? approach / distance : 1
    var query = CoverQuery()
    query.x = threat.x + (position.x - threat.x) * scale
    query.y = position.y
    query.z = threat.z + (position.z - threat.z) * scale
    query.threatX = threat.x
    query.threatZ = threat.z
    query.radius = order.radius
    query.minThreatDistance = max(minCoverDistance, bot.roleDef.minRange)
    query.idealThreatDistance = order.range
    query.taken = env.squad.takenCover
    query.exclude = bot.coverNode
    var rejected: [Int] = []
    query.skip = rejected
    var node = findCover(grid, query)
    var tries = 1
    while node >= 0, !(hides(env, node, threat) && (!order.needSight || overlooks(env, node, threat))) {
        rejected.append(node)
        query.skip = rejected
        node = tries < coverTries ? findCover(grid, query) : -1
        tries += 1
    }
    if node < 0 { return false }
    bot.coverNode = node
    bot.phase = .moving
    bot.crouching = false
    bot.setState(.cover, why)
    let x = grid.nodeX(node)
    let z = grid.nodeZ(node)
    let speed = hypot(x - position.x, z - position.z) > longMove ? Speed.jog : Speed.run
    bot.moveTo(x, grid.y(node), z, speed: speed)
    return true
}

/// Is a soldier crouching at `node` out of sight of an enemy standing at `threat`?
private func hides(_ env: BotManager, _ node: Int, _ threat: Vec3) -> Bool {
    guard let world = env.world else { return false }
    let grid = env.grid
    let eye = Vec3(grid.nodeX(node), grid.y(node) + Body.crouchEye, grid.nodeZ(node))
    var point = threat
    point.y += Body.standEye
    if world.lineOfSight(eye, point) { return false }
    point.y += Body.chestStand - Body.standEye
    return !world.lineOfSight(eye, point)
}

/// Does a soldier standing at (or stepping out from) `node` see the chest-high point above `target`?
private func overlooks(_ env: BotManager, _ node: Int, _ target: Vec3) -> Bool {
    guard let world = env.world else { return false }
    let grid = env.grid
    if coverAgainst(grid, node, target.x, target.z) == 2 { return true }
    let eye = Vec3(grid.nodeX(node), grid.y(node) + Body.standEye, grid.nodeZ(node))
    var point = target
    point.y += Body.chestStand
    return world.lineOfSight(eye, point)
}

/// Fight from cover: duck, pop out for a burst or two, duck again. Reload while down.
func inCover(_ bot: Bot, _ env: BotManager) -> String? {
    let grid = env.grid
    if bot.phase == .moving {
        if bot.pathFailed {
            bot.coverNode = -1
            return "cover unreachable"
        }
        if !bot.arrived { return nil }
        hide(bot, env)
        return nil
    }
    let kind = coverAgainst(grid, bot.coverNode, bot.lastKnown.x, bot.lastKnown.z)
    let close = flatDistance(bot.position, bot.lastKnown) < flushDistance
    let exposed = kind == 0 || (bot.phase == .hiding && bot.crouching && bot.targetVisible && !bot.moving)
    if exposed || close || (bot.tacticTimer <= 0 && !bot.weapon.reloading) {
        return exposed ? "cover exposed" : close ? "enemy close" : "reposition"
    }
    if bot.weapon.reloading {
        if bot.phase != .hiding { hide(bot, env) }
        return nil
    }
    if bot.phase == .hiding {
        bot.crouching = true
        bot.fireMode = .none
        if Double(bot.weapon.magazine) < Double(bot.weapon.def.magazineSize) * topUpFraction { bot.weapon.startReload() }
        if bot.phaseTimer > 0 { return nil }
        if !takeFireTurn(bot, env) {
            bot.phaseTimer = turnWait
            return nil
        }
        if kind == 2 {
            let peek = findPeek(bot, env)
            if peek < 0 {
                bot.failedPeeks += 1
                if bot.failedPeeks >= 2 { return "no firing position" }
                bot.phaseTimer = hideMin
                return nil
            }
            bot.moveDirect(grid.nodeX(peek), grid.y(peek), grid.nodeZ(peek), speed: Speed.strafe)
        }
        let holder = bot.roleDef.holds ? holderPeekFactor : 1
        bot.phase = .peeking
        bot.phaseTimer = (peekMin + env.random() * peekSpread) * holder * bot.profile.burstPause
        bot.crouching = false
        return nil
    }
    bot.crouching = false
    if bot.phaseTimer <= 0 { hide(bot, env) }
    return nil
}

private func hide(_ bot: Bot, _ env: BotManager) {
    let grid = env.grid
    bot.phase = .hiding
    bot.phaseTimer = (hideMin + env.random() * hideSpread) * bot.profile.burstPause
    bot.crouching = true
    bot.fireMode = .none
    let node = bot.coverNode
    if node < 0 { return }
    let x = grid.nodeX(node)
    let z = grid.nodeZ(node)
    if hypot(x - bot.position.x, z - bot.position.z) > 0.4 {
        bot.moveDirect(x, grid.y(node), z, speed: Speed.strafe)
    }
}

/// Nearest cell beside the cover cell from which a standing soldier is no longer hidden.
private func findPeek(_ bot: Bot, _ env: BotManager) -> Int {
    let grid = env.grid
    let cover = bot.coverNode
    let cx = grid.nodeX(cover)
    let cz = grid.nodeZ(cover)
    let y = grid.y(cover)
    var best = -1
    var bestDistance = Int.max
    for iz in -2 ... 2 {
        for ix in -2 ... 2 {
            if ix == 0, iz == 0 { continue }
            let node = grid.nodeAt(cx + Double(ix) * grid.cell, y, cz + Double(iz) * grid.cell)
            if node < 0 || abs(grid.y(node) - y) > 0.6 { continue }
            let distance = ix * ix + iz * iz
            if distance >= bestDistance { continue }
            if coverAgainst(grid, node, bot.lastKnown.x, bot.lastKnown.z) == 2 { continue }
            if !grid.walkLine(cover, node) { continue }
            bestDistance = distance
            best = node
        }
    }
    return best
}

func startFallback(_ bot: Bot, _ env: BotManager) {
    let grid = env.grid
    let position = bot.position
    let distance = flatDistance(position, bot.lastKnown)
    bot.fellBack = true
    bot.fireMode = .none
    bot.crouching = false
    env.callout(bot, .hurt)
    var query = CoverQuery()
    query.x = position.x
    query.y = position.y
    query.z = position.z
    query.threatX = bot.lastKnown.x
    query.threatZ = bot.lastKnown.z
    query.radius = retreatCoverRadius
    query.minThreatDistance = distance + 2
    query.idealThreatDistance = distance + retreatDistance
    query.taken = env.squad.takenCover
    query.exclude = bot.coverNode
    var node = findCover(grid, query)
    bot.coverNode = node
    if node < 0, distance > 1e-3 {
        let scale = retreatDistance / distance
        node = grid.nearestNode(position.x + (position.x - bot.lastKnown.x) * scale, position.y,
                                position.z + (position.z - bot.lastKnown.z) * scale, maxRing: 5)
        if node >= 0, grid.wet[node] != 0 { node = -1 }
    }
    bot.phase = .moving
    bot.setState(.fallback, "badly hurt")
    if node >= 0 { bot.moveTo(grid.nodeX(node), grid.y(node), grid.nodeZ(node), speed: Speed.run) } else { bot.halt() }
}

/// Break contact, get down and stay down for a few seconds, then rejoin the fight from there.
func inFallback(_ bot: Bot, _ env: BotManager) -> String? {
    let close = bot.targetVisible && flatDistance(bot.position, bot.lastKnown) < 10
    bot.fireMode = close ? .target : .none
    if bot.phase == .moving {
        if bot.moving { return nil }
        bot.phase = .hiding
        bot.phaseTimer = recoverMin + env.random() * recoverSpread
        bot.weapon.startReload()
    }
    bot.crouching = true
    if bot.phaseTimer > 0 { return nil }
    if bot.coverNode < 0 { return "recovered" }
    bot.tacticTimer = tacticSeconds(env)
    bot.setState(.cover, "recovered")
    hide(bot, env)
    return nil
}
