// The bot-facing match rules (`updateRules`, `respawnDuelBot`, `takeOver` in src/game/game.ts),
// case by case against the web's branches, with the constants from native/Contract/sim.
import IronvaleSim
import Testing

private let constants = SimData.shared.constants.game
private let frame = 1.0 / 60

private func rules(_ mode: MatchConfig.Mode, bots: Int, rules: MatchConfig.Rules? = nil, killTarget: Int? = nil) -> MatchRules {
    MatchRules(config: MatchConfig(mapId: "railyard", mode: mode, difficulty: "regular", botCount: bots, rules: rules, killTarget: killTarget),
               constants: constants)
}

/// Runs `seconds` of frames and returns every action, in order.
private func run(_ r: inout MatchRules, _ seconds: Double, _ input: MatchRules.Input) -> [MatchRules.Action] {
    var out: [MatchRules.Action] = []
    var t = 0.0
    while t < seconds - 1e-9 {
        out += r.update(frame, input)
        t += frame
    }
    return out
}

@Test func skirmishIsWonOnlyAfterTheWinDelayOnceEveryBotIsDown() {
    var r = rules(.skirmish, bots: 8)
    let done = MatchRules.Input(playerAlive: true, deaths: 0, kills: 8, botsAlive: 0)
    #expect(run(&r, constants.WIN_DELAY_SECONDS - 0.1, done).isEmpty)
    // Then it says so every frame until the game ends the match (as the web does).
    let after = run(&r, 0.2, done)
    #expect(!after.isEmpty && after.allSatisfy { $0 == .end(.won) })
    var alive = rules(.skirmish, bots: 8)
    #expect(run(&alive, 10, MatchRules.Input(playerAlive: true, deaths: 0, kills: 7, botsAlive: 1)).isEmpty)
}

@Test func coopKillsCountBothPlayersAndOnlyTheAuthorityDecides() {
    var host = rules(.coop, bots: 8)
    let shared = MatchRules.Input(playerAlive: true, deaths: 0, kills: 5, botsAlive: 0, inMatch: true, partnerKills: 3)
    #expect(run(&host, constants.WIN_DELAY_SECONDS + 0.1, shared).contains(.end(.won)))
    var guest = rules(.coop, bots: 8)
    var input = shared
    input.authority = false
    #expect(run(&guest, 10, input).isEmpty)
}

@Test func aDownedCoopPlayerWaitsWhileThePartnerStands() {
    var r = rules(.coop, bots: 8)
    r.playerDied()
    let partner = NetPartner(id: 9, alive: true, deaths: 1)
    // Out of lives (3 deaths) but the partner is up: no loss, and the match goes on.
    let input = MatchRules.Input(playerAlive: false, deaths: constants.PLAYER_LIVES, kills: 0, botsAlive: 3, inMatch: true, partner: partner)
    #expect(run(&r, 10, input).isEmpty)
    var alone = rules(.coop, bots: 8)
    alone.playerDied()
    var lost = input
    lost.partner = NetPartner(id: 9, alive: false, deaths: constants.PLAYER_LIVES)
    #expect(run(&alone, constants.RESPAWN_SECONDS + 0.1, lost).contains(.end(.lost)))
}

@Test func survivalWavesGrowAfterThePause() {
    var r = rules(.survival, bots: 4)
    #expect(r.wave == 1)
    let cleared = MatchRules.Input(playerAlive: true, deaths: 0, kills: 4, botsAlive: 0)
    #expect(run(&r, constants.SURVIVAL_WAVE_PAUSE - 0.1, cleared).isEmpty)
    #expect(run(&r, 0.2, cleared) == [.reinforce, .spawnBots(4 + constants.SURVIVAL_WAVE_GROWTH)])
    #expect(r.wave == 2)
}

@Test func aDuelBotComesBackAfterTheRespawnWait() {
    var r = rules(.duel, bots: 1, killTarget: 10)
    let down = MatchRules.Input(playerAlive: true, deaths: 0, kills: 0, botsAlive: 0, inMatch: true)
    #expect(run(&r, constants.RESPAWN_SECONDS - 0.1, down).isEmpty)
    #expect(run(&r, 0.2, down) == [.spawnBots(1)])
    // A standing bot resets the wait.
    #expect(run(&r, 1, MatchRules.Input(playerAlive: true, deaths: 0, kills: 0, botsAlive: 1, inMatch: true)).isEmpty)
    #expect(run(&r, constants.RESPAWN_SECONDS - 0.1, down).isEmpty)
    // No bot in this duel: nothing to bring back.
    var none = rules(.duel, bots: 0, killTarget: 10)
    #expect(run(&none, 10, down).isEmpty)
    // Scored by side either way.
    var won = rules(.duel, bots: 1, killTarget: 3)
    #expect(won.update(frame, MatchRules.Input(playerAlive: true, deaths: 1, kills: 3, botsAlive: 1)) == [.end(.won)])
}

@Test func takeOverKeepsTheHigherWave() {
    var r = rules(.coop, bots: 8, rules: .survival)
    r.takeOver(wave: 4)
    #expect(r.wave == 4)
    r.takeOver(wave: 2)
    #expect(r.wave == 4)
}

@Test func survivalInAPairGivesOneLifePerWave() {
    let r = rules(.coop, bots: 8, rules: .survival)
    #expect(r.livesRemaining(deaths: 0, alive: true, inMatch: true) == 1)
    #expect(r.livesRemaining(deaths: 0, alive: false, inMatch: true) == 0)
    #expect(r.livesRemaining(deaths: 0, alive: true) == constants.SURVIVAL_SOLO_LIVES)
}
