// Ported from src/net/events.ts at commit cbe0add.
//
// The rare messages between the two players: lobby, hits, deaths, match state. JSON text on the
// reliable channel. `EventCodec.parse` rebuilds each event field by field and returns nil for
// anything malformed; `EventCodec.encode` writes what the web's `JSON.stringify` writes.
import IronvaleContract
import IronvaleCore

extension WeaponDef: DamageRated, FireRated {}

public enum NetMode: String, CaseIterable, Sendable { case coop, duel }
public enum NetRules: String, CaseIterable, Sendable { case skirmish, survival }
/// Which player, if either, has an AI teammate in a duel.
public enum DuelBot: String, CaseIterable, Sendable { case none, host, guest }
public enum Difficulty: String, CaseIterable, Sendable { case recruit, regular, veteran, elite }
public enum HitZone: String, CaseIterable, Sendable { case head, torso, limb }
public enum ByeReason: String, CaseIterable, Sendable { case left, timeout, ended }
public enum MatchResult: String, CaseIterable, Sendable {
    case none = ""
    case won, lost
}
public enum WeaponActionStage: String, CaseIterable, Sendable {
    case magOut, magIn, boltBack, boltForward, boltLift, boltClose, shellInsert, beltOpen, beltClose
}

/// What the host chooses in the lobby.
public struct NetMatchConfig: Sendable, Equatable {
    public var mapId: String
    public var mode: NetMode
    /// Co-op only: which single-player rules the pair plays under.
    public var rules: NetRules
    public var difficulty: Difficulty
    public var botCount: Int
    /// Duel only: kills needed to win.
    public var killTarget: Int
    /// Duel only: who has a bot teammate.
    public var duelBot: DuelBot

    public init(mapId: String, mode: NetMode, rules: NetRules, difficulty: Difficulty, botCount: Int, killTarget: Int, duelBot: DuelBot) {
        self.mapId = mapId
        self.mode = mode
        self.rules = rules
        self.difficulty = difficulty
        self.botCount = botCount
        self.killTarget = killTarget
        self.duelBot = duelBot
    }
}

public enum NetEvent: Sendable, Equatable {
    case hello(v: Int, name: String)
    case lobby(NetMatchConfig)
    case ready(Bool)
    case load(NetMatchConfig)
    case loaded
    /// Start time on the host's clock, milliseconds.
    case go(at: Double)
    case hit(target: Int, attacker: Int, weapon: DamageSource, zone: HitZone, amount: Double, p: Vec3, d: Vec3)
    case death(victim: Int, killer: Int, weapon: DamageSource, headshot: Bool, life: Int, d: Vec3)
    case action(actor: Int, weapon: WeaponID, stage: WeaponActionStage)
    case switchWeapon(WeaponID)
    case botSpawn(id: Int, name: String, weapon: WeaponID, p: Vec3, yaw: Double)
    case match(wave: Int, enemies: Int, result: MatchResult, hostKills: Int, guestKills: Int)
    /// The sender threw its grenade from `p` at velocity `v`.
    case nade(p: Vec3, v: Vec3)
    /// The sender's grenade went off at `p`.
    case boom(p: Vec3)
    case chat(String)
    case away(Bool)
    case bye(ByeReason)
}

public enum EventCodec {
    public static let maxNetBots = 32
    public static let maxKillTarget = 50
    static let maxDamage: Double = 1000
    static let maxCount = 100_000
    /// No throw is this fast, m/s per axis.
    static let maxThrowSpeed: Double = 40

    // MARK: Parse

    /// Parse and validate one event (`parseEvent`). Unknown fields are dropped.
    public static func parse(_ text: String) -> NetEvent? {
        guard JS.length(text) <= Wire.maxEventChars, let value = JSONValue.parse(text), let fields = value.object else { return nil }
        return build(fields)
    }

    static func oneOf<T: RawRepresentable<String>>(_ value: JSONValue?, _: T.Type) -> T? {
        value?.string.flatMap(T.init(rawValue:))
    }

    static func whole(_ value: JSONValue?, _ min: Double, _ max: Double) -> Int? {
        guard let number = value?.number, JS.isInteger(number), number >= min, number <= max else { return nil }
        return Int(number)
    }

    static func real(_ value: JSONValue?, _ min: Double, _ max: Double) -> Double? {
        guard let number = value?.number, number.isFinite, number >= min, number <= max else { return nil }
        return number
    }

    static func wireId(_ value: JSONValue?) -> Int? { whole(value, 0, Double(Wire.maxWireId)) }

