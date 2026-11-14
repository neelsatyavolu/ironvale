// Loads the soldier fixtures that native/Tools/asset-bake/characters-export.test.ts writes from the
// web's src/characters modules, and the baked soldier models.
import Foundation
import IronvaleCore
import Testing
@testable import IronvaleCharacters

struct FixtureError: Error, CustomStringConvertible {
    let description: String
}

enum Fixtures {
    static let contract = CharacterTables.contractDirectory()
    static let repositoryRoot = contract.deletingLastPathComponent().deletingLastPathComponent()

    static func load(_ name: String) throws -> JSONValue {
        let url = contract.appendingPathComponent("fixtures/\(name)")
        let text = try String(contentsOf: url, encoding: .utf8)
        guard let value = JSONValue.parse(text) else { throw FixtureError(description: "\(name) is not JSON") }
        return value
    }

    private static let cachedCharacters = Result { try load("characters.json") }
    static func characters() throws -> JSONValue { try cachedCharacters.get() }

    /// The baked soldier (native/Tools/asset-bake/bake.mjs). Missing output is a failure, not a skip.
    static func rig() throws -> SoldierRig {
        let dir = SoldierRig.bakedDirectory(repositoryRoot: repositoryRoot)
        guard FileManager.default.fileExists(atPath: dir.appending(path: "soldier.ivm").path) else {
            throw FixtureError(description: "\(dir.path)/soldier.ivm missing: run node native/Tools/asset-bake/bake.mjs")
        }
        return try SoldierRig(directory: dir)
    }
}

func need<T>(_ value: T?, _ what: @autoclosure () -> String) throws -> T {
    guard let value else { throw FixtureError(description: "fixture missing \(what())") }
    return value
}

extension JSONValue {
    func at(_ key: String) throws -> JSONValue { try need(self[key], key) }
    func list(_ key: String) throws -> [JSONValue] { try need(self[key]?.array, key) }
    func num(_ key: String) throws -> Double { try at(key).asNumber() }
    func flag(_ key: String) throws -> Bool { try need(self[key]?.bool, key) }
    func text(_ key: String) throws -> String { try need(self[key]?.string, key) }
    func nums(_ key: String) throws -> [Double] { try at(key).asNumbers() }

    func asNumber() throws -> Double {
        switch self {
        case .number(let n): return n
        case .string("Infinity"): return .infinity
        case .string("-Infinity"): return -.infinity
        case .string("NaN"): return .nan
        default: throw FixtureError(description: "\(self) is not a number")
        }
    }

    func asNumbers() throws -> [Double] { try need(array, "array").map { try $0.asNumber() } }
    func index(_ i: Int) throws -> JSONValue { try need(array.flatMap { i < $0.count ? $0[i] : nil }, "[\(i)]") }
}

/// Largest absolute difference, and the check against a tolerance.
func maxDiff(_ a: [Double], _ b: [Double]) -> Double {
    guard a.count == b.count else { return .infinity }
    return zip(a, b).map { abs($0 - $1) }.max() ?? 0
}

func expectClose(_ a: [Double], _ b: [Double], _ tolerance: Double, _ what: String,
                 sourceLocation: SourceLocation = #_sourceLocation) {
    let d = maxDiff(a, b)
    #expect(d <= tolerance, "\(what): max difference \(d) > \(tolerance)\n swift \(a.prefix(8))\n web   \(b.prefix(8))", sourceLocation: sourceLocation)
}

func expectClose(_ a: Double, _ b: Double, _ tolerance: Double, _ what: String,
                 sourceLocation: SourceLocation = #_sourceLocation) {
    if a.isInfinite || b.isInfinite {
        #expect(a == b, "\(what): \(a) vs \(b)", sourceLocation: sourceLocation)
    } else {
        #expect(abs(a - b) <= tolerance, "\(what): \(a) vs \(b)", sourceLocation: sourceLocation)
    }
}

/// Quaternions compared up to sign (q and -q are the same rotation).
func quatDiff(_ a: Quat, _ b: [Double]) -> Double {
    let same = maxDiff(a.array, b)
    let flipped = maxDiff(a.array.map { -$0 }, b)
    return min(same, flipped)
}
