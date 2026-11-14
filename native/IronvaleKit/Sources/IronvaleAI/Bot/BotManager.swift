// Ported from src/ai/manager.ts at commit cbe0add: owns the navigation data and every bot; the
// `BotSystem` the game talks to. The navigation grid is built synchronously when a map is entered
// (it is an immutable value afterwards); the soldier visuals and the `?botdebug` overlay are the
// renderer's business here, so the manager publishes `SoldierActor`s instead of scene objects.
import Foundation
import IronvaleContract
import IronvaleCore
import IronvaleMapData
import IronvaleSim
import IronvaleWorld

private let thinkInterval = 1.0 / 7
private let thinkJitter = 0.2
private let maxThinksPerFrame = 4
private let pathBudget = 350
private let corpseSeconds = 20.0
private let enemyRefreshSeconds = 0.5
private let spawnCapacity = 4
private let spawnRing = 1.4
private let playerViewHalfAngle = 65 * Double.pi / 180
private let maxFrameSeconds = 0.1
private let sweepRampSeconds = 10.0
private let sweepStaggerSeconds = 1.5

/// Timing and size figures (`BotStats`).
public struct BotStats: Sendable {
    public var navNodes = 0
    public var navBuildMs = 0.0
    public var navBytes = 0
    public var frames = 0
    public var updateMs = 0.0
    public var updateMaxMs = 0.0
    /// Every bot spawned since the map was entered.
    public var spawned = 0
}

public final class BotManager: BotSystem {
    public unowned let game: Game
    public let squad = Squad()
    public private(set) var bots: [Bot] = []
    public private(set) var time = 0.0
    public private(set) var fogDensity = 0.006
    public private(set) var enemies: [any Combatant] = []
    public private(set) var stats = BotStats()
    /// Dress bots in this uniform instead of their team's (a duel bot wears its owner's, `duelBotSide`).
    public var uniform: Team?
    /// Called on every state change (the web's `?botdebug` transition log).
    public var onTransition: ((Bot, BotState, BotState, String) -> Void)?
    /// Squad callouts that passed the squad's rate limit (`botCallout`; the audio lane voices them).
    public var onCallout: ((Bot, CalloutKind) -> Void)?

    private var rng: SeededRandom
    private var nav: NavGrid?
    private var queue: PathQueue?
    private var map: MapPackage?
    private var spawned = 0
    private var sweepFrom = 0.0
    private var enemyTimer = 0.0
    private var thinkCursor = 0
    private var lastMuzzle = Vec3.zero
    private var lastShotTeam: Team?
    private var scaled: [String: WeaponDef] = [:]
    private var unsubscribe: (() -> Void)?

    /// `seed` replaces the web's fixed squad dice (`hashString("ironvale-bots")`) to play a different match.
    public init(game: Game, seed: UInt32? = nil) {
        self.game = game
        rng = SeededRandom(seed: seed ?? hashString("ironvale-bots"))
        unsubscribe = game.events.on { [weak self] event in self?.hearing(event) }
    }

    deinit { unsubscribe?() }

    public func random() -> Double { rng.next() }

    public var world: CollisionWorld? { game.map?.world }

    /// The navigation grid; nil before a map is entered.
    public var navGrid: NavGrid? { nav }
    var grid: NavGrid { nav! }
    var paths: PathQueue { queue! }

    public var alive: Int { bots.reduce(0) { $0 + ($1.alive ? 1 : 0) } }

    public var actors: [SoldierActor] { bots.map(\.actor) }

    // MARK: - data

    func roleDef(_ role: BotRole) -> RoleDef { game.data.contract.ai.roles[role.rawValue]! }

    func profile(_ difficulty: String) -> DifficultyProfile {
        let table = game.data.contract.ai.difficulty
        return table[difficulty] ?? table["regular"]!
    }

    /// The role's weapon with this difficulty's damage (`scaledWeapon`), cached.
    func weapon(_ id: String, difficulty: String) -> WeaponDef {
        let key = "\(id):\(difficulty)"
        if let cached = scaled[key] { return cached }
        let def = scaledWeapon(game.data.def(id)!, multiplier: profile(difficulty).damageMultiplier)
        scaled[key] = def
        return def
    }

