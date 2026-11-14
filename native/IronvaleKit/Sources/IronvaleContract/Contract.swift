// Typed views of native/Contract/*.json, which native/Tools/contract-export generates from the
// web sources at the commit recorded in contract.lock (PLAN.md 5.1-5.3). Nothing here is
// hand-copied from TypeScript: every value is read from those files at run time.
import CryptoKit
import Foundation

public enum ContractError: Error, CustomStringConvertible {
    case missingDirectory
    case unreadable(String, any Error)

    public var description: String {
        switch self {
        case .missingDirectory: "native/Contract not found (set IRONVALE_CONTRACT_DIR or bundle it as a 'Contract' resource folder)"
        case .unreadable(let name, let error): "Contract/\(name): \(error)"
        }
    }
}

/// Where the Contract folder lives: `IRONVALE_CONTRACT_DIR`, a `Contract` folder in the main
/// bundle, or the source tree this module was built from (development and tests).
public enum ContractLocation {
    public static func directory() throws -> URL {
        let fileManager = FileManager.default
        if let path = ProcessInfo.processInfo.environment["IRONVALE_CONTRACT_DIR"], fileManager.fileExists(atPath: path) {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        if let bundled = Bundle.main.url(forResource: "Contract", withExtension: nil) {
            return bundled
        }
        let source = sourceTreeDirectory
        if fileManager.fileExists(atPath: source.appendingPathComponent("contract.lock").path) { return source }
        throw ContractError.missingDirectory
    }

    /// native/Contract, found from this file's path: native/IronvaleKit/Sources/IronvaleContract/.
    public static var sourceTreeDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Contract", isDirectory: true)
    }
}

/// All contract tables, loaded together.
public struct Contract: Sendable {
    public let directory: URL
    public let protocolTable: ProtocolTable
    public let weapons: WeaponsTable
    public let bodies: BodiesTable
    public let ai: AITable
    public let maps: MapsTable
    public let lock: ContractLock

    /// The files whose bytes make up `contractHash`, in hashing order (PLAN.md 5.3).
    public static let hashedFiles = ["protocol.json", "weapons.json", "bodies.json", "ai.json"]

    public init(directory: URL) throws {
        self.directory = directory
        protocolTable = try Self.decode("protocol.json", in: directory)
        weapons = try Self.decode("weapons.json", in: directory)
        bodies = try Self.decode("bodies.json", in: directory)
        ai = try Self.decode("ai.json", in: directory)
        maps = try Self.decode("maps.json", in: directory)
        lock = try Self.decode("contract.lock", in: directory)
    }

    /// Loads from `ContractLocation.directory()`.
    public static func load() throws -> Contract {
        try Contract(directory: ContractLocation.directory())
    }

