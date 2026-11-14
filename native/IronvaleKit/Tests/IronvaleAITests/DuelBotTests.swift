// The duel bot hunting a player who stands still (the native side of coop.test.ts's "the bot hunts the
// host"), headless: one elite bot, the player placed at the spot coop.test.ts uses each time it spawns
// (HUNTED_STAND, where the web's own bot killed in all 128 of its matches), at a smooth and at the
// slowest frame step the game allows. The bot must find and kill the player within the scenario's 100 s.
import Foundation
import IronvaleAI
import IronvaleMapData
import IronvaleSim
import IronvaleWorld
import Testing

private let huntedStand: [String: Vec3] = ["railyard": Vec3(20, 0.05, -40), "headworks": Vec3(31.5, 0.05, 6.5)]

@Test(arguments: ["railyard", "headworks"], [1.0 / 120, 0.1])
func duelBotHuntsAStandingPlayer(_ mapId: String, _ dt: Double) throws {
    let package = try MapPackage.load(directory: packagesRoot.appending(path: mapId))
    let stand = try #require(huntedStand[mapId])
    let settings = PlayerSettings.defaults("mouse")
    let input = BoundInput(settings: settings)
    let game = Game(input: input, settings: settings, random: SeededRandomSource(seed: 11))
    let bots = BotManager(game: game)
    game.bots = bots
    var firstDeath: Double?
    var t = 0.0
    let off = game.events.on { event in
        switch event {
        case let .spawned(id) where id == game.player.id && game.player.position.distance(to: stand) > 0.01:
            game.player.respawn(position: stand, yaw: game.player.yaw)
        case let .died(victim, killer, _, _) where victim == game.player.id && firstDeath == nil:
            if bots.bots.contains(where: { $0.id == killer }) { firstDeath = t }
        default: break
        }
    }
    defer { off() }
    game.start(map: package, config: MatchConfig(mapId: mapId, mode: .duel, difficulty: "elite", botCount: 1, rules: .skirmish, killTarget: 50))
    while t < 100, firstDeath == nil {
        input.frame = InputFrame()
        game.frame(dt)
        t += dt
    }
    print("duel bot \(mapId) dt \(String(format: "%.4f", dt)): first kill \(firstDeath.map { String(format: "%.1f s", $0) } ?? "none in 100 s")")
    #expect(firstDeath != nil, "the duel bot never killed the player standing at \(stand) on \(mapId)")
}
