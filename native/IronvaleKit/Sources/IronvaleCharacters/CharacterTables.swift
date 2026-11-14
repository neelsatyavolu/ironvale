// The soldier's constants, read at run time from native/Contract/characters.json, which
// native/Tools/asset-bake/characters-export.test.ts extracts from src/characters/*.ts (PLAN.md 5.2:
// never hand-copy what the exporter can extract). Values the extractor cannot read (THREE.Vector3
// literals and bands ending in Infinity) are ported in the files that use them, each citing its
// source, and are pinned by the fixtures in native/Contract/fixtures/characters.json.
import Foundation

public struct CharacterTables: Sendable, Decodable {
    public struct ClipMeta: Sendable, Decodable {
        public let duration: Double
        public let frames: Int
        public let loop: Bool
        public let speed: Double?
        public let strike: Double?
    }

    public struct Grip: Sendable, Decodable {
        public let position: [Double]
        public let fingers: [Double]
        public let thumb: [Double]
    }

    public struct Carbine: Sendable, Decodable {
        public let muzzle: [Double]
        public let butt: [Double]
        public let trigger: Grip
        public let support: Grip
        public let magazine: Grip
    }

    public struct Sight: Sendable, Decodable {
        public let height: Double
        public let maxRaise: Double
        public let maxShift: Double
    }

    public struct DeathVariant: Sendable, Decodable {
        public let clip: String
        public let rate: Double
        public let start: Double
    }

    public struct Death: Sendable, Decodable {
        public let variants: [String: DeathVariant]
        public let blendTime: Double
        public let ikRelease: Double
        public let turnTime: Double
        public let maxTurn: Double
        public let frontCone: Double
    }

    public struct LOD: Sendable, Decodable {
        public let midDistance: Double
        public let midInterval: Int
        public let farDistance: Double
        public let farInterval: Int
        public let hiddenInterval: Int
        public let hiddenAfterFrames: Int
    }

    public struct Tuning: Sendable, Decodable {
        public let crouchTime, aimTime, carryTime, aimHold, carrySpeed: Double
        public let bladeAimed, bladeReady, readyLean, aimLean, crouchLean, crouchMoveLean: Double
        public let paceLean, maxPaceLean, chestPitchShare, carryLean, chestHold, carryHold, headHold: Double
        public let cheekRoll, sightNod, aimShrug, maxPitch, collarSettle, reloadSeconds: Double
        public let minHeadingSpeed, headingRate: Double
    }

    public struct Tint: Sendable, Decodable {
        public let color: Int
        public let gain: Double
        public let amount: Double
    }

    public let clipFps: Double
    public let clipMeta: [String: ClipMeta]
    public let clipBones: [String]
    public let ankleHeight: Double
    public let carbine: Carbine
    public let sight: Sight
    public let death: Death
    public let lod: LOD
    public let tuning: Tuning
    public let spineShare: [String: Double]
    public let teamTint: [String: Tint]
    public let fingerCurl: [String: [Double]]
    public let thumbFold: [String: [Double]]
    public let flinchRise: Double
    public let shotInterval: Double
    public let recoilDecay: Double
    public let palmForward: Double
    public let palmDepth: Double
    public let forearmTwistShare: Double
    public let maxReach: Double
    public let maxCadence: Double
    public let maxHipYaw: Double
    public let reverseAngle: Double
    public let reverseHysteresis: Double
    public let gravity: Double
    public let dropSpeed: Double
    public let restHeight: Double

    enum CodingKeys: String, CodingKey {
        case clipFps, clipMeta, clipBones, ankleHeight, carbine, sight, death, lod
        case tuning = "TUNING", spineShare = "SPINE_SHARE", teamTint = "TEAM_TINT"
        case fingerCurl = "FINGER_CURL", thumbFold = "THUMB_FOLD"
        case flinchRise = "FLINCH_RISE", shotInterval = "SHOT_INTERVAL", recoilDecay = "RECOIL_DECAY"
        case palmForward = "PALM_FORWARD", palmDepth = "PALM_DEPTH", forearmTwistShare = "FOREARM_TWIST_SHARE"
        case maxReach = "MAX_REACH", maxCadence = "MAX_CADENCE", maxHipYaw = "MAX_HIP_YAW"
        case reverseAngle = "REVERSE_ANGLE", reverseHysteresis = "REVERSE_HYSTERESIS"
        case gravity = "GRAVITY", dropSpeed = "DROP_SPEED", restHeight = "REST_HEIGHT"
    }

    public func clip(_ name: String) -> ClipMeta {
        guard let meta = clipMeta[name] else { preconditionFailure("characters.json has no clip \(name)") }
        return meta
    }

    public func boneIndex(_ name: String) -> Int {
        guard let index = clipBones.firstIndex(of: name) else { preconditionFailure("characters.json has no bone \(name)") }
        return index
    }

    public enum LoadError: Error, CustomStringConvertible {
        case missing(String)
        public var description: String {
            switch self { case .missing(let path): "characters.json not found at \(path) (run native/Tools/asset-bake/characters-export.sh)" }
        }
    }

    /// native/Contract, from `IRONVALE_CONTRACT_DIR`, a bundled `Contract` folder, or the source tree.
    public static func contractDirectory() -> URL {
        if let path = ProcessInfo.processInfo.environment["IRONVALE_CONTRACT_DIR"] { return URL(fileURLWithPath: path) }
        if let bundled = Bundle.main.url(forResource: "Contract", withExtension: nil) { return bundled }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Contract", isDirectory: true)
    }

    public static func load(from directory: URL = contractDirectory()) throws -> CharacterTables {
        let url = directory.appendingPathComponent("characters.json")
        guard let data = try? Data(contentsOf: url) else { throw LoadError.missing(url.path) }
        return try JSONDecoder().decode(CharacterTables.self, from: data)
    }

    /// Loaded once per process; the file is generated and fixed for a build.
    public static let shared: CharacterTables = {
        do { return try load() } catch { fatalError("\(error)") }
    }()
}

extension Array where Element == Double {
    var vec3: Vec3 { Vec3(self[0], self[1], self[2]) }
}