    /// SHA-256 over the hashed files' bytes, as contract-export computes it.
    public func computedHash() throws -> String {
        var hasher = SHA256()
        for name in Self.hashedFiles {
            do {
                hasher.update(data: try Data(contentsOf: directory.appendingPathComponent(name)))
            } catch {
                throw ContractError.unreadable(name, error)
            }
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func decode<T: Decodable>(_ name: String, in directory: URL) throws -> T {
        do {
            let data = try Data(contentsOf: directory.appendingPathComponent(name))
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ContractError.unreadable(name, error)
        }
    }
}

public struct ContractLock: Codable, Sendable, Equatable {
    public let protocolVersion: Int
    public let contractHash: String
}

// MARK: - protocol.json

public struct ProtocolTable: Codable, Sendable {
    public struct WireLimits: Codable, Sendable {
        public let host: Int
        public let guest: Int
        public let botBase: Int
        public let maxWireId: Int
        public let maxEventChars: Int
        public let maxPellets: Int
        public let maxBotsPerSnapshot: Int
        public let maxCoordinate: Double
        public let maxTimeMs: Double
    }

    public struct Binary: Codable, Sendable {
        public let TYPE_STATE: Int
        public let TYPE_BOTS: Int
        public let TYPE_SHOT: Int
        public let TYPE_PING: Int
        public let TYPE_PONG: Int
        public let STATE_BYTES: Int
        public let BOTS_HEADER_BYTES: Int
        public let BOT_BYTES: Int
        public let SHOT_HEADER_BYTES: Int
        public let PING_BYTES: Int
        public let PONG_BYTES: Int
        public let ANGLE_SCALE: Double
        public let VELOCITY_SCALE: Double
        public let SPEED_SCALE: Double
        public let DIRECTION_SCALE: Double
    }

    public struct Events: Codable, Sendable {
        public let MODES: [String]
        public let DUEL_BOTS: [String]
        public let RULES: [String]
        public let DIFFICULTIES: [String]
        public let ZONES: [String]
        public let BYE_REASONS: [String]
        public let RESULTS: [String]
        public let STAGES: [String]
        public let MAP_ID: String
        public let MAX_DAMAGE: Double
        public let MAX_COUNT: Int
        public let MAX_THROW_SPEED: Double
        public let grenadeSource: String
        public let maxKillTarget: Int
        public let maxNetBots: Int
    }

    public struct Limits: Codable, Sendable {
        public let nameLength: Int
        public let chatLength: Int
        public let RATE_SLACK: Double
        public let BURST_SECONDS: Double
    }

    public struct Room: Codable, Sendable {
        public let alphabet: String
        public let length: Int
        public let joinParam: String
    }

    public struct Invite: Codable, Sendable {
        public let maxCodeChars: Int
        public let MAX_SDP_BYTES: Int
        public let PREFIX: [String: String]
    }

    public struct Relay: Codable, Sendable {
        public let limits: [String: Double]
        public let close: [String: Int]
    }

    public struct Transport: Codable, Sendable {
        public struct IceServer: Codable, Sendable {
            public let urls: [String]
        }

        public let GATHER_TIMEOUT_MS: Double
        public let STATE_BACKLOG_BYTES: Int
        public let EVENT_BACKLOG_BYTES: Int
        public let MAX_INCOMING_BYTES: Int
        public let MAX_SDP_CHARS: Int
        public let MAX_CANDIDATE_CHARS: Int
        public let HEALTH_TIMEOUT_MS: Double
        public let HOST_CODE_ATTEMPTS: Int
        public let STUN: IceServer
        public let MAX_EXTRA_SERVERS: Int
        public let RELAY_TIMEOUT_MS: Double
    }

    public let protocolVersion: Int
    public let wire: WireLimits
    public let binary: Binary
    public let events: Events
    public let limits: Limits
    public let room: Room
    public let invite: Invite
    /// Per source module (`match`, `session`, `interp`, `proxies`, `clock`): constant name to value.
    public let timing: [String: [String: Double]]
    public let transport: Transport
    public let relay: Relay
    public let storage: [String: String]
}

// MARK: - weapons.json

public struct WeaponDef: Codable, Sendable, Equatable {
    public struct Recoil: Codable, Sendable, Equatable {
        public let vertical: Double
        public let horizontal: Double
        public let recovery: Double
        public let kickback: Double
    }

    public let id: String
    public let name: String
    public let weaponClass: String
    public let slot: Int
    public let fireMode: String
    public let roundsPerMinute: Double
    public let damage: Double
    public let headshotMultiplier: Double
    public let limbMultiplier: Double
    public let falloffStart: Double
    public let falloffEnd: Double
    public let falloffMin: Double
    public let range: Double
    public let muzzleVelocity: Double
    public let pellets: Double
    public let spreadHip: Double
    public let spreadAim: Double
    public let spreadMoving: Double
    public let recoil: Recoil
    public let magazineSize: Int
    public let reserveAmmo: Int
    public let reloadStyle: String
    public let reloadTime: Double
    public let aimTime: Double
    public let aimZoom: Double
    public let scoped: Bool
    public let mobility: Double
    public let casing: String
    public let loudness: Double
}

public struct WeaponsTable: Codable, Sendable {
    /// Wire index order (`WEAPON_IDS` in src/weapons/models/api.ts).
    public let weaponIds: [String]
    /// One def per id, in `weaponIds` order.
    public let weapons: [WeaponDef]
    public let grenadeId: String
    public let grenadeDef: WeaponDef
    /// `GRENADE` in src/weapons/grenade-math.ts.
    public let grenade: [String: Double]

    /// The def for a gun id or the grenade id.
    public func def(_ id: String) -> WeaponDef? {
        id == grenadeId ? grenadeDef : weapons.first { $0.id == id }
    }
}

// MARK: - bodies.json

public struct BodiesTable: Codable, Sendable {
    public struct Volume: Codable, Sendable, Equatable {
        public let zone: String
        public let bottom: Double
        public let top: Double
        public let radius: Double
    }

    public struct Hitbox: Codable, Sendable {
        public let STANDING: [Volume]
        public let CROUCHING: [Volume]
    }

    public let hitbox: Hitbox
    public let remote: [String: Double]
    public let player: [String: Double]
    public let session: [String: Double]
}

// MARK: - ai.json

public struct DifficultyProfile: Codable, Sendable, Equatable {
    public let reactionTime: Double
    public let aimErrorAt20m: Double
    public let firstShotPenalty: Double
    public let aimTightenRate: Double
    public let trackingLag: Double
    public let burstLength: Double
    public let burstPause: Double
    public let damageMultiplier: Double
    public let attackers: Int
    public let health: Double
    public let visionRange: Double
    public let flankChance: Double
    public let pushFraction: Double
    public let coverUse: Double
    public let turnRate: Double
    public let memorySeconds: Double
    public let hearingScale: Double
    public let sweepDelay: Double
}

public struct RoleDef: Codable, Sendable, Equatable {
    public let weapon: String
    public let minRange: Double
    public let idealRange: Double
    public let maxRange: Double
    public let burstMin: Int
    public let burstMax: Int
    public let pauseMin: Double
    public let pauseMax: Double
    public let pushes: Bool
    public let holds: Bool
}

public struct AITable: Codable, Sendable {
    public let difficultyOrder: [String]
    public let difficulty: [String: DifficultyProfile]
    public let roles: [String: RoleDef]
}

// MARK: - maps.json

public struct MapsTable: Codable, Sendable {
    /// `PLAYABLE_MAPS` ids, in menu order.
    public let playable: [String]
    /// Every map module the registry can load.
    public let all: [String]
    /// Loadable but not offered in the menu (`range`).
    public let developer: [String]
}
