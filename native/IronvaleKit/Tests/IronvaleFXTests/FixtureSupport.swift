// Fixture loading for the IronvaleFX tests: native/Contract/fx, written by native/Tools/fx-fixtures
// from the TypeScript (src/fx run headless with Math.random replaced by mulberry32).
import Foundation
import IronvaleContract
@testable import IronvaleFX
import IronvaleWorld

let contract = try! Contract.load()
let fxDir = contract.directory.appending(path: "fx")

func fixture(_ name: String) throws -> Any {
    try JSONDecoder().decode(AnyJSON.self, from: Data(contentsOf: fxDir.appending(path: name))).value
}

/// JSON as plain values; JSONDecoder keeps every bit of a double (JSONSerialization does not).
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

func double(_ any: Any?) -> Double {
    if let d = any as? Double { return d }
    if let b = any as? Bool { return b ? 1 : 0 }
    return .nan
}
func doubles(_ any: Any?) -> [Double] { (any as? [Any] ?? []).map(double) }
func d3(_ any: Any?) -> D3 { D3(doubles(any)) }

/// Values agree to float32 precision (the buffers are float32; the CPU math is float64 on both sides).
func close(_ a: Double, _ b: Double, _ tolerance: Double = 2e-5) -> Bool {
    if a == b { return true }
    return abs(a - b) <= tolerance * max(1, abs(a), abs(b))
}

/// The world a fixture was made on.
func fixtureWorld(_ json: [String: Any]) throws -> CollisionWorld {
    let triangles = doubles(json["triangles"]).map { Float($0) }
    let surfaces = doubles(json["surfaces"]).map { Surface(rawValue: UInt8($0))! }
    return try CollisionWorld(triangles: triangles, surfaces: surfaces)
}
