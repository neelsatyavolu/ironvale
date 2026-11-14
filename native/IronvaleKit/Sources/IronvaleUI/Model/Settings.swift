// Ported from src/core/settings.ts at cbe0add. Preset values are read from Generated/WebUIData.swift,
// which native/Tools/ui-fixtures writes from the TypeScript; only the validation rules are hand-ported
// (they are not exported) and the web fixtures check them.
import Foundation

public enum QualityTier: String, CaseIterable, Sendable { case low, medium, high, ultra }
public enum AntiAliasing: String, CaseIterable, Sendable { case none, fxaa, traa }
public enum TextureTier: String, CaseIterable, Sendable { case k1 = "1k", k2 = "2k" }
public enum ControlPreset: String, CaseIterable, Sendable { case trackpad, mouse }
public enum Difficulty: String, CaseIterable, Sendable { case recruit, regular, veteran, elite }

public struct GraphicsSettings: Equatable, Sendable {
    public var targetFps: Int
    public var dynamicResolution: Bool
    public var renderScale: Double
    public var shadowMapSize: Int
    public var ambientOcclusion: Bool
    public var reflections: Bool
    public var volumetricLight: Bool
    public var bloom: Bool
    public var antiAliasing: AntiAliasing
    public var textures: TextureTier
    public var anisotropy: Int
    public var detailDensity: Double
    public var particleDensity: Double
    public var filmGrain: Bool
    public var tier: QualityTier
}

public struct ControlSettings: Equatable, Sendable {
    public var preset: ControlPreset
    public var sensitivity: Double
    public var adsSensitivity: Double
    public var invertY: Bool
    public var adsToggle: Bool
    public var aimAssist: Double
    public var lookSmoothing: Double
    public var rawInput: Bool
}

public struct AudioSettings: Equatable, Sendable {
    public var master: Double
    public var effects: Double
    public var ambience: Double
    public var interface: Double
    public var hrtf: Bool
}

public struct GameplaySettings: Equatable, Sendable {
    public var difficulty: Difficulty
    public var fov: Double
    public var headBob: Double
    public var showHitMarkers: Bool
    public var crosshair: Bool
    public var minimap: Bool
}

public struct Settings: Equatable, Sendable {
    public var graphics: GraphicsSettings
    public var controls: ControlSettings
    public var audio: AudioSettings
    public var gameplay: GameplaySettings

    public static let storageKey = "ironvale.settings.v1"
    public static var defaults: Settings { WebData.shared.defaults }

    /// `parseSettings`: merge a stored string over the defaults, keeping only values of the right type that the rules allow.
    public static func parse(_ raw: String?) -> Settings {
        guard let raw, !raw.isEmpty, let data = JSValue.parse(raw), case var .object(pairs) = data else { return defaults }
        // The first release shipped look speeds that were far too slow; untouched old defaults get the new one.
        if let index = pairs.firstIndex(where: { $0.0 == "controls" }), case var .object(controls) = pairs[index].1 {
            let isMouse = JSValue.object(controls)["preset"] == .string("mouse")
            let old: Double = isMouse ? 22 : 34
            if JSValue.object(controls)["sensitivity"] == .number(old) {
                let preset: ControlPreset = isMouse ? .mouse : .trackpad
                let fresh = JSValue.number(WebData.shared.controlPresets[preset]!.sensitivity)
                controls.removeAll { $0.0 == "sensitivity" }
                controls.append(("sensitivity", fresh))
                pairs[index] = ("controls", .object(controls))
            }
        }
        let stored = JSValue.object(pairs)
        let base = defaults.json
        func merged(_ section: String, _ rules: [String: Rule]) -> JSValue {
            SettingsRules.merge(defaults: base[section]!, stored: stored[section], rules: rules)
        }
        let result = JSValue.object([
            ("graphics", merged("graphics", SettingsRules.graphics)),
            ("controls", merged("controls", SettingsRules.controls)),
            ("audio", merged("audio", SettingsRules.audio)),
            ("gameplay", merged("gameplay", SettingsRules.gameplay)),
        ])
        return (try? Settings(json: result)) ?? defaults
    }

