// Ported from src/ai/tactics-open.ts at commit cbe0add.
import Foundation
import IronvaleSim

private let lostSeconds = 1.5
private let repathSeconds = 1.2
private let flankMaxSeconds = 25.0
private let flankAngleMin = 75 * Double.pi / 180
private let flankAngleSpread = 40 * Double.pi / 180

func startStrafe(_ bot: Bot, _ why: String) {
    bot.halt()
    bot.coverNode = -1
    bot.crouching = false
    bot.phaseTimer = 0
    bot.setState(.strafe, why)
}

/// No cover: keep moving sideways while firing, drifting toward the role's range.
func inStrafe(_ bot: Bot, _ env: BotManager) -> String? {
    bot.crouching = bot.weapon.reloading
    if bot.crouching { return nil }
    let lostSight = bot.unseenTime > lostSeconds
    if bot.tacticTimer <= 0 || lostSight { return lostSight ? "lost sight" : "reposition" }
    if bot.moving || bot.phaseTimer > 0 { return nil }
    bot.phaseTimer = 0.3 + env.random() * 0.9
    let grid = env.grid
    let position = bot.position
    let dx = bot.lastKnown.x - position.x
    let dz = bot.lastKnown.z - position.z
    let distance = hypot(dx, dz)
    if distance < 1e-3 { return nil }
    let role = bot.roleDef
    let advance = distance > role.idealRange + 6 ? 2.5 : distance < role.minRange ? -3 : 0
    if env.random() < 0.3 { bot.strafeSide = -bot.strafeSide }
    let side = bot.strafeSide * (1.8 + env.random() * 2.2)
    let x = position.x + (dx / distance) * advance - (dz / distance) * side
    let z = position.z + (dz / distance) * advance + (dx / distance) * side
    let from = grid.nodeAt(position.x, position.y, position.z)
    let to = grid.nodeAt(x, position.y, z)
    if from >= 0, to >= 0, grid.walkLine(from, to) {
        bot.moveDirect(x, grid.y(to), z, speed: Speed.strafe)
    } else {
        bot.strafeSide = -bot.strafeSide
    }
    return nil
}

func startHold(_ bot: Bot, _ why: String) {
    bot.halt()
    bot.coverNode = -1
    bot.setState(.hold, why)
}

/// Stay put: a gunner or marksman on its spot, or anyone watching for a lost enemy.
func inHold(_ bot: Bot, _ env: BotManager, _ dt: Double) -> String? {
    let role = bot.roleDef
    bot.crouching = role.holds
    if !bot.targetVisible, bot.unseenTime > 2 {
        bot.watch = .none
        lookAround(bot, env, dt)
    }
    let close = flatDistance(bot.position, bot.lastKnown) < role.minRange
    if role.holds, bot.targetVisible, !close { bot.tacticTimer = max(bot.tacticTimer, 1) }
    if bot.tacticTimer <= 0 || close { return close ? "enemy close" : bot.targetVisible ? "reposition" : "searching" }
    return nil
}

func inSuppress(_ bot: Bot, _ env: BotManager) -> String? {
    bot.fireMode = bot.targetVisible ? .target : .lastKnown
    if bot.phaseTimer <= 0 || bot.weapon.reloading { return "done suppressing" }
    return nil
}

func startPush(_ bot: Bot, _ speed: Double, _ why: String) {
    bot.coverNode = -1
    bot.crouching = false
    bot.phaseTimer = repathSeconds
    bot.setState(.push, why)
    bot.moveTo(bot.lastKnown.x, bot.lastKnown.y, bot.lastKnown.z, speed: speed)
}

/// Advance on the last known position until the enemy is in range or the place turns out empty.
func inPush(_ bot: Bot, _ env: BotManager) -> String? {
    bot.crouching = false
    let inRange = flatDistance(bot.position, bot.lastKnown) <= bot.roleDef.idealRange
    if bot.targetVisible, inRange { return "in range" }
    if bot.arrived || bot.pathFailed {
        if bot.targetVisible { return "in range" }
        startHold(bot, "searching")
        return nil
    }
    if bot.phaseTimer > 0 { return nil }
    bot.phaseTimer = repathSeconds
    if flatDistance(bot.goal, bot.lastKnown) > 3 {
        bot.moveTo(bot.lastKnown.x, bot.lastKnown.y, bot.lastKnown.z, speed: bot.moveSpeed)
    }
    return nil
}

func startFlank(_ bot: Bot, _ env: BotManager, _ why: String) -> Bool {
    let grid = env.grid
    let tx = bot.lastKnown.x
    let tz = bot.lastKnown.z
    let distance = flatDistance(bot.position, bot.lastKnown)
    let bearing = atan2(bot.position.z - tz, bot.position.x - tx)
    let radius = MathUtils.clamp(bot.roleDef.idealRange * 0.7, 8, 18)
    let first: Double = env.random() < 0.5 ? 1 : -1
    for attempt in 0 ..< 2 {
        let side = attempt == 0 ? first : -first
        let angle = bearing + side * (flankAngleMin + env.random() * flankAngleSpread)
        let node = grid.nearestNode(tx + cos(angle) * radius, bot.lastKnown.y, tz + sin(angle) * radius, maxRing: 4)
        if node < 0 || grid.wet[node] != 0 { continue }
        bot.coverNode = -1
        bot.crouching = false
        bot.setState(.flank, why)
        let avoid = PathAvoid(x: tx, z: tz, radius: min(distance * 0.85, 26), cost: 4)
        bot.moveTo(grid.nodeX(node), grid.y(node), grid.nodeZ(node), speed: Speed.run, avoid: avoid)
        return true
    }
    return false
}

/// Run the long way round; stop when in place, blocked, or face to face with the enemy.
func inFlank(_ bot: Bot, _ env: BotManager) -> String? {
    let near = bot.targetVisible && flatDistance(bot.position, bot.lastKnown) < bot.roleDef.idealRange * 0.8
    if bot.arrived || bot.pathFailed || near || bot.stateTime > flankMaxSeconds {
        return bot.arrived ? "flank reached" : near ? "met the enemy" : "flank abandoned"
    }
    return nil
}
