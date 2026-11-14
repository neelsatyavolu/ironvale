// Ported from src/net/limits.ts at commit cbe0add.
//
// Limits on what the other player's messages may do: a broken or tampered client cannot do
// anything a real weapon could not.
import IronvaleCore

public enum Sanitize {
    public static let nameLength = 16
    public static let chatLength = 140

    /// A chat line: `[\p{Cc}\p{Cf}]` to spaces, white space collapsed, trimmed, at most 140
    /// UTF-16 units, trimmed again. Empty when nothing is left.
    public static func chat(_ raw: String) -> String {
        var replaced = String.UnicodeScalarView()
        for scalar in raw.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .control, .format: replaced.append(" ")
            default: replaced.append(scalar)
            }
        }
        let cleaned = JS.trim(JS.collapseWhitespace(String(replaced)))
        return JS.trim(JS.slice(cleaned, chatLength))
    }

    /// A display name: drops everything outside `[\p{L}\p{N} _.'-]`, collapses white space,
    /// trims, cuts to 16 UTF-16 units and trims again; `fallback` when nothing is left.
    public static func name(_ raw: String, fallback: String = "Player") -> String {
        var kept = String.UnicodeScalarView()
        for scalar in raw.unicodeScalars where keepsInName(scalar) {
            kept.append(scalar)
        }
        let cleaned = JS.trim(JS.slice(JS.trim(JS.collapseWhitespace(String(kept))), nameLength))
        return cleaned.isEmpty ? fallback : cleaned
    }

    static func keepsInName(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar {
        case " ", "_", ".", "'", "-": return true
        default: break
        }
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber:
            return true
        default:
            return false
        }
    }
}

/// What a damage cap needs from a weapon def.
public protocol DamageRated {
    var damage: Double { get }
    var headshotMultiplier: Double { get }
}

/// What a rate gate needs from a weapon def.
public protocol FireRated {
    var id: String { get }
    var roundsPerMinute: Double { get }
    var pellets: Double { get }
}

public enum DamageCap {
    /// The most one projectile of this weapon can do: a headshot inside full-damage range.
    public static func maxHit(_ def: some DamageRated) -> Double {
        def.damage * max(1, def.headshotMultiplier)
    }

    /// Damage a reported hit is allowed to do. Anything that is not a positive number does none.
    public static func cap(_ def: some DamageRated, _ amount: Double) -> Double {
        guard amount.isFinite, amount > 0 else { return 0 }
        return min(amount, maxHit(def))
    }
}

/// Classic token bucket on a millisecond clock.
public struct TokenBucket: Sendable {
    private let perSecond: Double
    private let size: Double
    private var tokens: Double
    private var at = -Double.infinity

    public init(perSecond: Double, size: Double) {
        self.perSecond = perSecond
        self.size = size
        tokens = size
    }

    public mutating func take(now: Double, count: Double = 1) -> Bool {
        if now > at {
            if at != -.infinity {
                tokens = min(size, tokens + ((now - at) / 1000) * perSecond)
            }
            at = now
        }
        if tokens < count { return false }
        tokens -= count
        return true
    }
}

/// Holds one sender to each weapon's rate of fire, for shots and for the hits they report
/// (a shotgun reports one hit per pellet). Buckets are keyed by weapon id and sized from the
/// first def seen for that id, as in the web build.
public struct WeaponGate: Sendable {
    /// Slack over the nominal rate: frame timing and the network bunch shots together.
    static let rateSlack = 1.25
    /// Seconds of fire that may arrive at once after a stall on the reliable channel.
    static let burstSeconds = 0.75

    private var shots: [String: TokenBucket] = [:]
    private var hits: [String: TokenBucket] = [:]

    public init() {}

    public mutating func allowShot(_ def: some FireRated, now: Double) -> Bool {
        Self.take(&shots, def, perShot: 1, now: now)
    }

    public mutating func allowHit(_ def: some FireRated, now: Double) -> Bool {
        Self.take(&hits, def, perShot: max(1, def.pellets), now: now)
    }

    private static func take(_ map: inout [String: TokenBucket], _ def: some FireRated, perShot: Double, now: Double) -> Bool {
        if map[def.id] == nil {
            let perSecond = (def.roundsPerMinute / 60) * rateSlack * perShot
            let size = max(2, (perSecond * burstSeconds).rounded(.up), perShot)
            map[def.id] = TokenBucket(perSecond: perSecond, size: size)
        }
        return map[def.id]!.take(now: now)
    }
}
