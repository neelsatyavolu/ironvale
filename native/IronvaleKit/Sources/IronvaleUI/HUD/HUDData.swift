// Reads Generated/WebHUDData.swift: module-private constants of src/ui/hud/*.ts at cbe0add, extracted by
// native/Tools/ui-fixtures/hud-fixtures.test.ts (never hand-copied), and the asset manifest the credits use.
import Foundation

public struct HUDConstants: Sendable {
    // hud.ts
    public let lowHealth: Double
    public let respawnSeconds: Double
    public let toastSeconds: Double
    public let fireModes: [String: String]
    public let weaponClasses: [String: String]
    // reticle.ts
    public let arcCount: Int
    public let arcSeconds: Double
    public let arcMerge: Double
    public let arcRedraw: Double
    public let hitSeconds: Double
    public let killSeconds: Double
    // scope.ts
    public let scopeDots: [Double]
    public let scopeDotRadius: Double
    public let scopePostStart: Double
    // feed.ts
    public let feedRows: Int
    public let feedAge: Double
    // extras.ts
    public let killNoteSeconds: Double
    public let streakSeconds: Double
    public let barSeconds: Double
    public let barPool: Int
    // minimap.ts and minimap-model.ts
    public let minimapInk: String
    public let minimapEdge: String
    public let minimapWall: String
    public let minimapFloor: String
    public let minimapCone: String
    public let minimapPartner: String
    public let minimapDot: Double
    public let minimapTick: Double
    public let minimapInset: Double
    public let rippleSeconds: Double
    public let rippleGrowth: Double
    public let minimapRange: Double
    public let floorGap: Double
    public let shotSeconds: Double
    public let revealEvery: Double
    public let revealSeconds: Double
    // perf.ts
    public let perfRefreshSeconds: Double
    // chat.ts
    public let chatOpenKey: String
    public let chatLines: Int
    public let chatSeconds: Double
    // picker.ts, weapons/loadout.ts
    public let goodAt: [String: String]
    public let reservedNote: String

    public static let shared: HUDConstants = {
        do { return try HUDConstants(json: WebHUDData.json) } catch { fatalError("Generated/WebHUDData.swift does not decode: \(error)") }
    }()

    init(json source: String) throws {
        guard let root = JSValue.parse(source), let c = root["constants"] else { throw WebData.DecodeError(description: "constants") }
        func num(_ group: String, _ key: String) throws -> Double {
            guard case let .number(v)? = c[group]?[key] else { throw WebData.DecodeError(description: "\(group).\(key)") }
            return v
        }
        func text(_ group: String, _ key: String) throws -> String {
            guard case let .string(v)? = c[group]?[key] else { throw WebData.DecodeError(description: "\(group).\(key)") }
            return v
        }
        func table(_ group: String, _ key: String) throws -> [String: String] {
            guard case let .object(pairs)? = c[group]?[key] else { throw WebData.DecodeError(description: "\(group).\(key)") }
            var out: [String: String] = [:]
            for (name, value) in pairs { if case let .string(s) = value { out[name] = s } }
            return out
        }
        lowHealth = try num("hud", "LOW_HEALTH")
        respawnSeconds = try num("hud", "RESPAWN_SECONDS")
        toastSeconds = try num("hud", "TOAST_MS") / 1000
        fireModes = try table("hud", "FIRE_MODES")
        weaponClasses = try table("hud", "WEAPON_CLASSES")
        arcCount = Int(try num("reticle", "ARC_COUNT"))
        arcSeconds = try num("reticle", "ARC_SECONDS")
        arcMerge = try num("reticle", "ARC_MERGE")
        arcRedraw = try num("reticle", "ARC_REDRAW")
        hitSeconds = try num("reticle", "HIT_MS") / 1000
        killSeconds = try num("reticle", "KILL_MS") / 1000
        guard case let .array(dots)? = c["scope"]?["DOTS"] else { throw WebData.DecodeError(description: "scope.DOTS") }
        scopeDots = dots.compactMap { if case let .number(v) = $0 { v } else { nil } }
        scopeDotRadius = try num("scope", "DOT_RADIUS")
        scopePostStart = try num("scope", "POST_START")
        feedRows = Int(try num("feed", "MAX_ROWS"))
        feedAge = try num("feed", "MAX_AGE")
        killNoteSeconds = try num("extras", "KILL_NOTE_MS") / 1000
        streakSeconds = try num("extras", "STREAK_SECONDS")
        barSeconds = try num("extras", "BAR_SECONDS")
        barPool = Int(try num("extras", "BAR_POOL"))
        minimapInk = try text("minimap", "INK")
        minimapEdge = try text("minimap", "EDGE")
        minimapWall = try text("minimap", "WALL")
        minimapFloor = try text("minimap", "FLOOR")
        minimapCone = try text("minimap", "CONE")
        minimapPartner = try text("minimap", "PARTNER")
        minimapDot = try num("minimap", "DOT")
        minimapTick = try num("minimap", "TICK")
        minimapInset = try num("minimap", "INSET")
        rippleSeconds = try num("minimap", "RIPPLE_SECONDS")
        rippleGrowth = try num("minimap", "RIPPLE_GROWTH")
        minimapRange = try num("minimapModel", "range")
        floorGap = try num("minimapModel", "floorGap")
        shotSeconds = try num("minimapModel", "shotSeconds")
        revealEvery = try num("minimapModel", "revealEvery")
        revealSeconds = try num("minimapModel", "revealSeconds")
        perfRefreshSeconds = try num("perf", "REFRESH_MS") / 1000
        chatOpenKey = try text("chat", "OPEN_KEY")
        chatLines = Int(try num("chat", "MAX_LINES"))
        chatSeconds = try num("chat", "LINE_SECONDS")
        goodAt = try table("picker", "GOOD_AT")
        guard case let .string(note)? = c["reservedNote"] else { throw WebData.DecodeError(description: "reservedNote") }
        reservedNote = note
    }
}

/// A CSS colour (`#rrggbb` or `rgba(r, g, b, a)`) as straight sRGB components 0-1.
public struct HUDColor: Equatable, Sendable {
    public var r: Float, g: Float, b: Float, a: Float

    public init(_ r: Float, _ g: Float, _ b: Float, _ a: Float = 1) {
        self.r = r; self.g = g; self.b = b; self.a = a
    }

    public init(hex: UInt32, alpha: Float = 1) {
        self.init(Float((hex >> 16) & 0xFF) / 255, Float((hex >> 8) & 0xFF) / 255, Float(hex & 0xFF) / 255, alpha)
    }

    /// Parses the two forms the HUD sources use; anything else is a generator or source change and traps.
    public init(css: String) {
        let text = css.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("#"), let value = UInt32(text.dropFirst(), radix: 16), text.count == 7 {
            self.init(hex: value)
            return
        }
        if text.hasPrefix("rgba("), text.hasSuffix(")") {
            let parts = text.dropFirst(5).dropLast().split(separator: ",").compactMap { Float($0.trimmingCharacters(in: .whitespaces)) }
            if parts.count == 4 {
                self.init(parts[0] / 255, parts[1] / 255, parts[2] / 255, parts[3])
                return
            }
        }
        fatalError("unsupported CSS colour \(css)")
    }

    public func alpha(_ factor: Double) -> HUDColor { HUDColor(r, g, b, a * Float(factor)) }
}