    /// `JSON.stringify(settings)`, byte for byte what the web build stores.
    public func stringify() -> String { json.stringify() }
}

/// What a stored value may be: one of a list, or a number inside a range (clamped).
enum Rule {
    case oneOf([JSValue])
    case range(Double, Double)
}

enum SettingsRules {
    static let unit = Rule.range(0, 1)
    static func numbers(_ values: [Double]) -> Rule { .oneOf(values.map(JSValue.number)) }
    static func strings(_ values: [String]) -> Rule { .oneOf(values.map(JSValue.string)) }

    static let graphics: [String: Rule] = [
        "tier": strings(QualityTier.allCases.map(\.rawValue)),
        "renderScale": .range(0.25, 1),
        "targetFps": numbers([30, 60, 120]),
        "shadowMapSize": numbers([0, 1024, 2048, 4096]),
        "antiAliasing": strings(AntiAliasing.allCases.map(\.rawValue)),
        "textures": strings(TextureTier.allCases.map(\.rawValue)),
        "anisotropy": numbers([1, 4, 8, 16]),
        "detailDensity": unit,
        "particleDensity": unit,
    ]
    static let controls: [String: Rule] = [
        "preset": strings(ControlPreset.allCases.map(\.rawValue)),
        "sensitivity": .range(1, 400),
        "adsSensitivity": .range(0.1, 2),
        "aimAssist": unit,
        "lookSmoothing": unit,
    ]
    static let audio: [String: Rule] = ["master": unit, "effects": unit, "ambience": unit, "interface": unit]
    static let gameplay: [String: Rule] = [
        "difficulty": strings(Difficulty.allCases.map(\.rawValue)),
        "fov": .range(50, 120),
        "headBob": unit,
    ]

    /// `mergeSection`.
    static func merge(defaults: JSValue, stored: JSValue?, rules: [String: Rule]) -> JSValue {
        guard case let .object(base) = defaults, let stored, stored.isRecord else { return defaults }
        return .object(base.map { key, fallback in
            guard let value = stored[key], value.typeName == fallback.typeName else { return (key, fallback) }
            switch rules[key] {
            case nil: return (key, value)
            case let .oneOf(allowed): return (key, allowed.contains(value) ? value : fallback)
            case let .range(low, high):
                guard case let .number(number) = value else { return (key, fallback) }
                return (key, .number(min(high, max(low, number))))
            }
        })
    }
}

struct SettingsDecodeError: Error { let key: String }

extension Settings {
    var json: JSValue {
        .object([("graphics", graphics.json), ("controls", controls.json), ("audio", audio.json), ("gameplay", gameplay.json)])
    }

    init(json: JSValue) throws {
        graphics = try GraphicsSettings(json: json["graphics"])
        controls = try ControlSettings(json: json["controls"])
        audio = try AudioSettings(json: json["audio"])
        gameplay = try GameplaySettings(json: json["gameplay"])
    }
}

/// Strict field readers for objects that already passed the rules (or come from the generated web data).
struct Fields {
    let value: JSValue?
    func number(_ key: String) throws -> Double {
        guard case let .number(n) = value?[key] else { throw SettingsDecodeError(key: key) }
        return n
    }
    func int(_ key: String) throws -> Int { Int(try number(key)) }
    func bool(_ key: String) throws -> Bool {
        guard case let .bool(b) = value?[key] else { throw SettingsDecodeError(key: key) }
        return b
    }
    func choice<T: RawRepresentable>(_ key: String) throws -> T where T.RawValue == String {
        guard case let .string(s) = value?[key], let v = T(rawValue: s) else { throw SettingsDecodeError(key: key) }
        return v
    }
}

extension GraphicsSettings {
    /// Key order is `graphicsForTier`'s: targetFps, dynamicResolution, the preset fields, tier.
    var json: JSValue {
        .object([
            ("targetFps", .number(Double(targetFps))), ("dynamicResolution", .bool(dynamicResolution)),
        ] + presetFields + [("tier", .string(tier.rawValue))])
    }

