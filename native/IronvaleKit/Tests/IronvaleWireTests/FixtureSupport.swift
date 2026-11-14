// Fixture loading and JSON <-> wire struct conversion for the golden-fixture tests.
import Foundation
import IronvaleContract
import IronvaleCore
import Testing
@testable import IronvaleWire

struct FixtureError: Error, CustomStringConvertible {
    let description: String
}

enum Fixture {
    static func load(_ name: String) throws -> JSONValue {
        let url = ContractLocation.sourceTreeDirectory.appendingPathComponent("fixtures/\(name)")
        let text = try String(contentsOf: url, encoding: .utf8)
        guard let value = JSONValue.parse(text) else { throw FixtureError(description: "\(name) is not JSON") }
        return value
    }

    static func cases(_ name: String, _ key: String) throws -> [JSONValue] {
        guard let items = try load(name)[key]?.array, !items.isEmpty else { throw FixtureError(description: "\(name) has no \(key)") }
        return items
    }
}

func need<T>(_ value: T?, _ what: @autoclosure () -> String) throws -> T {
    guard let value else { throw FixtureError(description: "fixture missing \(what())") }
    return value
}

extension JSONValue {
    func num(_ key: String) throws -> Double {
        let value = try need(self[key], key)
        switch value {
        case .number(let number): return number
        case .string("NaN"): return .nan
        case .string("Infinity"): return .infinity
        case .string("-Infinity"): return -.infinity
        default: throw FixtureError(description: "\(key) is not a number")
        }
    }

    func int(_ key: String) throws -> Int { Int(try num(key)) }
    func flag(_ key: String) throws -> Bool { try need(self[key]?.bool, key) }
    func text(_ key: String) throws -> String { try need(self[key]?.string, key) }
    func weapon(_ key: String) throws -> WeaponID { try need(WeaponID(rawValue: try text(key)), key) }

    func vec(_ key: String) throws -> Vec3 {
        let items = try need(self[key]?.array, key)
        guard items.count == 3, let x = items[0].number, let y = items[1].number, let z = items[2].number else {
            throw FixtureError(description: "\(key) is not a point")
        }
        return Vec3(x, y, z)
    }
}

func hex(_ bytes: [UInt8]) -> String { bytes.map { String(format: "%02x", $0) }.joined() }

func bytes(hex text: String) -> [UInt8] {
    let digits = Array(text.utf8)
    return stride(from: 0, to: digits.count, by: 2).map { UInt8(String(decoding: digits[$0..<$0 + 2], as: UTF8.self), radix: 16)! }
}

// MARK: JSON -> structs

func playerState(_ j: JSONValue) throws -> PlayerState {
    PlayerState(
        seq: try j.int("seq"), time: try j.num("time"), x: try j.num("x"), y: try j.num("y"), z: try j.num("z"),
        vx: try j.num("vx"), vy: try j.num("vy"), vz: try j.num("vz"), yaw: try j.num("yaw"), pitch: try j.num("pitch"),
        crouching: try j.flag("crouching"), sprinting: try j.flag("sprinting"), aiming: try j.flag("aiming"),
        alive: try j.flag("alive"), onGround: try j.flag("onGround"), reloading: try j.flag("reloading"),
        weapon: try j.weapon("weapon"), health: try j.num("health"), life: try j.int("life")
    )
}

func botState(_ j: JSONValue) throws -> BotState {
    BotState(
        id: try j.int("id"), x: try j.num("x"), y: try j.num("y"), z: try j.num("z"), yaw: try j.num("yaw"),
        pitch: try j.num("pitch"), speed: try j.num("speed"), crouching: try j.flag("crouching"),
        aiming: try j.flag("aiming"), reloading: try j.flag("reloading"), alive: try j.flag("alive"), weapon: try j.weapon("weapon")
    )
}

func shotMessage(_ j: JSONValue) throws -> ShotMessage {
    let ends = try need(j["ends"]?.array, "ends").map { end -> Vec3 in
        let items = try need(end.array, "end")
        return Vec3(try need(items[0].number, "x"), try need(items[1].number, "y"), try need(items[2].number, "z"))
    }
    return ShotMessage(actor: try j.int("actor"), weapon: try j.weapon("weapon"), muzzle: try j.vec("muzzle"), direction: try j.vec("direction"), ends: ends)
}

