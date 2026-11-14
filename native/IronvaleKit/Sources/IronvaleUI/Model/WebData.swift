// Reads Generated/WebUIData.swift: values exported from src/ by native/Tools/ui-fixtures, never hand-copied.
import Foundation

public struct BindingRow: Equatable, Sendable {
    public let label: String
    public let keys: [String]
}

public struct MapInfo: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let tagline: String
}

public struct CreditLine: Equatable, Sendable {
    public let sentence: String
    public let url: String
}

public struct CreditThanks: Equatable, Sendable {
    public let name: String
    public let url: String
    public let licence: String
    public let note: String
}

public struct CreditGroup: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let count: Int
    public let credited: [CreditLine]
    public let thanks: [CreditThanks]
}

/// The web data, decoded once. A decode failure is a generator bug, so it traps with the reason.
public struct WebData: Sendable {
    public let defaults: Settings
    public let qualityPresets: [QualityTier: JSValue]
    public let controlPresets: [ControlPreset: ControlSettings]
    public let bindingRows: [ControlPreset: [BindingRow]]
    public let controlTips: [ControlPreset: [String]]
    public let firstRunRows: [BindingRow]
    public let maps: [MapInfo]
    public let ccByURL: String
    public let credits: [CreditGroup]

    public static let shared: WebData = {
        do { return try WebData(json: WebUIData.json) } catch { fatalError("Generated/WebUIData.swift does not decode: \(error)") }
    }()

    struct DecodeError: Error, CustomStringConvertible { let description: String }

    init(json text: String) throws {
        guard let root = JSValue.parse(text) else { throw DecodeError(description: "not JSON") }
        defaults = try Settings(json: root["defaults"] ?? .null)
        var quality: [QualityTier: JSValue] = [:]
        for tier in QualityTier.allCases {
            guard let preset = root["qualityPresets"]?[tier.rawValue] else { throw DecodeError(description: "qualityPresets.\(tier)") }
            quality[tier] = preset
        }
        qualityPresets = quality
        var controls: [ControlPreset: ControlSettings] = [:]
        var rows: [ControlPreset: [BindingRow]] = [:]
        var tips: [ControlPreset: [String]] = [:]
        for preset in ControlPreset.allCases {
            controls[preset] = try ControlSettings(json: root["controlPresets"]?[preset.rawValue])
            rows[preset] = try Self.rows(root["bindingRows"]?[preset.rawValue])
            tips[preset] = try Self.strings(root["controlTips"]?[preset.rawValue])
        }
        controlPresets = controls
        bindingRows = rows
        controlTips = tips
        firstRunRows = try Self.array(root["firstRunRows"]).map { BindingRow(label: try Self.text($0["label"]), keys: [try Self.text($0["keys"])]) }
        maps = try Self.array(root["maps"]).map {
            MapInfo(id: try Self.text($0["id"]), name: try Self.text($0["name"]), tagline: try Self.text($0["tagline"]))
        }
        ccByURL = try Self.text(root["ccByUrl"])
        credits = try Self.array(root["credits"]).map { group in
            CreditGroup(
                id: try Self.text(group["id"]),
                title: try Self.text(group["title"]),
                count: Int(try Fields(value: group).number("count")),
                credited: try Self.array(group["credited"]).map { CreditLine(sentence: try Self.text($0["sentence"]), url: try Self.text($0["url"])) },
                thanks: try Self.array(group["thanks"]).map {
                    CreditThanks(name: try Self.text($0["name"]), url: try Self.text($0["url"]), licence: try Self.text($0["licence"]), note: try Self.text($0["note"]))
                }
            )
        }
    }

    private static func array(_ value: JSValue?) throws -> [JSValue] {
        guard case let .array(items) = value else { throw DecodeError(description: "expected array") }
        return items
    }

    private static func text(_ value: JSValue?) throws -> String {
        guard case let .string(text) = value else { throw DecodeError(description: "expected string") }
        return text
    }

    private static func strings(_ value: JSValue?) throws -> [String] { try array(value).map { try text($0) } }

    private static func rows(_ value: JSValue?) throws -> [BindingRow] {
        try array(value).map { BindingRow(label: try text($0["label"]), keys: try strings($0["keys"])) }
    }

    /// `graphicsForTier(tier, base)`.
    public func graphics(for tier: QualityTier, base: GraphicsSettings? = nil) -> GraphicsSettings {
        // The generated presets were decoded at load, so this cannot fail for a known tier.
        try! GraphicsSettings(
            preset: qualityPresets[tier],
            targetFps: base?.targetFps ?? 60,
            dynamicResolution: base?.dynamicResolution ?? true,
            tier: tier
        )
    }
}
