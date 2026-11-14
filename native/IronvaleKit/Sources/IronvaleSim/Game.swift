// Ported from src/game/game.ts at commit 185029e: the match loop and the match rules. The bots
// (`Game.bots`, IronvaleAI's BotManager, M7b) and the two-player session (`Game.net`, IronvaleNet)
// are plugged in by whoever composes the game; with neither, this is the web's offline path.
import Foundation
import IronvaleContract
import IronvaleCore
import IronvaleMapData
import IronvaleWorld

public struct MatchConfig: Sendable, Equatable {
    public enum Mode: String, Sendable { case skirmish, survival, coop, duel }
    public enum Rules: String, Sendable { case skirmish, survival, duel }

    public var mapId: String
    public var mode: Mode
    public var difficulty: String
    /// Enemies alive at once.
    public var botCount: Int
    /// Co-op: which single-player rules the pair plays under.
    public var rules: Rules?
    public var killTarget: Int?
    /// Side the bots fight on: bravo, except a duel bot on its owner's machine (`duelBotSide`).
    public var botTeam: Team
    /// Uniform the bots wear when it is not their team's: a duel bot wears its owner's (`duelBotSide`).
    public var botUniform: Team?

    public init(mapId: String, mode: Mode, difficulty: String, botCount: Int, rules: Rules? = nil, killTarget: Int? = nil,
                botTeam: Team = .bravo) {
        self.mapId = mapId
        self.mode = mode
        self.difficulty = difficulty
        self.botCount = botCount
        self.rules = rules
        self.killTarget = killTarget
        self.botTeam = botTeam
    }

    /// The rules in force: a co-op match plays under Skirmish or Survival rules.
    public var effectiveRules: Rules {
        switch mode {
        case .coop: rules ?? .skirmish
        case .skirmish: .skirmish
        case .survival: .survival
        case .duel: .duel
        }
    }
}

public enum GamePhase: String, Sendable { case menu, loading, playing, paused, won, lost }

/// What the HUD reads each frame (`MatchSnapshot`, the parts M4 has).
public struct MatchSnapshot: Sendable, Equatable {
    public var phase: GamePhase
    public var health: Int
    public var weaponName: String
    public var fireMode: String
    public var magazine: Int
    public var reserve: Int
    public var reloading: Bool
    public var aiming: Bool
    public var scopedIn: Bool
    public var grenades: Int
    public var grenadeAiming: Bool
    public var livesRemaining: Int
    public var respawnIn: Double
    public var kills: Int
    public var deaths: Int
    public var shotsFired: Int
    public var shotsHit: Int
    public var elapsed: Double
    public var spread: Double
    /// Enemies alive (a co-op guest shows the host's count).
    public var enemiesRemaining: Int = 0
    /// Survival wave (a co-op guest shows the host's).
    public var wave: Int = 0
}

/// The match rules (`Game.updateRules`, `respawnDuelBot`, `takeOver` in game.ts). Pure state: the
/// game carries out the actions it returns.
public struct MatchRules: Sendable {
    public let config: MatchConfig
    public let constants: SimConstants.Game
    public private(set) var respawnTimer = 0.0
    public private(set) var waveTimer = 0.0
    public private(set) var botDownTime = 0.0
    public private(set) var wave: Int

    public init(config: MatchConfig, constants: SimConstants.Game) {
        self.config = config
        self.constants = constants
        wave = config.effectiveRules == .survival ? 1 : 0
    }

    /// What one frame of rules sees.
    public struct Input: Sendable {
        public var playerAlive: Bool
        public var deaths: Int
        public var kills: Int
        public var botsAlive: Int
        /// In a two-player match (`net.inMatch`).
        public var inMatch = false
        /// This machine runs waves and the result (`net.authority`).
        public var authority = true
        public var partner: NetPartner?
        public var partnerKills = 0

        public init(playerAlive: Bool, deaths: Int, kills: Int, botsAlive: Int, inMatch: Bool = false, authority: Bool = true,
                    partner: NetPartner? = nil, partnerKills: Int = 0) {
            self.playerAlive = playerAlive
            self.deaths = deaths
            self.kills = kills
            self.botsAlive = botsAlive
            self.inMatch = inMatch
            self.authority = authority
            self.partner = partner
            self.partnerKills = partnerKills
        }
    }

    public enum Action: Equatable, Sendable {
        case respawnPlayer
        /// A new Survival wave: resupply (and in co-op bring a fallen player back) before its bots spawn.
        case reinforce
        case spawnBots(Int)
        case end(GamePhase)
    }