/// An encode-case input (`kind` + `input`) as a message.
func binaryMessage(kind: String, _ j: JSONValue) throws -> BinaryMessage {
    switch kind {
    case "state": return .state(try playerState(j))
    case "bots": return .bots(seq: try j.int("seq"), time: try j.num("time"), bots: try need(j["bots"]?.array, "bots").map(botState))
    case "shot": return .shot(try shotMessage(j))
    case "ping": return .ping(id: try j.int("id"), sentAt: try j.num("sentAt"))
    case "pong": return .pong(id: try j.int("id"), sentAt: try j.num("sentAt"), remoteTime: try j.num("remoteTime"))
    default: throw FixtureError(description: "unknown kind \(kind)")
    }
}

/// A TS `decodeBinary` result (`{type, ...}`) as a message.
func decodedMessage(_ j: JSONValue) throws -> BinaryMessage {
    let type = try j.text("type")
    switch type {
    case "state": return .state(try playerState(try need(j["state"], "state")))
    case "shot": return .shot(try shotMessage(try need(j["shot"], "shot")))
    default: return try binaryMessage(kind: type, j)
    }
}

// MARK: structs -> JSON (for the reverse check)

private func n(_ value: Double) -> JSONValue { .number(value) }
private func b(_ value: Bool) -> JSONValue { .bool(value) }
private func v(_ value: Vec3) -> JSONValue { .array([n(value.x), n(value.y), n(value.z)]) }

func json(_ s: PlayerState) -> JSONValue {
    .object(JSONObject([
        ("seq", n(Double(s.seq))), ("time", n(s.time)), ("x", n(s.x)), ("y", n(s.y)), ("z", n(s.z)),
        ("vx", n(s.vx)), ("vy", n(s.vy)), ("vz", n(s.vz)), ("yaw", n(s.yaw)), ("pitch", n(s.pitch)),
        ("crouching", b(s.crouching)), ("sprinting", b(s.sprinting)), ("aiming", b(s.aiming)), ("alive", b(s.alive)),
        ("onGround", b(s.onGround)), ("reloading", b(s.reloading)), ("weapon", .string(s.weapon.rawValue)),
        ("health", n(s.health)), ("life", n(Double(s.life))),
    ]))
}

func json(_ s: BotState) -> JSONValue {
    .object(JSONObject([
        ("id", n(Double(s.id))), ("x", n(s.x)), ("y", n(s.y)), ("z", n(s.z)), ("yaw", n(s.yaw)), ("pitch", n(s.pitch)),
        ("speed", n(s.speed)), ("crouching", b(s.crouching)), ("aiming", b(s.aiming)), ("reloading", b(s.reloading)),
        ("alive", b(s.alive)), ("weapon", .string(s.weapon.rawValue)),
    ]))
}

func json(_ s: ShotMessage) -> JSONValue {
    .object(JSONObject([
        ("actor", n(Double(s.actor))), ("weapon", .string(s.weapon.rawValue)), ("muzzle", v(s.muzzle)),
        ("direction", v(s.direction)), ("ends", .array(s.ends.map(v))),
    ]))
}

/// (kind, input) in the same shape the fixtures and fixtures.ts `encodeBinary` use.
func json(_ message: BinaryMessage) -> (String, JSONValue) {
    switch message {
    case .state(let s): return ("state", json(s))
    case .bots(let seq, let time, let bots):
        return ("bots", .object(JSONObject([("seq", n(Double(seq))), ("time", n(time)), ("bots", .array(bots.map(json)))])))
    case .shot(let s): return ("shot", json(s))
    case .ping(let id, let sentAt): return ("ping", .object(JSONObject([("id", n(Double(id))), ("sentAt", n(sentAt))])))
    case .pong(let id, let sentAt, let remoteTime):
        return ("pong", .object(JSONObject([("id", n(Double(id))), ("sentAt", n(sentAt)), ("remoteTime", n(remoteTime))])))
    }
}

/// A weapon def as the limit fixtures describe it.
struct FixtureWeapon: DamageRated, FireRated {
    let id: String
    let damage: Double
    let headshotMultiplier: Double
    let roundsPerMinute: Double
    let pellets: Double

    init(_ j: JSONValue) throws {
        id = try j.text("id")
        damage = try j.num("damage")
        headshotMultiplier = try j.num("headshotMultiplier")
        roundsPerMinute = try j.num("roundsPerMinute")
        pellets = try j.num("pellets")
    }
}