    static func point(_ value: JSONValue?, _ limit: Double) -> Vec3? {
        guard let items = value?.array, items.count == 3,
              let x = real(items[0], -limit, limit), let y = real(items[1], -limit, limit), let z = real(items[2], -limit, limit)
        else { return nil }
        return Vec3(x, y, z)
    }

    static func damageSource(_ value: JSONValue?) -> DamageSource? { value?.string.flatMap(DamageSource.init(rawValue:)) }

    static func isMapId(_ text: String) -> Bool {
        let units = text.utf16
        guard (1...24).contains(units.count) else { return false }
        return units.allSatisfy { (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2D }
    }

    static func matchConfig(_ value: JSONValue?) -> NetMatchConfig? {
        guard let fields = value?.object else { return nil }
        let mapId = fields["mapId"]?.string.flatMap { isMapId($0) ? $0 : nil }
        // A host from before duel bots sends no field: nobody has one.
        let duelBot = fields["duelBot"] == nil ? DuelBot.none : oneOf(fields["duelBot"], DuelBot.self)
        guard let mapId,
              let mode = oneOf(fields["mode"], NetMode.self),
              let rules = oneOf(fields["rules"], NetRules.self),
              let difficulty = oneOf(fields["difficulty"], Difficulty.self),
              let botCount = whole(fields["botCount"], 0, Double(maxNetBots)),
              let killTarget = whole(fields["killTarget"], 1, Double(maxKillTarget)),
              let duelBot
        else { return nil }
        return NetMatchConfig(mapId: mapId, mode: mode, rules: rules, difficulty: difficulty, botCount: botCount, killTarget: killTarget, duelBot: duelBot)
    }

    static func build(_ f: JSONObject) -> NetEvent? {
        guard let t = f["t"]?.string else { return nil }
        switch t {
        case "hello":
            guard let v = whole(f["v"], 0, 1000), let name = f["name"]?.string else { return nil }
            return .hello(v: v, name: Sanitize.name(name))
        case "lobby":
            return matchConfig(f["config"]).map(NetEvent.lobby)
        case "load":
            return matchConfig(f["config"]).map(NetEvent.load)
        case "ready":
            return f["ready"]?.bool.map(NetEvent.ready)
        case "loaded":
            return .loaded
        case "go":
            return real(f["at"], 0, Wire.maxTimeMs).map { .go(at: $0) }
        case "hit":
            guard let target = wireId(f["target"]), let attacker = wireId(f["attacker"]),
                  let weapon = damageSource(f["weapon"]), let zone = oneOf(f["zone"], HitZone.self),
                  let amount = real(f["amount"], 0, maxDamage),
                  let p = point(f["p"], Wire.maxCoordinate), let d = point(f["d"], 1.01)
            else { return nil }
            return .hit(target: target, attacker: attacker, weapon: weapon, zone: zone, amount: amount, p: p, d: d)
        case "death":
            guard let victim = wireId(f["victim"]), let killer = wireId(f["killer"]),
                  let weapon = damageSource(f["weapon"]), let headshot = f["headshot"]?.bool,
                  let life = whole(f["life"], 0, 255), let d = point(f["d"], 1.01)
            else { return nil }
            return .death(victim: victim, killer: killer, weapon: weapon, headshot: headshot, life: life, d: d)
        case "action":
            guard let actor = wireId(f["actor"]), let weapon = oneOf(f["weapon"], WeaponID.self),
                  let stage = oneOf(f["stage"], WeaponActionStage.self) else { return nil }
            return .action(actor: actor, weapon: weapon, stage: stage)
        case "switch":
            return oneOf(f["weapon"], WeaponID.self).map(NetEvent.switchWeapon)
        case "botSpawn":
            guard let id = whole(f["id"], Double(Wire.botBase), Double(Wire.maxWireId)), let name = f["name"]?.string,
                  let weapon = oneOf(f["weapon"], WeaponID.self), let p = point(f["p"], Wire.maxCoordinate),
                  let yaw = real(f["yaw"], -10, 10) else { return nil }
            return .botSpawn(id: id, name: Sanitize.name(name, fallback: "Soldier"), weapon: weapon, p: p, yaw: yaw)
        case "match":
            let limit = Double(maxCount)
            guard let wave = whole(f["wave"], 0, limit), let enemies = whole(f["enemies"], 0, limit),
                  let result = oneOf(f["result"], MatchResult.self),
                  let hostKills = whole(f["hostKills"], 0, limit), let guestKills = whole(f["guestKills"], 0, limit)
            else { return nil }
            return .match(wave: wave, enemies: enemies, result: result, hostKills: hostKills, guestKills: guestKills)
        case "nade":
            guard let p = point(f["p"], Wire.maxCoordinate), let v = point(f["v"], maxThrowSpeed) else { return nil }
            return .nade(p: p, v: v)
        case "boom":
            return point(f["p"], Wire.maxCoordinate).map { .boom(p: $0) }
        case "chat":
            let text = Sanitize.chat(f["text"]?.string ?? "")
            return text.isEmpty ? nil : .chat(text)
        case "away":
            return f["away"]?.bool.map(NetEvent.away)
        case "bye":
            return oneOf(f["reason"], ByeReason.self).map(NetEvent.bye)
        default:
            return nil
        }
    }

    // MARK: Encode

    /// `JSON.stringify(event)`, with keys in the order `parseEvent` builds them.
    public static func encode(_ event: NetEvent) -> String {
        json(event).stringify()
    }

    public static func json(_ event: NetEvent) -> JSONValue {
        func n(_ value: Double) -> JSONValue { .number(value) }
        func i(_ value: Int) -> JSONValue { .number(Double(value)) }
        func s(_ value: String) -> JSONValue { .string(value) }
        func v(_ value: Vec3) -> JSONValue { .array([n(value.x), n(value.y), n(value.z)]) }
        let pairs: [(String, JSONValue)]
        switch event {
        case .hello(let version, let name):
            pairs = [("t", s("hello")), ("v", i(version)), ("name", s(name))]
        case .lobby(let config):
            pairs = [("t", s("lobby")), ("config", json(config))]
        case .load(let config):
            pairs = [("t", s("load")), ("config", json(config))]
        case .ready(let ready):
            pairs = [("t", s("ready")), ("ready", .bool(ready))]
        case .loaded:
            pairs = [("t", s("loaded"))]
        case .go(let at):
            pairs = [("t", s("go")), ("at", n(at))]
        case .hit(let target, let attacker, let weapon, let zone, let amount, let p, let d):
            pairs = [("t", s("hit")), ("target", i(target)), ("attacker", i(attacker)), ("weapon", s(weapon.rawValue)),
                     ("zone", s(zone.rawValue)), ("amount", n(amount)), ("p", v(p)), ("d", v(d))]
        case .death(let victim, let killer, let weapon, let headshot, let life, let d):
            pairs = [("t", s("death")), ("victim", i(victim)), ("killer", i(killer)), ("weapon", s(weapon.rawValue)),
                     ("headshot", .bool(headshot)), ("life", i(life)), ("d", v(d))]
        case .action(let actor, let weapon, let stage):
            pairs = [("t", s("action")), ("actor", i(actor)), ("weapon", s(weapon.rawValue)), ("stage", s(stage.rawValue))]
        case .switchWeapon(let weapon):
            pairs = [("t", s("switch")), ("weapon", s(weapon.rawValue))]
        case .botSpawn(let id, let name, let weapon, let p, let yaw):
            pairs = [("t", s("botSpawn")), ("id", i(id)), ("name", s(name)), ("weapon", s(weapon.rawValue)), ("p", v(p)), ("yaw", n(yaw))]
        case .match(let wave, let enemies, let result, let hostKills, let guestKills):
            pairs = [("t", s("match")), ("wave", i(wave)), ("enemies", i(enemies)), ("result", s(result.rawValue)),
                     ("hostKills", i(hostKills)), ("guestKills", i(guestKills))]
        case .nade(let p, let velocity):
            pairs = [("t", s("nade")), ("p", v(p)), ("v", v(velocity))]
        case .boom(let p):
            pairs = [("t", s("boom")), ("p", v(p))]
        case .chat(let text):
            pairs = [("t", s("chat")), ("text", s(text))]
        case .away(let away):
            pairs = [("t", s("away")), ("away", .bool(away))]
        case .bye(let reason):
            pairs = [("t", s("bye")), ("reason", s(reason.rawValue))]
        }
        return .object(JSONObject(pairs))
    }

    public static func json(_ config: NetMatchConfig) -> JSONValue {
        .object(JSONObject([
            ("mapId", .string(config.mapId)),
            ("mode", .string(config.mode.rawValue)),
            ("rules", .string(config.rules.rawValue)),
            ("difficulty", .string(config.difficulty.rawValue)),
            ("botCount", .number(Double(config.botCount))),
            ("killTarget", .number(Double(config.killTarget))),
            ("duelBot", .string(config.duelBot.rawValue)),
        ]))
    }
}