    // MARK: - BotSystem

    public func enterMap(_ map: MapPackage) {
        leaveMap()
        let started = ContinuousClock.now
        let seeds = (map.meta.spawns.enemy + map.meta.spawns.player).map(\.point)
        let grid = NavGridBuilder.build(world: map.world, bounds: map.meta.bounds.box, seeds: seeds)
        nav = grid
        queue = PathQueue(grid: grid)
        self.map = map
        fogDensity = map.meta.lighting.fog.density
        time = 0
        sweepFrom = 0
        spawned = 0
        let elapsed = ContinuousClock.now - started
        stats = BotStats(navNodes: grid.nodeCount,
                         navBuildMs: Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15,
                         navBytes: grid.bytes)
    }

    public func leaveMap() {
        for i in stride(from: bots.count - 1, through: 0, by: -1) { retire(i) }
        queue?.clear()
        queue = nil
        nav = nil
        map = nil
        enemies = []
        squad.reset()
        lastShotTeam = nil
    }

    public func spawn(count: Int, team: Team, difficulty: String) {
        guard let map, let grid = nav, count > 0, let world else { return }
        let player = game.player
        let eye = player.eyePosition()
        let spawns = map.meta.spawns.enemy
        let order = orderSpawns(spawns.map(\.point), player: player.position) { index in
            let spawn = spawns[index].point
            if !inViewCone(player: player.position, yaw: player.yaw, point: spawn, halfAngle: playerViewHalfAngle) { return false }
            var chest = spawn
            chest.y += Body.chestStand
            return world.lineOfSight(eye, chest)
        }
        let picks = assignSpawns(count, order, capacity: spawnCapacity)
        let roles = assignRoles(picks.count)
        var used: [Int: Int] = [:]
        for (i, spawnIndex) in picks.enumerated() {
            let spawn = spawns[spawnIndex]
            let slot = used[spawnIndex] ?? 0
            used[spawnIndex] = slot + 1
            // The first soldier stands on the spawn; the rest take places around it.
            let angle = Double(slot) * 2.4
            let radius = slot == 0 ? 0 : spawnRing + 0.45 * Double((slot - 1) / 5)
            let x = spawn.point.x + cos(angle) * radius
            let z = spawn.point.z + sin(angle) * radius
            let node = grid.nearestNode(x, spawn.point.y, z)
            let at = node >= 0 ? Vec3(grid.nodeX(node), grid.y(node) + 0.02, grid.nodeZ(node)) : spawn.point
            let id = game.combat.allocateId()
            let bot = Bot(env: self, id: id, team: team, uniform: uniform ?? game.config?.botUniform ?? team, name: botName(spawned), role: roles[i],
                          difficulty: difficulty, spawn: at, yaw: spawn.yaw, life: 0)
            spawned += 1
            stats.spawned += 1
            bot.thinkTimer = Double(bots.count % 7) * (thinkInterval / 7) + random() * thinkInterval * 0.5
            bot.lastThink = time
            bot.idleTimer = random() * 3
            bots.append(bot)
            game.combat.add(bot)
            game.events.emit(.spawned(combatantId: id))
        }
        sweepFrom = time
        enemyTimer = 0
    }

    public func update(_ dt: Double) {
        guard nav != nil, let queue else { return }
        let started = ContinuousClock.now
        let step = min(dt, maxFrameSeconds)
        time += step

        enemyTimer -= step
        if enemyTimer <= 0 {
            enemyTimer = enemyRefreshSeconds
            enemies = bots.first.map { game.combat.enemies(of: $0.team) } ?? []
        }
        squad.tally(bots)
        queue.update(pathBudget)

        let total = bots.count
        var thinks = 0
        for i in 0 ..< total {
            let bot = bots[(thinkCursor + i) % total]
            if !bot.alive { continue }
            bot.thinkTimer -= step
            if bot.thinkTimer > 0 || thinks >= maxThinksPerFrame { continue }
            thinks += 1
            bot.thinkTimer = thinkInterval * (1 - thinkJitter / 2 + random() * thinkJitter)
            think(bot, self, min(time - bot.lastThink, 0.5))
            bot.lastThink = time
            squad.tally(bots)
        }
        if total > 0 { thinkCursor = (thinkCursor + 1) % total }

        for i in stride(from: total - 1, through: 0, by: -1) {
            let bot = bots[i]
            bot.update(step)
            if !bot.alive, bot.corpseTime > corpseSeconds { retire(i) }
        }
        let elapsed = ContinuousClock.now - started
        let ms = Double(elapsed.components.attoseconds) / 1e15 + Double(elapsed.components.seconds) * 1000
        stats.frames += 1
        stats.updateMs += (ms - stats.updateMs) / Double(stats.frames)
        stats.updateMaxMs = max(stats.updateMaxMs, ms)
    }