    /// The fields a quality preset sets, in `QUALITY_PRESETS` order.
    var presetFields: [(String, JSValue)] {
        [
            ("renderScale", .number(renderScale)), ("shadowMapSize", .number(Double(shadowMapSize))),
            ("ambientOcclusion", .bool(ambientOcclusion)), ("reflections", .bool(reflections)),
            ("volumetricLight", .bool(volumetricLight)), ("bloom", .bool(bloom)),
            ("antiAliasing", .string(antiAliasing.rawValue)), ("textures", .string(textures.rawValue)),
            ("anisotropy", .number(Double(anisotropy))), ("detailDensity", .number(detailDensity)),
            ("particleDensity", .number(particleDensity)), ("filmGrain", .bool(filmGrain)),
        ]
    }

    init(json: JSValue?) throws {
        let f = Fields(value: json)
        try self.init(preset: json, targetFps: f.int("targetFps"), dynamicResolution: f.bool("dynamicResolution"), tier: f.choice("tier"))
    }

    /// Builds from an object carrying the preset fields, as `QUALITY_PRESETS[tier]` does.
    init(preset json: JSValue?, targetFps: Int, dynamicResolution: Bool, tier: QualityTier) throws {
        let f = Fields(value: json)
        self.targetFps = targetFps
        self.dynamicResolution = dynamicResolution
        renderScale = try f.number("renderScale")
        shadowMapSize = try f.int("shadowMapSize")
        ambientOcclusion = try f.bool("ambientOcclusion")
        reflections = try f.bool("reflections")
        volumetricLight = try f.bool("volumetricLight")
        bloom = try f.bool("bloom")
        antiAliasing = try f.choice("antiAliasing")
        textures = try f.choice("textures")
        anisotropy = try f.int("anisotropy")
        detailDensity = try f.number("detailDensity")
        particleDensity = try f.number("particleDensity")
        filmGrain = try f.bool("filmGrain")
        self.tier = tier
    }
}

extension ControlSettings {
    var json: JSValue {
        .object([
            ("preset", .string(preset.rawValue)), ("sensitivity", .number(sensitivity)),
            ("adsSensitivity", .number(adsSensitivity)), ("invertY", .bool(invertY)), ("adsToggle", .bool(adsToggle)),
            ("aimAssist", .number(aimAssist)), ("lookSmoothing", .number(lookSmoothing)), ("rawInput", .bool(rawInput)),
        ])
    }

    init(json: JSValue?) throws {
        let f = Fields(value: json)
        preset = try f.choice("preset")
        sensitivity = try f.number("sensitivity")
        adsSensitivity = try f.number("adsSensitivity")
        invertY = try f.bool("invertY")
        adsToggle = try f.bool("adsToggle")
        aimAssist = try f.number("aimAssist")
        lookSmoothing = try f.number("lookSmoothing")
        rawInput = try f.bool("rawInput")
    }
}

extension AudioSettings {
    var json: JSValue {
        .object([
            ("master", .number(master)), ("effects", .number(effects)), ("ambience", .number(ambience)),
            ("interface", .number(interface)), ("hrtf", .bool(hrtf)),
        ])
    }

    init(json: JSValue?) throws {
        let f = Fields(value: json)
        master = try f.number("master")
        effects = try f.number("effects")
        ambience = try f.number("ambience")
        interface = try f.number("interface")
        hrtf = try f.bool("hrtf")
    }
}

extension GameplaySettings {
    var json: JSValue {
        .object([
            ("difficulty", .string(difficulty.rawValue)), ("fov", .number(fov)), ("headBob", .number(headBob)),
            ("showHitMarkers", .bool(showHitMarkers)), ("crosshair", .bool(crosshair)), ("minimap", .bool(minimap)),
        ])
    }

    init(json: JSValue?) throws {
        let f = Fields(value: json)
        difficulty = try f.choice("difficulty")
        fov = try f.number("fov")
        headBob = try f.number("headBob")
        showHitMarkers = try f.bool("showHitMarkers")
        crosshair = try f.bool("crosshair")
        minimap = try f.bool("minimap")
    }
}
