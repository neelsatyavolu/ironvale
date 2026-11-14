// The M7b solo skirmish headless: the offline Game with BotManager on Railyard and Headworks, 8 bots
// against a player who stands at the spawn. The bots must spawn on the grid, find routes, come to the
// player and shoot them; with bot teammates on the player's side (the duel bot's side), bots kill bots.
// The app runs the same match through --autopilot --bots 8 (native/ci/check-m7b.sh).
import Foundation
import IronvaleAI
import IronvaleMapData
import IronvaleSim
import Testing

private func play(_ mapId: String, enemies: Int, allies: Int, seconds: Double, difficulty: String = "veteran", seed: UInt32? = nil)
    throws -> (game: Game, bots: BotManager, monitor: BotScenarioMonitor) {
    let package = try MapPackage.load(directory: packagesRoot.appending(path: mapId))
    let settings = PlayerSettings.defaults("mouse")
    let input = BoundInput(settings: settings)
    let game = Game(input: input, settings: settings, random: SeededRandomSource(seed: seed.map { $0 * 31 + 11 } ?? 11))
    let bots = BotManager(game: game, seed: seed)
    game.bots = bots
    let monitor = BotScenarioMonitor(game: game, bots: bots)
    game.start(map: package, config: MatchConfig(mapId: mapId, mode: .skirmish, difficulty: difficulty, botCount: enemies))
    if allies > 0 { bots.spawn(count: allies, team: .alpha, difficulty: difficulty) }
    let dt = 1.0 / 120
    var t = 0.0
    while t < seconds, game.phase == .playing {
        input.frame = InputFrame()
        game.frame(dt)
        monitor.frame(dt)
        t += dt
    }
    return (game, bots, monitor)
}

private let reference = try! SkirmishReference.load(contractRoot: nativeRoot.appending(path: "Contract"))

@Test(arguments: ["railyard", "headworks"])
func eightBotsHuntThePlayer(_ mapId: String) throws {
    let (game, bots, monitor) = try play(mapId, enemies: 8, allies: 0, seconds: 90)
    let report = monitor.report
    print("skirmish \(mapId): \(report.summary) phase \(game.phase.rawValue) deaths \(game.deaths) nav \(bots.stats.navNodes) nodes, update mean \(String(format: "%.3f", bots.stats.updateMs)) ms max \(String(format: "%.3f", bots.stats.updateMaxMs)) ms")
    let failures = report.failures(expectEnemies: 8, webFired: reference.firedRange(mapId: mapId, bots: 8))
    #expect(report.spawned == 8)
    #expect(failures.isEmpty, "\(failures)")
    #expect(report.hitsOnPlayer > 0, "no bot ever hit the player")
}

/// Several native matches, each with its own squad and bullet dice, against the web's 16
/// (native/Contract/nav/skirmish.json): every match inside the web's range of bots that fired, the
/// mean inside it too, and the roles that fire are the web's (its marksman never got a shot off).
@Test(arguments: ["railyard", "headworks"])
func skirmishMatchesTheWebsRange(_ mapId: String) throws {
    let web = try #require(reference.maps[mapId])
    var fired: [Int] = []
    var roles: [String: Int] = [:]
    for seed in UInt32(1) ... 8 {
        let (_, bots, monitor) = try play(mapId, enemies: 8, allies: 0, seconds: 90, seed: seed)
        let report = monitor.report
        fired.append(report.botsThatFired)
        for id in monitor.firedIds { if let bot = bots.bots.first(where: { $0.id == id }) { roles[bot.role.rawValue, default: 0] += 1 } }
        let failures = report.failures(expectEnemies: 8, webFired: web.firedRange)
        #expect(failures.isEmpty, "seed \(seed): \(failures)")
    }
    let mean = Double(fired.reduce(0, +)) / Double(fired.count)
    let webMean = Double(web.botsThatFired.min + web.botsThatFired.max) / 2
    print("skirmish range \(mapId): native fired per match \(fired) mean \(String(format: "%.2f", mean)), roles \(roles); web \(web.firedRange) roles \(web.rolesFired)")
    #expect(web.firedRange.contains(Int(mean.rounded())), "native mean \(mean) outside the web's \(web.firedRange) (web midpoint \(webMean))")
    for role in roles.keys { #expect(web.rolesFired[role] != nil, "native \(role)s fired; the web's never did on \(mapId)") }
}

@Test(arguments: ["railyard", "headworks"])
func botsFightBotsOnBothSides(_ mapId: String) throws {
    let (_, _, monitor) = try play(mapId, enemies: 4, allies: 4, seconds: 120)
    let report = monitor.report
    print("bot war \(mapId): \(report.summary)")
    #expect(report.spawned == 8)
    #expect(report.botKills > 0, "no bot killed another bot in 120 s")
    #expect(report.outOfWorld == 0 && report.rateViolations == 0)
}
