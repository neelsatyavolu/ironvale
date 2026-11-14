// The M7b skirmish gate, read from the game as it runs (used by IronvaleAITests and by the app's
// `--autopilot --bots N` run, native/ci/check-m7b.sh): every bot spawned, each one moved off its
// spawn, the squad fired and hit, nobody left the map, and no bot fired faster than its gun allows
// (a web guest's WeaponGate would reject such a shot).
import Foundation
import IronvaleSim
import IronvaleWorld

public struct BotScenarioReport: Sendable, Equatable {
    /// Bots that appeared (`spawned` events from bots).
    public var spawned = 0
    public var botShots = 0
    /// Distinct bots that fired at least once.
    public var botsThatFired = 0
    public var botFootsteps = 0
    /// Bullet hits by bots on the local player.
    public var hitsOnPlayer = 0
    public var playerDeaths = 0
    /// Deaths of bots caused by other bots.
    public var botKills = 0
    /// Deaths of bots caused by the player.
    public var playerKills = 0
    /// Least distance any bot got from where it appeared, in metres (the laziest bot's best).
    public var leastTravel = 0.0
    /// Bot positions outside the map's bounds.
    public var outOfWorld = 0
    /// Consecutive shots by one bot closer together than its gun's rate of fire allows.
    public var rateViolations = 0

    public var summary: String {
        "spawned \(spawned), shots \(botShots) by \(botsThatFired) bots, hits on player \(hitsOnPlayer), player deaths \(playerDeaths), "
            + "bot kills \(botKills), player kills \(playerKills), least travel \(String(format: "%.1f", leastTravel)) m, "
            + "footsteps \(botFootsteps), out of world \(outOfWorld), rate violations \(rateViolations)"
    }

    /// What is wrong for a skirmish against `expectEnemies` bots; empty when the gate passes.
    public func failures(expectEnemies: Int) -> [String] {
        var failed: [String] = []
        if spawned < expectEnemies { failed.append("only \(spawned) of \(expectEnemies) bots spawned") }
        if leastTravel < 2 { failed.append("a bot never moved 2 m from its spawn (least travel \(String(format: "%.2f", leastTravel)) m)") }
        if botFootsteps == 0 { failed.append("no bot footsteps") }
        if botsThatFired * 2 < expectEnemies { failed.append("only \(botsThatFired) of \(expectEnemies) bots fired") }
        if hitsOnPlayer == 0 { failed.append("no bot hit the player") }
        if outOfWorld > 0 { failed.append("\(outOfWorld) bot positions outside the map") }
        if rateViolations > 0 { failed.append("\(rateViolations) bot shots faster than the gun's rate of fire") }
        return failed
    }
}

public final class BotScenarioMonitor {
    public private(set) var report = BotScenarioReport()
    private let game: Game
    private let bots: BotManager
    private var origins: [Int: Vec3] = [:]
    private var travel: [Int: Double] = [:]
    private var lastShot: [Int: Double] = [:]
    private var fired: Set<Int> = []
    private var time = 0.0
    private var frameDt = 0.0
    private var unsubscribe: (() -> Void)?

    public init(game: Game, bots: BotManager) {
        self.game = game
        self.bots = bots
        unsubscribe = game.events.on { [weak self] event in self?.observe(event) }
    }

    deinit { unsubscribe?() }

    private func isBot(_ id: Int) -> Bool { bots.bots.contains { $0.id == id } }

    private func observe(_ event: GameEvent) {
        switch event {
        case let .spawned(id):
            guard let bot = bots.bots.first(where: { $0.id == id }) else { return }
            report.spawned += 1
            origins[id] = bot.position
            travel[id] = 0
        case let .shotFired(shooterId, weapon, _, _, _):
            guard let bot = bots.bots.first(where: { $0.id == shooterId }) else { return }
            report.botShots += 1
            fired.insert(shooterId)
            // The bot's cooldown carries the overshoot, so two rounds may come one frame closer than the nominal interval.
            let interval = 60 / (game.data.def(weapon)?.roundsPerMinute ?? bot.weaponDef.roundsPerMinute)
            if let last = lastShot[shooterId], time - last < interval - frameDt - 1e-6 { report.rateViolations += 1 }
            lastShot[shooterId] = time
        case let .footstep(ownerId, _, _, _, _):
            if isBot(ownerId) { report.botFootsteps += 1 }
        case let .combatantHit(_, targetId, attackerId, _, _, _):
            if targetId == game.player.id, isBot(attackerId) { report.hitsOnPlayer += 1 }
        case let .died(victimId, killerId, _, _):
            if victimId == game.player.id { report.playerDeaths += 1 }
            if isBot(victimId) {
                if killerId == game.player.id { report.playerKills += 1 } else if isBot(killerId) { report.botKills += 1 }
            }
        default:
            break
        }
    }

    /// After each game frame.
    public func frame(_ dt: Double) {
        time += dt
        frameDt = dt
        let bounds = game.map?.meta.bounds.box
        for bot in bots.bots where bot.alive {
            if let origin = origins[bot.id] { travel[bot.id] = max(travel[bot.id] ?? 0, bot.position.distance(to: origin)) }
            if let bounds, !inside(bot.position, bounds) { report.outOfWorld += 1 }
        }
        report.botsThatFired = fired.count
        report.leastTravel = travel.values.min() ?? 0
    }

    private func inside(_ p: Vec3, _ box: Box3) -> Bool {
        p.x >= box.min.x - 1 && p.x <= box.max.x + 1 && p.z >= box.min.z - 1 && p.z <= box.max.z + 1 && p.y >= box.min.y - 2
    }
}
