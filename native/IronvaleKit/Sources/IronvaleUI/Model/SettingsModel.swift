// Ported from src/ui/settings-model.ts and tierForGpu in src/core/settings.ts at cbe0add.
import Foundation

public enum SettingsModel {
    public static func tierName(_ tier: QualityTier) -> String {
        switch tier {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .ultra: "Ultra"
        }
    }

    private static func matches(_ graphics: GraphicsSettings, _ tier: QualityTier) -> Bool {
        let preset = WebData.shared.graphics(for: tier, base: graphics)
        return zip(graphics.presetFields, preset.presetFields).allSatisfy { $0.1 == $1.1 }
    }

    /// The tier whose preset the settings equal, or nil when something was changed by hand.
    public static func matchTier(_ graphics: GraphicsSettings) -> QualityTier? {
        if matches(graphics, graphics.tier) { return graphics.tier }
        return QualityTier.allCases.first { matches(graphics, $0) }
    }

    public static func presetLabel(_ graphics: GraphicsSettings) -> String {
        matchTier(graphics).map(tierName) ?? "Custom"
    }

    /// Change graphics fields; `tier` follows the values when they land on a preset.
    public static func patchGraphics(_ graphics: GraphicsSettings, _ patch: (inout GraphicsSettings) -> Void) -> GraphicsSettings {
        var next = graphics
        patch(&next)
        next.tier = graphics.tier
        if let tier = matchTier(next), tier != next.tier { next.tier = tier }
        return next
    }

    /// Switch to a preset, keeping the choices that are not part of one.
    public static func applyTier(_ graphics: GraphicsSettings, _ tier: QualityTier) -> GraphicsSettings {
        WebData.shared.graphics(for: tier, base: graphics)
    }

    /// First-run tier from the GPU name (`MTLDevice.name` on native).
    public static func tierForGpu(_ name: String) -> QualityTier? {
        func test(_ pattern: String) -> Bool {
            name.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
        }
        if test(#"swiftshader|llvmpipe|software|\bintel\b"#) { return .low }
        if test(#"apple m[12](?!\d)(?!\s*(pro|max|ultra))"#) { return .medium }
        return nil
    }
}
