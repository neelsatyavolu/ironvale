// Ported from src/net/wire.ts and src/weapons/models/api.ts (WEAPON_IDS) at commit cbe0add.
// Every value here is checked against native/Contract/protocol.json and weapons.json by
// IronvaleWireTests, so drift in the web build fails the tests rather than cross-play.

/// Constants shared by the binary messages and the JSON events.
public enum Wire {
    public static let protocolVersion = 4
    /// Ids on the wire: the two players, then the host's bots.
    public static let host = 0
    public static let guest = 1
    public static let botBase = 2
    public static let maxWireId = 0xFFFF
    public static let maxEventChars = 2048
    public static let maxPellets = 12
    public static let maxBotsPerSnapshot = 48
    /// No map is this large; a position beyond it is a broken or hostile packet.
    public static let maxCoordinate: Double = 5000
    public static let maxTimeMs: Double = 1e12
}

/// Gun ids. **`allCases` order is the wire index** (`WEAPON_IDS`); never reorder, only append.
public enum WeaponID: String, CaseIterable, Sendable {
    case m4a1, mp5, m24, m249, m7, scarh

    public var wireIndex: Int { Self.allCases.firstIndex(of: self)! }

    public init?(wireIndex: Int) {
        guard Self.allCases.indices.contains(wireIndex) else { return nil }
        self = Self.allCases[wireIndex]
    }
}

/// What a hit or a death can be put down to: a gun, or a grenade (`DamageSource` in events.ts).
public enum DamageSource: Sendable, Equatable {
    case weapon(WeaponID)
    case grenade

    /// `GRENADE_SOURCE` in events.ts.
    public static let grenadeID = "grenade"

    public init?(rawValue: String) {
        if rawValue == Self.grenadeID {
            self = .grenade
        } else if let weapon = WeaponID(rawValue: rawValue) {
            self = .weapon(weapon)
        } else {
            return nil
        }
    }

    public var rawValue: String {
        switch self {
        case .weapon(let weapon): weapon.rawValue
        case .grenade: Self.grenadeID
        }
    }
}

public typealias Vec3 = SIMD3<Double>