    /// The player died: the respawn wait starts.
    public mutating func playerDied() { respawnTimer = constants.RESPAWN_SECONDS }

    /// A co-op guest whose host left carries on with the remaining enemies (`takeOver`).
    public mutating func takeOver(wave: Int) {
        self.wave = max(self.wave, wave)
        waveTimer = 0
    }

    public func livesRemaining(deaths: Int, alive: Bool, inMatch: Bool = false) -> Int {
        switch config.effectiveRules {
        case .skirmish: max(0, constants.PLAYER_LIVES - deaths)
        default: inMatch ? (alive ? 1 : 0) : max(0, constants.SURVIVAL_SOLO_LIVES - deaths)
        }
    }

    /// One frame of rules.
    public mutating func update(_ dt: Double, _ input: Input) -> [Action] {
        let rules = config.effectiveRules
        var actions: [Action] = []
        if rules == .duel {
            if !input.playerAlive {
                respawnTimer -= dt
                if respawnTimer <= 0 { actions.append(.respawnPlayer) }
            }
            // A duel bot that is down comes back after the same wait as a player.
            if config.botCount == 0 || input.botsAlive > 0 {
                botDownTime = 0
            } else {
                botDownTime += dt
                if botDownTime >= constants.RESPAWN_SECONDS {
                    botDownTime = 0
                    actions.append(.spawnBots(config.botCount))
                }
            }
            let target = config.killTarget ?? constants.DEFAULT_KILL_TARGET
            if input.kills >= target { actions.append(.end(.won)) } else if input.deaths >= target { actions.append(.end(.lost)) }
            return actions
        }
        // With a partner still in the fight the match goes on while this player is down.
        let partnerStanding = input.partner.map { $0.alive || (rules == .skirmish && $0.deaths < constants.PLAYER_LIVES) } ?? false
        if !input.playerAlive {
            respawnTimer -= dt
            if respawnTimer <= 0 {
                let outOfLives = rules == .survival
                    ? input.inMatch || input.deaths >= constants.SURVIVAL_SOLO_LIVES
                    : input.deaths >= constants.PLAYER_LIVES
                if !outOfLives { actions.append(.respawnPlayer) } else if !partnerStanding, input.authority { actions.append(.end(.lost)) }
            }
            if !partnerStanding { return actions }
        }
        // A co-op guest leaves waves and the result to the host.
        if !input.authority { return actions }
        // A match with no enemies is a sandbox: nothing to win.
        if input.botsAlive > 0 || config.botCount == 0 { return actions }
        if rules == .survival {
            waveTimer += dt
            if waveTimer < constants.SURVIVAL_WAVE_PAUSE { return actions }
            waveTimer = 0
            wave += 1
            actions.append(.reinforce)
            actions.append(.spawnBots(config.botCount + (wave - 1) * constants.SURVIVAL_WAVE_GROWTH))
        } else if input.kills + input.partnerKills >= config.botCount {
            // Let the last kill land and be seen before the result screen comes up.
            waveTimer += dt
            if waveTimer >= constants.WIN_DELAY_SECONDS { actions.append(.end(.won)) }
        }
        return actions
    }
}

/// Top-level offline game: owns the sim objects, runs the match loop.
public final class Game {
    public let data: SimData
    public let events: EventBus
    public let combat: Combat
    public let player: PlayerController
    public let ballistics: Ballistics
    public let grenades: GrenadeSystem
    public let weapons: PlayerWeapons
    public let input: any ActionInput
    public var settings: PlayerSettings
    public private(set) var map: MapPackage?
    public private(set) var phase = GamePhase.menu
    public private(set) var config: MatchConfig?
    public private(set) var time = 0.0
    public private(set) var kills = 0
    public private(set) var deaths = 0
    public private(set) var shotsFired = 0
    public private(set) var shotsHit = 0
    /// Called with every phase change.
    public var onPhase: ((GamePhase) -> Void)?
    /// The two-player session, or nil when playing alone (M6).
    public var net: (any GameNet)?
    /// The bots (IronvaleAI BotManager, M7b), or nil for a match without any.
    public var bots: (any BotSystem)?
    private var rules: MatchRules?
    private var interiors: [ZoneBox] = []

