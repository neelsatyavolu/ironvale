// The scripted match of native/Tools/interop/scenario.json: 30 Hz player state for the script's
// duration plus timed events and shots, all encoded with IronvaleWire. Incoming traffic is held
// to the same rules the web's MatchSync applies (src/net/match.ts at cbe0add): each shooter's
// WeaponGate, the damage cap, grenade throw speed, and blasts only from a peer that threw.
import Foundation
import IronvaleContract
import IronvaleCore
import IronvaleNet
import IronvaleWire

struct ScenarioError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// One timed send from the script.
enum ScriptedSend {
    case event(NetEvent)
    case shot(ShotMessage)
}

struct Scenario {
    let config: NetMatchConfig
    let durationMs: Double
    /// Sorted by time; ties keep script order.
    let sends: [(at: Double, send: ScriptedSend)]

    static func load(path: String, me: Int, peer: Int) throws -> Scenario {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8), let root = JSONValue.parse(text) else {
            throw ScenarioError("cannot read scenario \(path)")
        }
        guard let configJSON = root["config"], case .lobby(let config)? = EventCodec.parse(
            JSONValue.object(JSONObject([("t", .string("lobby")), ("config", configJSON)])).stringify()
        ) else { throw ScenarioError("scenario config is not a valid NetMatchConfig") }
        guard let duration = root["durationMs"]?.number, let timeline = root["timeline"]?.array else {
            throw ScenarioError("scenario needs durationMs and timeline")
        }
        var sends: [(Double, ScriptedSend)] = []
        for entry in timeline {
            guard let at = entry["at"]?.number else { throw ScenarioError("timeline entry without at") }
            let every = entry["repeat"]?["every"]?.number ?? 0
            let count = Int(entry["repeat"]?["count"]?.number ?? 1)
            let send: ScriptedSend
            if let event = entry["event"] {
                let text = substitute(event, me: me, peer: peer).stringify()
                guard let parsed = EventCodec.parse(text) else { throw ScenarioError("invalid scripted event \(text)") }
                send = .event(parsed)
            } else if let shot = entry["shot"] {
                send = .shot(try shotMessage(substitute(shot, me: me, peer: peer)))
            } else {
                throw ScenarioError("timeline entry without event or shot")
            }
            for index in 0..<count { sends.append((at + every * Double(index), send)) }
        }
        let ordered = sends.enumerated().sorted { ($0.element.0, $0.offset) < ($1.element.0, $1.offset) }.map(\.element)
        return Scenario(config: config, durationMs: duration, sends: ordered.map { (at: $0.0, send: $0.1) })
    }

    private static func substitute(_ value: JSONValue, me: Int, peer: Int) -> JSONValue {
        switch value {
        case .string("$me"): .number(Double(me))
        case .string("$peer"): .number(Double(peer))
        case .array(let items): .array(items.map { substitute($0, me: me, peer: peer) })
        case .object(let object):
            .object(JSONObject(object.keys.map { ($0, substitute(object[$0]!, me: me, peer: peer)) }))
        default: value
        }
    }

    private static func shotMessage(_ json: JSONValue) throws -> ShotMessage {
        func vec(_ value: JSONValue?) throws -> Vec3 {
            guard let items = value?.array?.compactMap(\.number), items.count == 3 else { throw ScenarioError("bad vector in shot") }
            return Vec3(items[0], items[1], items[2])
        }
        guard let actor = json["actor"]?.number, let weaponName = json["weapon"]?.string,
              let weapon = WeaponID(rawValue: weaponName), let ends = json["ends"]?.array else {
            throw ScenarioError("bad scripted shot")
        }
        return ShotMessage(actor: Int(actor), weapon: weapon, muzzle: try vec(json["muzzle"]),
                           direction: try vec(json["direction"]), ends: try ends.map { try vec($0) })
    }
}

/// Runs the script against a connected session and checks what the peer sends.
@MainActor
final class MatchScript {
    private let scenario: Scenario
    private let session: NetLobbySession
    private let log: PeerLog
    private let weapons: WeaponsTable
    private let maxThrowSpeed: Double
    let me: Int
    let peer: Int

    private var startedAt: Double?
    private var nextSend = 0
    private var seq = 0
    private var weapon: WeaponID = .m4a1
    private var gates: [Int: WeaponGate] = [:]
    private var peerGrenades = 0
    private(set) var finSent = false
    private(set) var finReceived = false
    private(set) var rejections = 0
    private(set) var statesSent = 0
    private(set) var statesReceived = 0

