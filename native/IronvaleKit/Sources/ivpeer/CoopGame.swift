// `ivpeer --game MAP`: the M7b co-op and duel-bot cross-play peer. Unlike the scripted layer 3 peer
// it runs a real headless match: the offline Game with IronvaleAI's BotManager, joined to the other
// machine by NetMatch over the real relay and WebRTC transport, at 120 frames a second of wall time.
// The local player stands where it spawned; the bots, the other player and the rules do the rest.
// Run by native/Tools/interop/coop.test.ts against the web's own NetSession (coop-peer.ts).
//   --game MAP                    the map to play (host: chosen in the lobby; guest: checked before Ready)
//   --role host|guest  --signal URL  --origin ORIGIN  --code-out FILE  --code-in FILE  --log FILE
//   --mode coop|duel              (default coop)
//   --bots N                      co-op: enemies (default 8)
//   --rules skirmish|survival     co-op rules (default skirmish)
//   --duel-bot none|host|guest    duel: who has an AI teammate (default none)
//   --difficulty D                (default regular)
//   --kill-target N               duel (default 10)
//   --leave-after SECONDS         leave the match (bye) this long after go
//   --duration SECONDS            end the run this long after go (default 30)
//   --until-score N               end the run 2 s after kills + deaths here reach N (before --duration)
//   --stand X,Y,Z                 put the local player here (feet) each time it spawns, instead of where the rules spawn it
//   --timeout SECONDS             give up (default 120)
import Foundation
import IronvaleAI
import IronvaleContract
import IronvaleCore
import IronvaleMapData
import IronvaleNet
import IronvaleSim
import IronvaleTransportWebRTC
import IronvaleWire
import IronvaleWorld

struct CoopGameOptions {
    var mapId = "railyard"
    var role: PeerRole = .host
    var signal = ""
    var origin = RelayDefaults.origin
    var codeOut: String?
    var codeIn: String?
    var log: String?
    var mode: NetMode = .coop
    var bots = 8
    var rules: NetRules = .skirmish
    var duelBot: DuelBot = .none
    var difficulty: IronvaleWire.Difficulty = .regular
    var killTarget = 10
    var leaveAfter: Double?
    var duration = 30.0
    var untilScore: Int?
    var stand: IronvaleWorld.Vec3?
    var timeout = 120.0

    /// nil unless the arguments ask for a game (`--game`).
    static func parse(_ arguments: [String]) throws -> CoopGameOptions? {
        guard arguments.contains("--game") else { return nil }
        var options = CoopGameOptions()
        var rest = arguments[...]
        func value(_ flag: String) throws -> String {
            guard let next = rest.popFirst() else { throw OptionError("\(flag) needs a value") }
            return next
        }
        func number(_ flag: String) throws -> Double {
            guard let n = Double(try value(flag)), n >= 0 else { throw OptionError("\(flag) takes a number") }
            return n
        }
        while let flag = rest.popFirst() {
            switch flag {
            case "--game": options.mapId = try value(flag)
            case "--role":
                guard let role = PeerRole(rawValue: try value(flag)) else { throw OptionError("--role is host or guest") }
                options.role = role
            case "--signal": options.signal = try value(flag)
            case "--origin": options.origin = try value(flag)
            case "--code-out": options.codeOut = try value(flag)
            case "--code-in": options.codeIn = try value(flag)
            case "--log": options.log = try value(flag)
            case "--mode":
                guard let mode = NetMode(rawValue: try value(flag)) else { throw OptionError("--mode is coop or duel") }
                options.mode = mode
            case "--bots": options.bots = Int(try number(flag))
            case "--rules":
                guard let rules = NetRules(rawValue: try value(flag)) else { throw OptionError("--rules is skirmish or survival") }
                options.rules = rules
            case "--duel-bot":
                guard let bot = DuelBot(rawValue: try value(flag)) else { throw OptionError("--duel-bot is none, host or guest") }
                options.duelBot = bot
            case "--difficulty":
                guard let d = IronvaleWire.Difficulty(rawValue: try value(flag)) else { throw OptionError("unknown difficulty") }
                options.difficulty = d
            case "--kill-target": options.killTarget = Int(try number(flag))
            case "--leave-after": options.leaveAfter = try number(flag)
            case "--duration": options.duration = try number(flag)
            case "--until-score": options.untilScore = Int(try number(flag))
            case "--stand":
                let parts = try value(flag).split(separator: ",").compactMap { Double($0) }
                guard parts.count == 3 else { throw OptionError("--stand takes X,Y,Z") }
                options.stand = IronvaleWorld.Vec3(parts[0], parts[1], parts[2])
            case "--timeout": options.timeout = try number(flag)
            default: throw OptionError("unknown argument \(flag)")
            }
        }
        if options.signal.isEmpty { throw OptionError("--game needs --signal") }
        return options
    }
}

@MainActor
final class CoopGame {
    static let frameSeconds = 1.0 / 120