    public init(input: any ActionInput, settings: PlayerSettings, data: SimData = .shared, random: any RandomSource = SystemRandom()) {
        self.data = data
        self.input = input
        self.settings = settings
        let mapBox = MapBoxHolder()
        let events = EventBus()
        self.events = events
        combat = Combat { mapBox.map?.world }
        let next = { random.next() }
        let settingsBox = SettingsHolder(settings)
        player = PlayerController(id: combat.allocateId(), team: .alpha, input: input, settings: { settingsBox.value }, events: events,
                                  world: { mapBox.map?.world }, interiors: { mapBox.interiors }, random: next,
                                  constants: data.constants.controller)
        let player = player
        ballistics = Ballistics(events: events, combat: combat, player: { player }, cameraPosition: { player.camera.position },
                                time: { mapBox.time }, random: next, constants: data.constants.ballistics)
        grenades = GrenadeSystem(events: events, combat: combat, world: { mapBox.map?.world }, localId: { player.id }, data: data)
        weapons = PlayerWeapons(player: player, input: input, settings: { settingsBox.value }, events: events, ballistics: ballistics,
                                grenades: grenades, world: { mapBox.map?.world }, random: next, data: data)
        self.mapBox = mapBox
        self.settingsBox = settingsBox
        events.on { [weak self] event in self?.observe(event) }
    }

    private let mapBox: MapBoxHolder
    private let settingsBox: SettingsHolder

    public func applySettings(_ next: PlayerSettings) {
        settings = next
        settingsBox.value = next
    }

    /// Starts a match on a loaded map package (`Game.startMatch` after loading).
    public func start(map: MapPackage, config: MatchConfig) {
        unloadMap()
        self.map = map
        self.config = config
        mapBox.map = map
        interiors = map.meta.interiors.map { ZoneBox(min: Vec3($0.min), max: Vec3($0.max)) }
        mapBox.interiors = interiors
        bots?.enterMap(map)
        rules = MatchRules(config: config, constants: data.constants.game)
        kills = 0
        deaths = 0
        shotsFired = 0
        shotsHit = 0
        time = 0
        mapBox.time = 0
        combat.add(player)
        net?.enterMap()
        spawnPlayer(initial: true)
        weapons.issue(issuedWeapons(mode: config.mode, difficulty: config.difficulty, data: data))
        weapons.resupply()
        // One grenade for the whole match: this is the only place it is handed out.
        weapons.restockGrenades()
        // A co-op guest shows the host's enemies instead of running its own.
        if net?.authority ?? true { bots?.spawn(count: config.botCount, team: config.botTeam, difficulty: config.difficulty) }
        player.update(0)
        weapons.update(0)
        setPhase(.playing)
        net?.matchLoaded()
    }

    public func pause() { if phase == .playing { setPhase(.paused) } }
    public func resume() { if phase == .paused { setPhase(.playing) } }

    public func quitToMenu() {
        unloadMap()
        config = nil
        setPhase(.menu)
    }

    /// One frame. `dt` is already capped at `MAX_FRAME_DT` by the frame loop.
    public func frame(_ dt: Double) {
        // `engine.onFrame` callbacks registered before the game's own frame: ballistics lands due rounds first.
        ballistics.flush()
        // A match with a friend keeps running while this player has the pause menu up.
        let simulating = phase == .playing || (phase == .paused && net?.inMatch == true)
        if simulating {
            // While a two-player match counts down nobody may move or shoot (the web feeds the weapons an empty input).
            let frozen = net?.frozen ?? false
            if !frozen {
                time += dt
                mapBox.time = time
            }
            player.controllable = input.locked && !frozen
            player.update(dt)
            if !frozen { weapons.update(dt) }
            player.setWeaponModifiers(mobility: weapons.current.def.mobility, aimBlend: weapons.aimBlend, zoom: weapons.zoom,
                                      blockSprint: weapons.blocksSprint)
            if !frozen { grenades.update(dt) }
            if !frozen { bots?.update(dt) }
            if !frozen { updateRules(dt) }
            if phase == .playing, input.wasPressed(.pause) { pause() }
        }
        net?.update(dt, running: simulating)
    }

    public var snapshot: MatchSnapshot {
        let machine = weapons.current
        return MatchSnapshot(
            phase: phase,
            health: Int(JS.round(player.health)),
            weaponName: machine.def.name,
            fireMode: machine.def.fireMode,
            magazine: machine.magazine,
            reserve: machine.reserve,
            reloading: machine.reloading,
            aiming: weapons.aimBlend > 0.5,
            scopedIn: weapons.scopedIn,
            grenades: weapons.grenade.count,
            grenadeAiming: weapons.grenade.aiming,
            livesRemaining: rules?.livesRemaining(deaths: deaths, alive: player.alive, inMatch: net?.inMatch ?? false) ?? 0,
            respawnIn: player.alive ? 0 : max(0, rules?.respawnTimer ?? 0),
            kills: kills,
            deaths: deaths,
            shotsFired: shotsFired,
            shotsHit: shotsHit,
            elapsed: time,
            spread: weapons.spread,
            enemiesRemaining: net?.hostMatch?.enemies ?? bots?.alive ?? 0,
            wave: net?.hostMatch?.wave ?? rules?.wave ?? 0
        )
    }