    init(scenario: Scenario, session: NetLobbySession, log: PeerLog, contract: Contract, role: PeerRole) {
        self.scenario = scenario
        self.session = session
        self.log = log
        weapons = contract.weapons
        let slack = contract.protocolTable.timing["match"]?["GRENADE_SPEED_SLACK"] ?? 1
        maxThrowSpeed = (contract.weapons.grenade["throwSpeed"] ?? 0) * slack
        me = role == .host ? Wire.host : Wire.guest
        peer = role == .host ? Wire.guest : Wire.host
    }

    var running: Bool { startedAt != nil }

    func start(now: Double) {
        guard startedAt == nil else { return }
        startedAt = now
        log.write("stream-start")
    }

    func tick(now: Double) {
        guard let startedAt else { return }
        let elapsed = now - startedAt
        while nextSend < scenario.sends.count, scenario.sends[nextSend].at <= elapsed {
            switch scenario.sends[nextSend].send {
            case .event(let event):
                if case .switchWeapon(let next) = event { weapon = next }
                session.send(event)
            case .shot(let shot):
                session.sendShot(BinaryCodec.encodeShot(shot))
            }
            nextSend += 1
        }
        if elapsed < scenario.durationMs {
            // Exactly 30 per second of script: a late tick catches up rather than skipping a frame.
            while statesSent < Int((elapsed * 30 / 1000).rounded(.down)) + 1 {
                sendState(now: now, elapsed: elapsed)
            }
        } else if !finSent, nextSend == scenario.sends.count {
            finSent = true
            session.sendChat("fin")
            log.write("stream-end", [("statesSent", .number(Double(statesSent)))])
        }
    }

    private func sendState(now: Double, elapsed: Double) {
        let angle = elapsed / 1000
        let state = PlayerState(
            seq: seq & 0xFFFF, time: now,
            x: 3 * cos(angle) + Double(me), y: 0.02, z: 3 * sin(angle),
            vx: -3 * sin(angle), vy: 0, vz: 3 * cos(angle),
            yaw: BinaryCodec.wrapAngle(angle + .pi / 2), pitch: -0.05,
            crouching: false, sprinting: elapsed > 5000, aiming: elapsed < 2000,
            alive: true, onGround: true, reloading: false,
            weapon: weapon, health: 100, life: 0
        )
        seq += 1
        statesSent += 1
        session.sendState(BinaryCodec.encodeState(state))
    }

    // MARK: - incoming

    func chat(_ text: String, mine: Bool) {
        if !mine, text == "fin" { finReceived = true }
    }

    func received(_ message: BinaryMessage, now: Double) {
        switch message {
        case .state:
            statesReceived += 1
        case .shot(let shot):
            guard shot.actor == peer else { return reject("shot from \(shot.actor)") }
            guard let def = weapons.def(shot.weapon.rawValue), allow(shot.actor, { $0.allowShot(def, now: now) }) else {
                return reject("shot over the rate gate")
            }
        case .bots:
            reject("bot snapshot in a duel without bots")
        case .ping, .pong:
            break
        }
    }

    func received(_ event: NetEvent, now: Double) {
        switch event {
        case .hit(let target, let attacker, let source, _, let amount, _, _):
            guard target == me, attacker == peer else { return reject("hit \(attacker)->\(target)") }
            guard let def = weapons.def(source.rawValue) else { return reject("hit with unknown weapon") }
            let allowed = source == .grenade ? peerGrenades > 0 : allow(attacker) { $0.allowHit(def, now: now) }
            guard allowed else { return reject("hit over the rate gate") }
            guard DamageCap.cap(def, amount) == amount else { return reject("hit over the damage cap") }
        case .death(let victim, let killer, _, _, _, _):
            guard victim == me, killer == peer else { return reject("death \(killer)->\(victim)") }
        case .action(let actor, _, _):
            guard actor == peer else { return reject("action from \(actor)") }
        case .nade(_, let v):
            guard (v * v).sum().squareRoot() <= maxThrowSpeed else { return reject("grenade thrown too fast") }
            peerGrenades += 1
        case .switchWeapon, .boom:
            break
        default:
            reject("unexpected match event")
        }
    }

    /// One WeaponGate per shooter, as MatchSync keeps them.
    private func allow(_ wire: Int, _ check: (inout WeaponGate) -> Bool) -> Bool {
        var gate = gates[wire] ?? WeaponGate()
        let allowed = check(&gate)
        gates[wire] = gate
        return allowed
    }

    private func reject(_ reason: String) {
        rejections += 1
        log.write("reject", [("reason", .string(reason))])
    }
}