    private let options: CoopGameOptions
    private let log: PeerLog
    private let game: Game
    private let bots: BotManager
    private let input: BoundInput
    private let match: NetMatch
    private let started = NetClock.now()
    private var ticker: DispatchSourceTimer?
    private var lastPhase: LobbyPhase = .idle
    private var codeWritten = false
    private var readySent = false
    private var startSent = false
    private var goAt: Double?
    private var left = false
    private var finished = false
    private var rejections = 0
    private var lastSummary = 0.0
    private var proxiesSeen = 0
    private var scoredAt: Double?
    private var logClosed = false
    private var firedBots: Set<Int> = []

    init(options: CoopGameOptions) throws {
        self.options = options
        log = PeerLog(path: options.log)
        let data = SimData.shared
        let settings = PlayerSettings.defaults("mouse")
        input = BoundInput(settings: settings)
        game = Game(input: input, settings: settings, data: data)
        bots = BotManager(game: game)
        game.bots = bots
        let contract = data.contract
        guard let relay = RelayClient(url: options.signal, origin: options.origin) else { throw OptionError("bad --signal") }
        match = NetMatch(game: game, relay: relay, makeLink: WebRTCPeerLink.make, localName: "Native",
                         knownMaps: Set(contract.maps.playable + contract.maps.developer))
        let packages = ContractLocation.sourceTreeDirectory.deletingLastPathComponent().appending(path: "MapPackages")
        match.startGame = { [weak self] config in
            guard let self else { return false }
            do {
                let package = try MapPackage.load(directory: packages.appending(path: config.mapId))
                write("startGame", [("map", .string(config.mapId)), ("botCount", .number(Double(config.botCount))),
                                    ("botTeam", .string(config.botTeam.rawValue)), ("botUniform", .string(config.botUniform?.rawValue ?? ""))])
                game.start(map: package, config: config)
                return true
            } catch {
                write("loadFailed", [("error", .string("\(error)"))])
                return false
            }
        }
        match.log = { [weak self] kind, fields in
            guard let self else { return }
            if kind == "reject" { rejections += 1 }
            write(kind, fields.sorted { $0.key < $1.key }.map { ($0.key, .string($0.value)) })
        }
        var tap = NetTap()
        tap.rejected = { [weak self] channel, _, reason in
            self?.rejections += 1
            self?.write("reject", [("channel", .string(channel.rawValue)), ("reason", .string(reason))])
        }
        match.session.tap = tap
        match.session.onChange = { [weak self] state in self?.changed(state) }
        game.events.on { [weak self] event in self?.observe(event) }
        game.onPhase = { [weak self] phase in self?.write("phase", [("game", .string(phase.rawValue))]) }
    }