    // MARK: - BotEnv

    func sweepBias(_ bot: Bot) -> Double {
        let quiet = time - max(squad.contactTime, sweepFrom)
        let turn = Double(bots.firstIndex { $0 === bot } ?? -1) * sweepStaggerSeconds
        return MathUtils.clamp((quiet - bot.profile.sweepDelay - turn) / sweepRampSeconds, 0, 1)
    }

    func callout(_ bot: Bot, _ kind: CalloutKind) {
        if !squad.tryCallout(kind, time: time) { return }
        onCallout?(bot, kind)
    }

    func transition(_ bot: Bot, from: BotState, to: BotState, reason: String) {
        onTransition?(bot, from, to, reason)
    }

    // MARK: - hearing

    private func hearing(_ event: GameEvent) {
        switch event {
        case let .shotFired(shooterId, weapon, muzzle, _, _): onShot(shooterId, weapon, muzzle)
        case let .bulletTrace(_, _, from, to, _): onTrace(from, to)
        case let .bulletImpact(_, _, hit): onImpact(hit.point)
        case let .footstep(ownerId, position, _, running, _): onFootstep(ownerId, position, running)
        default: break
        }
    }

    private func onShot(_ shooterId: Int, _ weaponId: String, _ muzzle: Vec3) {
        let shooter = game.combat.get(shooterId)
        lastShotTeam = shooter?.team
        lastMuzzle = muzzle
        guard let shooter else { return }
        let loudness = game.data.def(weaponId)?.loudness ?? 1
        for bot in bots where bot.alive && bot.team != shooter.team {
            let radius = hearingRadius(.shot, loudness: loudness, scale: bot.profile.hearingScale)
            if bot.position.distanceToSquared(muzzle) < radius * radius { bot.hear(.shot, muzzle) }
        }
    }

    /// A bullet passing close by tells a soldier it is being shot at, and from where.
    private func onTrace(_ from: Vec3, _ to: Vec3) {
        guard let shotTeam = lastShotTeam else { return }
        let segment = to - from
        let lengthSq = segment.lengthSq
        if lengthSq < 1e-6 { return }
        let radius = hearingRadius(.nearMiss, loudness: 1, scale: 1)
        for bot in bots where bot.alive && bot.team != shotTeam {
            var chest = bot.position
            chest.y += Body.chestStand
            let t = MathUtils.clamp((chest - from).dot(segment) / lengthSq, 0, 1)
            let offset = from.adding(segment, scaledBy: t)
            if offset.distanceToSquared(chest) < radius * radius { bot.hear(.nearMiss, lastMuzzle) }
        }
    }

    private func onImpact(_ point: Vec3) {
        guard let shotTeam = lastShotTeam else { return }
        for bot in bots where bot.alive && bot.team != shotTeam {
            let radius = hearingRadius(.impact, loudness: 1, scale: bot.profile.hearingScale)
            if bot.position.distanceToSquared(point) < radius * radius { bot.hear(.impact, lastMuzzle) }
        }
    }

    private func onFootstep(_ ownerId: Int, _ position: Vec3, _ running: Bool) {
        guard running, !bots.isEmpty, let owner = game.combat.get(ownerId) else { return }
        for bot in bots where bot.alive && bot.team != owner.team {
            let radius = hearingRadius(.footstep, loudness: 1, scale: bot.profile.hearingScale)
            if bot.position.distanceToSquared(position) < radius * radius { bot.hear(.footstep, position) }
        }
    }

    private func retire(_ index: Int) {
        let bot = bots.remove(at: index)
        bot.halt()
        game.combat.remove(bot.id)
    }
}
