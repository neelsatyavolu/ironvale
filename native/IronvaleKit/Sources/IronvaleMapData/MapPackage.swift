// Map package loader (PLAN.md 3.7). The package is written by native/Tools/map-export from each
// map's build() (src/maps/*/index.ts at commit 185029e); field meanings follow src/world/types.ts.
import CryptoKit
import Foundation
import IronvaleWorld

public struct MapBox: Codable, Sendable, Equatable {
    public let min: [Double]
    public let max: [Double]

    public var box: Box3 { Box3(min: Vec3(min[0], min[1], min[2]), max: Vec3(max[0], max[1], max[2])) }
}

public struct SpawnPoint: Codable, Sendable, Equatable {
    /// Feet position in metres.
    public let position: [Double]
    /// Radians; 0 looks down -Z.
    public let yaw: Double

    public var point: Vec3 { Vec3(position[0], position[1], position[2]) }
}

public struct InteriorZone: Codable, Sendable, Equatable {
    public let min: [Double]
    public let max: [Double]
    public let reverb: String
    /// Fraction of sky light that reaches inside; nil means the engine default (0.45).
    public let skyLight: Double?
}

public struct AmbienceLayer: Codable, Sendable, Equatable {
    public let sound: String
    public let volume: Double
    public let position: [Double]?
    public let radius: Double?
}

public struct FogSetup: Codable, Sendable, Equatable {
    public let color: UInt32
    public let density: Double
    public let sunTint: UInt32?
    public let sunTintStrength: Double?
    public let heightFalloff: Double?
    public let baseHeight: Double?
}

public struct LightingSetup: Codable, Sendable, Equatable {
    public let hdri: String
    public let hdriRotation: Double
    public let skyIntensity: Double
    public let sunDirection: [Double]
    public let sunColor: UInt32
    public let sunIntensity: Double
    public let fog: FogSetup
    public let exposure: Double
    public let volumetric: Double
    public let shaftDensity: Double?
    public let bloom: Double
}

public struct MapMeta: Codable, Sendable, Equatable {
    public struct Spawns: Codable, Sendable, Equatable {
        public let player: [SpawnPoint]
        public let enemy: [SpawnPoint]
    }

    public struct CollisionCounts: Codable, Sendable, Equatable {
        public let triangles: Int
        public let boundaryTriangles: Int
    }

    public let format: String
    public let version: Int
    public let id: String
    public let name: String
    public let tagline: String
    public let playable: Bool
    public let detailDensity: Double
    public let assets: [String]
    /// Playable area; bots and the nav grid stay inside it.
    public let bounds: MapBox
    public let collisionBounds: MapBox
    public let spawns: Spawns
    public let weather: String
    public let reverb: String
    public let interiors: [InteriorZone]
    public let ambience: [AmbienceLayer]
    public let lighting: LightingSetup
    public let surfaceTable: [String]
    public let collision: CollisionCounts
    /// SHA-256 of collision.bin followed by boundary.bin.
    public let collisionSha256: String
    public let sourceCommit: String
}

public enum MapPackageError: Error, CustomStringConvertible, Equatable {
    case missing(String)
    case unsupported(String)
    case hashMismatch(expected: String, actual: String)

    public var description: String {
        switch self {
        case let .missing(path): "map package file missing: \(path)"
        case let .unsupported(what): "unsupported map package: \(what)"
        case let .hashMismatch(expected, actual): "map package collision hash \(actual) does not match meta.json \(expected)"
        }
    }
}

/// A loaded map package: metadata and the collision world.
public struct MapPackage: Sendable {
    public let meta: MapMeta
    public let world: CollisionWorld
    public let directory: URL

    /// Loads and validates `<directory>/meta.json`, collision.bin, boundary.bin and bvh.bin.
    public static func load(directory: URL) throws -> MapPackage {
        func read(_ name: String) throws -> Data {
            let url = directory.appending(path: name)
            guard let data = try? Data(contentsOf: url) else { throw MapPackageError.missing(url.path) }
            return data
        }
        let meta = try JSONDecoder().decode(MapMeta.self, from: read("meta.json"))
        guard meta.format == "ironvale-map-package", meta.version == 1 else {
            throw MapPackageError.unsupported("\(meta.format) v\(meta.version)")
        }
        guard meta.surfaceTable == Surface.allCases.map(\.name) else {
            throw MapPackageError.unsupported("surface table \(meta.surfaceTable)")
        }
        let collision = try read("collision.bin")
        let boundary = try read("boundary.bin")
        let actual = SHA256.hash(data: collision + boundary).map { String(format: "%02x", $0) }.joined()
        guard actual == meta.collisionSha256 else {
            throw MapPackageError.hashMismatch(expected: meta.collisionSha256, actual: actual)
        }
        let world = try CollisionPackage.load(collision: collision, boundary: boundary, bvh: read("bvh.bin"))
        guard world.main.triangleCount == meta.collision.triangles,
              (world.boundary?.triangleCount ?? 0) == meta.collision.boundaryTriangles
        else { throw MapPackageError.unsupported("triangle counts disagree with meta.json") }
        return MapPackage(meta: meta, world: world, directory: directory)
    }
}

/// The packages present under one root directory (native/MapPackages or the app's bundled copy).
public struct MapRegistry: Sendable {
    public let root: URL
    /// Package ids found under `root`, sorted.
    public let ids: [String]

    public init(root: URL) throws {
        self.root = root
        let entries = try FileManager.default.contentsOfDirectory(atPath: root.path)
        ids = entries
            .filter { FileManager.default.fileExists(atPath: root.appending(path: "\($0)/meta.json").path) }
            .sorted()
    }

    /// Whether a peer-chosen map id can be played here; unknown ids get the web's `unknown-map`.
    public func has(_ id: String) -> Bool { ids.contains(id) }

    public func load(_ id: String) throws -> MapPackage {
        guard has(id) else { throw MapPackageError.missing("\(root.path)/\(id)") }
        return try MapPackage.load(directory: root.appending(path: id))
    }
}