    func run() {
        write("start", [("role", .string(options.role.rawValue)), ("map", .string(options.mapId)), ("mode", .string(options.mode.rawValue))])
        if options.role == .host {
            let o = options
            match.session.setConfig { config in
                config.mapId = o.mapId
                config.mode = o.mode
                config.rules = o.rules
                config.difficulty = o.difficulty
                config.botCount = o.bots
                config.killTarget = o.killTarget
                config.duelBot = o.duelBot
            }
            match.session.host(.room)
        } else {
            readCode { [weak self] code in self?.match.session.join(.room, code: code) }
        }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: Self.frameSeconds)
        var last = NetClock.now()
        timer.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                let now = NetClock.now()
                // Wall time, capped like the frame loop's MAX_FRAME_DT.
                let dt = min((now - last) / 1000, 0.1)
                last = now
                self?.tick(dt)
            }
        }
        ticker = timer
        timer.resume()
    }

    private func tick(_ dt: Double) {
        if finished { return }
        input.frame = InputFrame()
        game.frame(dt)
        let now = NetClock.now()
        if goAt == nil, game.phase == .playing, match.inMatch, !match.frozen {
            goAt = now
            write("go")
        }
        if now - lastSummary > 2000 { summary("summary") }
        proxiesSeen = max(proxiesSeen, match.sync?.proxies.all.count ?? 0)
        if let goAt {
            let since = (now - goAt) / 1000
            if let leave = options.leaveAfter, since >= leave, !left {
                left = true
                summary("leaving")
                match.session.send(.bye(.left))
                match.session.leave()
            }
            if let target = options.untilScore, scoredAt == nil, game.kills + game.deaths >= target { scoredAt = now }
            // The grace lets the last death reach the other machine before the bye.
            if let scoredAt, now - scoredAt >= 2000 { finish(ok: true, reason: "score reached") }
            if since >= options.duration { finish(ok: true, reason: "duration reached") }
        }
        if (now - started) / 1000 > options.timeout { finish(ok: false, reason: "timed out") }
    }

    private func changed(_ state: NetLobbyState) {
        if state.phase != lastPhase {
            lastPhase = state.phase
            write("lobby", [("phase", .string(state.phase.rawValue))])
        }
        if options.role == .host, !state.code.isEmpty, !codeWritten {
            codeWritten = true
            write("code", [("chars", .number(Double(state.code.count)))])
            if let path = options.codeOut { try? state.code.write(toFile: path, atomically: true, encoding: .utf8) }
        }
        if let error = state.error {
            write("error", [("error", .string(error.rawValue))])
            return
        }
        guard state.phase == .connected, !state.inMatch else { return }
        if options.role == .guest, !readySent, state.config.mapId == options.mapId, state.config.mode == options.mode {
            readySent = true
            write("ready", [("map", .string(state.config.mapId))])
            match.session.setReady(true)
        }
        if options.role == .host, state.peerReady, !startSent {
            startSent = true
            write("startMatch")
            match.session.start()
        }
    }

    private func name(_ id: Int) -> String {
        if id == game.player.id { return "local" }
        if id == match.partnerId { return "peer" }
        if bots.bots.contains(where: { $0.id == id }) { return "bot" }
        if match.sync?.proxies.local(id) != nil { return "proxy" }
        return "\(id)"
    }

    private func observe(_ event: GameEvent) {
        switch event {
        case let .died(victimId, killerId, weaponId, _):
            write("died", [("victim", .string(name(victimId))), ("killer", .string(name(killerId))), ("weapon", .string(weaponId)),
                           ("kills", .number(Double(game.kills))), ("deaths", .number(Double(game.deaths)))])
        case let .spawned(id):
            if id == game.player.id, let stand = options.stand, game.player.position.distance(to: stand) > 0.01 {
                // Moved in the same frame as the spawn, before any state is sent: the other side only sees the stand.
                game.player.respawn(position: stand, yaw: game.player.yaw)
                write("stood", [("x", .number(stand.x)), ("y", .number(stand.y)), ("z", .number(stand.z))])
            }
            if let bot = bots.bots.first(where: { $0.id == id }) {
                write("botSpawned", [("id", .number(Double(id))), ("team", .string(bot.team.rawValue)),
                                     ("uniform", .string(bot.uniform.rawValue)), ("weapon", .string(bot.weaponDef.id))])
            }
        case let .shotFired(shooterId, weapon, _, _, _):
            if let bot = bots.bots.first(where: { $0.id == shooterId }), !firedBots.contains(shooterId) {
                firedBots.insert(shooterId)
                write("botFirstShot", [("id", .number(Double(shooterId))), ("role", .string(bot.role.rawValue)), ("weapon", .string(weapon))])
            }
        default:
            break
        }
    }

    private func summary(_ kind: String) {
        lastSummary = NetClock.now()
        let proxies = match.sync?.proxies.all ?? []
        write(kind, [
            ("gamePhase", .string(game.phase.rawValue)), ("kills", .number(Double(game.kills))), ("deaths", .number(Double(game.deaths))),
            ("botsAlive", .number(Double(bots.alive))), ("botsTotal", .number(Double(bots.bots.count))),
            ("proxies", .number(Double(proxies.count))), ("proxiesAlive", .number(Double(proxies.filter(\.alive).count))),
            ("proxyTeams", .string(Set(proxies.map(\.team.rawValue)).sorted().joined(separator: ","))),
            ("authority", .bool(match.authority)), ("tookOver", .bool(match.tookOver)),
            ("partnerKills", .number(Double(match.partnerKills))), ("partnerDeaths", .number(Double(match.partner?.deaths ?? 0))),
            ("hostWave", .number(Double(match.hostMatch?.wave ?? -1))), ("hostEnemies", .number(Double(match.hostMatch?.enemies ?? -1))),
            ("enemiesRemaining", .number(Double(game.snapshot.enemiesRemaining))), ("wave", .number(Double(game.snapshot.wave))),
            ("playerAlive", .bool(game.player.alive)), ("rejections", .number(Double(rejections))),
            ("drawn", .number(Double(SoldierDrawList.build(from: [bots, match]).soldiers.count))),
            ("botsFired", .number(Double(firedBots.count))),
            ("bots", .string(bots.bots.filter(\.alive).map { b in
                "\(b.id):\(b.role.rawValue):\(b.state.rawValue)@\(Int(b.position.x.rounded())),\(Int(b.position.y.rounded())),\(Int(b.position.z.rounded()))"
            }.joined(separator: " "))),
        ])
    }

    private func readCode(_ done: @escaping @MainActor (String) -> Void) {
        if let path = options.codeIn, let code = try? String(contentsOfFile: path, encoding: .utf8), !code.isEmpty {
            done(code)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            MainActor.assumeIsolated { self?.readCode(done) }
        }
    }

    private func finish(ok: Bool, reason: String) {
        guard !finished else { return }
        summary("final")
        finished = true
        ticker?.cancel()
        write("done", [("ok", .bool(ok && rejections == 0)), ("reason", .string(reason)), ("rejections", .number(Double(rejections)))])
        log.close()
        logClosed = true
        if !left { match.session.send(.bye(.ended)) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            exit(ok && self.rejections == 0 ? 0 : 1)
        }
    }

    private func write(_ kind: String, _ fields: [(String, JSONValue)] = []) {
        // Session callbacks can still arrive after the log is closed.
        if logClosed { return }
        log.write(kind, [("t", .number(((NetClock.now() - started) / 1000 * 1000).rounded() / 1000))] + fields)
    }
}