    private func updateRules(_ dt: Double) {
        guard var rules, let config else { return }
        let input = MatchRules.Input(playerAlive: player.alive, deaths: deaths, kills: kills, botsAlive: bots?.alive ?? 0,
                                     inMatch: net?.inMatch ?? false, authority: net?.authority ?? true, partner: net?.partner,
                                     partnerKills: net?.partnerKills ?? 0)
        let actions = rules.update(dt, input)
        self.rules = rules
        for action in actions {
            switch action {
            case .respawnPlayer: spawnPlayer()
            case .reinforce: reinforce()
            case let .spawnBots(count): bots?.spawn(count: count, team: config.botTeam, difficulty: config.difficulty)
            case let .end(result): endMatch(result)
            }
        }
        if phase == .playing || phase == .paused {
            net?.reportMatch(wave: rules.wave, enemies: bots?.alive ?? 0, result: nil, localKills: kills)
        }
    }

    /// A new wave: fresh ammunition, and in co-op Survival a fallen player rejoins.
    public func reinforce() {
        weapons.resupply()
        if !player.alive, config?.mode == .coop, config?.effectiveRules == .survival { spawnPlayer() }
    }

    /// Co-op guest whose host has gone: run the remaining enemies here and carry on alone (`takeOver`).
    public func takeOver(enemies: Int, wave: Int) {
        guard let config else { return }
        rules?.takeOver(wave: wave)
        bots?.spawn(count: enemies, team: .bravo, difficulty: config.difficulty)
    }

    /// Ends the match now with `.won` or `.lost` (also a duel whose opponent left).
    public func endMatch(_ result: GamePhase) {
        if phase != .playing, phase != .paused { return }
        net?.reportMatch(wave: rules?.wave ?? 0, enemies: bots?.alive ?? 0, result: result, localKills: kills)
        setPhase(result)
    }

    private func observe(_ event: GameEvent) {
        switch event {
        case let .died(victimId, killerId, _, _):
            if victimId == player.id {
                deaths += 1
                rules?.playerDied()
            } else if config?.effectiveRules == .duel ? victimId == net?.partnerId : killerId == player.id {
                // A duel is scored by side: any death of the opponent is a point, whoever or whatever caused it.
                kills += 1
            }
        case let .bulletTrace(shooterId, _, _, _, _):
            if shooterId == player.id { shotsFired += 1 }
        case let .combatantHit(weapon, _, attackerId, _, _, _):
            // A blast is not a shot: it must not count toward accuracy.
            if attackerId == player.id, weapon != data.contract.weapons.grenadeId { shotsHit += 1 }
        default:
            break
        }
    }

    /// The spawn furthest from the nearest enemy; the first spawn when there are no enemies.
    private func spawnPlayer(initial: Bool = false) {
        guard let map else { return }
        // A two-player match may place the player itself.
        if let picked = net?.pickSpawn(initial: initial) {
            player.respawn(position: picked.position, yaw: picked.yaw)
            weapons.resupply()
            return
        }
        let spawns = map.meta.spawns.player
        guard var best = spawns.first else { return }
        let enemies = combat.enemies(of: player.team)
        var bestScore = -Double.infinity
        for spawn in spawns {
            let nearest = enemies.reduce(Double.infinity) { min($0, $1.position.distance(to: spawn.point)) }
            if nearest > bestScore {
                bestScore = nearest
                best = spawn
            }
        }
        player.respawn(position: best.point, yaw: best.yaw)
        weapons.resupply()
    }

    private func unloadMap() {
        net?.leaveMap()
        grenades.clear()
        if map != nil { bots?.leaveMap() }
        combat.clear()
        map = nil
        mapBox.map = nil
        mapBox.interiors = []
    }

    private func setPhase(_ next: GamePhase) {
        phase = next
        onPhase?(next)
    }
}

/// Late-bound references the sim objects read through closures (the web's `worldProxy`).
final class MapBoxHolder {
    var map: MapPackage?
    var interiors: [ZoneBox] = []
    var time = 0.0
}

final class SettingsHolder {
    var value: PlayerSettings
    init(_ value: PlayerSettings) { self.value = value }
}
