// Ported from src/game/game.ts at commit 185029e: the match loop and the solo match rules. M4 is
// offline: no bots (IronvaleAI, M7b) and no net session (M5), so the rules run with this machine
// as the authority, no partner and zero bots alive, exactly the web's single-player path.
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

    public init(mapId: String, mode: Mode, difficulty: String, botCount: Int, rules: Rules? = nil, killTarget: Int? = nil) {
        self.mapId = mapId
        self.mode = mode
        self.difficulty = difficulty
        self.botCount = botCount
        self.rules = rules
        self.killTarget = killTarget
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
}

/// The solo rules (`Game.updateRules` with no partner, authority on this machine). Pure state.
public struct MatchRules: Sendable {
    public let config: MatchConfig
    public let constants: SimConstants.Game
    public private(set) var respawnTimer = 0.0
    public private(set) var waveTimer = 0.0
    public private(set) var wave: Int

    public init(config: MatchConfig, constants: SimConstants.Game) {
        self.config = config
        self.constants = constants
        wave = config.effectiveRules == .survival ? 1 : 0
    }

    public enum Outcome: Equatable, Sendable { case none, respawn, won, lost }

    /// The player died: the respawn wait starts.
    public mutating func playerDied() { respawnTimer = constants.RESPAWN_SECONDS }

    public func livesRemaining(deaths: Int, alive: Bool) -> Int {
        switch config.effectiveRules {
        case .skirmish: max(0, constants.PLAYER_LIVES - deaths)
        default: max(0, constants.SURVIVAL_SOLO_LIVES - deaths)
        }
    }

    /// One frame of rules. `botsAlive` is 0 until bots exist (M7b).
    public mutating func update(_ dt: Double, playerAlive: Bool, deaths: Int, kills: Int, botsAlive: Int) -> Outcome {
        let rules = config.effectiveRules
        if rules == .duel {
            if !playerAlive {
                respawnTimer -= dt
                if respawnTimer <= 0 { return .respawn }
            }
            let target = config.killTarget ?? constants.DEFAULT_KILL_TARGET
            if kills >= target { return .won }
            if deaths >= target { return .lost }
            return .none
        }
        if !playerAlive {
            respawnTimer -= dt
            if respawnTimer <= 0 {
                let outOfLives = rules == .survival ? deaths >= constants.SURVIVAL_SOLO_LIVES : deaths >= constants.PLAYER_LIVES
                return outOfLives ? .lost : .respawn
            }
            return .none
        }
        // A match with no enemies is a sandbox: nothing to win.
        if botsAlive > 0 || config.botCount == 0 { return .none }
        if rules == .skirmish, kills >= config.botCount {
            // Let the last kill land and be seen before the result screen comes up.
            waveTimer += dt
            if waveTimer >= constants.WIN_DELAY_SECONDS { return .won }
        }
        return .none
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
        rules = MatchRules(config: config, constants: data.constants.game)
        kills = 0
        deaths = 0
        shotsFired = 0
        shotsHit = 0
        time = 0
        mapBox.time = 0
        combat.add(player)
        spawnPlayer()
        weapons.issue(issuedWeapons(mode: config.mode, difficulty: config.difficulty, data: data))
        weapons.resupply()
        // One grenade for the whole match: this is the only place it is handed out.
        weapons.restockGrenades()
        player.update(0)
        weapons.update(0)
        setPhase(.playing)
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
        guard phase == .playing else { return }
        time += dt
        mapBox.time = time
        player.controllable = input.locked
        player.update(dt)
        weapons.update(dt)
        player.setWeaponModifiers(mobility: weapons.current.def.mobility, aimBlend: weapons.aimBlend, zoom: weapons.zoom,
                                  blockSprint: weapons.blocksSprint)
        grenades.update(dt)
        updateRules(dt)
        if phase == .playing, input.wasPressed(.pause) { pause() }
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
            livesRemaining: rules?.livesRemaining(deaths: deaths, alive: player.alive) ?? 0,
            respawnIn: player.alive ? 0 : max(0, rules?.respawnTimer ?? 0),
            kills: kills,
            deaths: deaths,
            shotsFired: shotsFired,
            shotsHit: shotsHit,
            elapsed: time,
            spread: weapons.spread
        )
    }

    private func updateRules(_ dt: Double) {
        guard var rules else { return }
        let outcome = rules.update(dt, playerAlive: player.alive, deaths: deaths, kills: kills, botsAlive: 0)
        self.rules = rules
        switch outcome {
        case .none: break
        case .respawn: spawnPlayer()
        case .won: endMatch(.won)
        case .lost: endMatch(.lost)
        }
    }

    private func endMatch(_ result: GamePhase) {
        if phase != .playing, phase != .paused { return }
        setPhase(result)
    }

    private func observe(_ event: GameEvent) {
        switch event {
        case let .died(victimId, killerId, _, _):
            if victimId == player.id {
                deaths += 1
                rules?.playerDied()
            } else if killerId == player.id {
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
    private func spawnPlayer() {
        guard let map else { return }
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
        grenades.clear()
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
