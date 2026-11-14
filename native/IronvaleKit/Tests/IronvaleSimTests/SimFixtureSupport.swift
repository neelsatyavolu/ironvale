// Shared helpers for the IronvaleSim tests: fixture files under native/Contract/sim (written by
// native/Tools/sim-fixtures from the TypeScript), the exported test worlds, and def variants.
import Foundation
import IronvaleContract
import IronvaleCore
import IronvaleMapData
@testable import IronvaleSim
import IronvaleWorld

let simData = SimData.shared
let simDir = simData.contract.directory.appending(path: "sim")
let packagesRoot = simData.contract.directory.deletingLastPathComponent().appending(path: "MapPackages")

/// A fixture as plain `[String: Any]` / `[Any]` / `Double` / `String` / `Bool` values. Parsed with
/// JSONDecoder: JSONSerialization turns long numbers into NSDecimalNumber and loses the last bits.
func fixture(_ name: String) throws -> Any {
    try JSONDecoder().decode(AnyJSON.self, from: Data(contentsOf: simDir.appending(path: name))).value
}

struct AnyJSON: Decodable {
    let value: Any

    init(from decoder: any Decoder) throws {
        if var array = try? decoder.unkeyedContainer() {
            var items: [Any] = []
            while !array.isAtEnd { items.append(try array.decode(AnyJSON.self).value) }
            value = items
        } else if let object = try? decoder.container(keyedBy: Key.self) {
            var items: [String: Any] = [:]
            for key in object.allKeys { items[key.stringValue] = try object.decode(AnyJSON.self, forKey: key).value }
            value = items
        } else {
            let single = try decoder.singleValueContainer()
            if let b = try? single.decode(Bool.self) { value = b }
            else if let d = try? single.decode(Double.self) { value = d }
            else if let s = try? single.decode(String.self) { value = s }
            else { value = NSNull() }
        }
    }

    struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue _: Int) { nil }
    }
}

func double(_ any: Any?) -> Double { (any as? Double) ?? .nan }
func doubles(_ any: Any?) -> [Double] { (any as? [Any] ?? []).map(double) }

/// A world from Contract/sim/worlds.json, built the way CollisionWorld.build() builds it.
func testWorld(_ name: String) throws -> CollisionWorld {
    let worlds = try fixture("worlds.json") as! [String: Any]
    let world = worlds[name] as! [String: Any]
    let triangles = doubles(world["triangles"]).map { Float($0) }
    let surfaces = doubles(world["surfaces"]).map { Surface(rawValue: UInt8($0))! }
    return try CollisionWorld(triangles: triangles, surfaces: surfaces)
}

func def(_ id: String) -> WeaponDef { simData.def(id)! }

/// A copy of a def with some fields replaced, as the TS tests do with `{ ...WEAPON_DEFS.x, ... }`.
func variant(_ base: WeaponDef, _ changes: [String: Any]) -> WeaponDef {
    let data = try! JSONEncoder().encode(base)
    var object = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    for (key, value) in changes { object[key] = value }
    return try! JSONDecoder().decode(WeaponDef.self, from: JSONSerialization.data(withJSONObject: object))
}

func approx(_ a: Double, _ b: Double, _ digits: Int) -> Bool {
    // `toBeCloseTo(b, digits)`: |a - b| < 10^-digits / 2.
    abs(a - b) < pow(10, -Double(digits)) / 2
}

/// Scripted ActionInput for fixtures and tests.
final class ScriptInput: ActionInput {
    var held: Set<Action> = []
    var pressed: Set<Action> = []
    var look = (dx: 0.0, dy: 0.0)
    var locked = true

    func isDown(_ action: Action) -> Bool { held.contains(action) }
    func wasPressed(_ action: Action) -> Bool { pressed.contains(action) }
    func consumeLook(dt _: Double) -> (dx: Double, dy: Double) { look }
}
