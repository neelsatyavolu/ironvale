// Ported from SettingsStore in src/core/settings.ts and readStored/writeStored in src/ui/dom.ts at cbe0add.
// Values are the same JSON strings the web keeps in localStorage, under the same keys (PLAN.md 3.12).
import Foundation
import Observation

/// Where interface state is kept: `UserDefaults` in the app, memory in tests.
@MainActor
public protocol StringStore: AnyObject {
    func string(forKey key: String) -> String?
    func set(_ value: String, forKey key: String)
}

@MainActor
public final class DefaultsStringStore: StringStore {
    private let defaults: UserDefaults
    public init(_ defaults: UserDefaults = .standard) { self.defaults = defaults }
    public func string(forKey key: String) -> String? { defaults.string(forKey: key) }
    public func set(_ value: String, forKey key: String) { defaults.set(value, forKey: key) }
}

@MainActor
public final class MemoryStringStore: StringStore {
    public private(set) var values: [String: String]
    public init(_ values: [String: String] = [:]) { self.values = values }
    public func string(forKey key: String) -> String? { values[key] }
    public func set(_ value: String, forKey key: String) { values[key] = value }
}

@MainActor
@Observable
public final class SettingsStore {
    public private(set) var value: Settings
    @ObservationIgnored private let storage: StringStore?

    /// `gpuName` is asked once, on a first run with nothing saved, to pick a starting tier for slower GPUs.
    public init(storage: StringStore?, gpuName: () -> String? = { nil }) {
        self.storage = storage
        let raw = storage?.string(forKey: Settings.storageKey)
        value = Settings.parse(raw)
        if storage != nil, raw == nil, let name = gpuName(), let tier = SettingsModel.tierForGpu(name), tier != value.graphics.tier {
            value.graphics = WebData.shared.graphics(for: tier, base: value.graphics)
            save()
        }
    }

    /// Replace the settings with a changed copy and save it.
    public func update(_ change: (inout Settings) -> Void) {
        var next = value
        change(&next)
        guard next != value else { return }
        value = next
        save()
    }

    private func save() {
        storage?.set(value.stringify(), forKey: Settings.storageKey)
    }
}

/// `readStored`/`writeStored`: a flat JSON object merged over defaults, keeping values whose type matches.
@MainActor
enum StoredJSON {
    static func read(_ storage: StringStore?, key: String, defaults: [(String, JSValue)]) -> [String: JSValue] {
        var merged = Dictionary(uniqueKeysWithValues: defaults)
        guard let raw = storage?.string(forKey: key), !raw.isEmpty, let data = JSValue.parse(raw), data.isRecord else { return merged }
        for (name, fallback) in defaults {
            if let value = data[name], value.typeName == fallback.typeName { merged[name] = value }
        }
        return merged
    }

    static func write(_ storage: StringStore?, key: String, value: [(String, JSValue)]) {
        storage?.set(JSValue.object(value).stringify(), forKey: key)
    }
}

/// The menu's remembered choices (`ironvale.menu.v1`, src/ui/screens/menu.ts).
public struct MenuChoices: Equatable, Sendable {
    public static let storageKey = "ironvale.menu.v1"
    public static let botRange = 4...16
    public static let defaultBots = 8

    public enum Mode: String, Sendable, CaseIterable { case skirmish, survival }

    public var mapId: String
    public var mode: Mode
    public var botCount: Int

    @MainActor
    static func load(_ storage: StringStore?, maps: [MapInfo]) -> MenuChoices {
        let first = maps.first?.id ?? ""
        let stored = StoredJSON.read(storage, key: storageKey, defaults: [
            ("mapId", .string(first)), ("mode", .string("skirmish")), ("botCount", .number(Double(defaultBots))),
        ])
        var mapId = first
        if case let .string(id) = stored["mapId"], maps.contains(where: { $0.id == id }) { mapId = id }
        let mode: Mode = stored["mode"] == .string("survival") ? .survival : .skirmish
        var bots = defaultBots
        if case let .number(n) = stored["botCount"], n.isFinite {
            // Math.round rounds halves up; clamp before converting so huge values cannot overflow Int.
            let rounded = (n + 0.5).rounded(.down)
            bots = Int(min(Double(botRange.upperBound), max(Double(botRange.lowerBound), rounded)))
        }
        return MenuChoices(mapId: mapId, mode: mode, botCount: bots)
    }

    @MainActor
    func save(_ storage: StringStore?) {
        StoredJSON.write(storage, key: Self.storageKey, value: [
            ("mapId", .string(mapId)), ("mode", .string(mode.rawValue)), ("botCount", .number(Double(botCount))),
        ])
    }
}

/// The one-time trackpad card (`ironvale.firstRun.v1`, src/ui/index.ts).
enum FirstRun {
    static let storageKey = "ironvale.firstRun.v1"

    @MainActor static func seen(_ storage: StringStore?) -> Bool {
        StoredJSON.read(storage, key: storageKey, defaults: [("seen", .bool(false))])["seen"] == .bool(true)
    }

    @MainActor static func markSeen(_ storage: StringStore?) {
        StoredJSON.write(storage, key: storageKey, value: [("seen", .bool(true))])
    }
}
