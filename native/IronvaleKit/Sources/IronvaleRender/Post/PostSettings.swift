// Post-chain switches of the web's GraphicsSettings (src/core/settings.ts QUALITY_PRESETS at
// commit 1aca0b7) and the developer overrides of src/main.ts debugSettings (?q= and
// ?no=ssr,ao,godrays,bloom,aa,grain,shadows), as launch arguments --q TIER --no LIST.
import Foundation

public struct PostSettings: Sendable, Equatable {
    public enum Tier: String, Sendable, CaseIterable { case low, medium, high, ultra }
    /// The web's choices; 'traa' is ported (PostTRAA), 'fxaa' is not ported yet.
    public enum AntiAliasing: String, Sendable { case traa, fxaa, none }

    public var tier: Tier
    /// Scene pass size relative to the output (the web's renderScale x devicePixelRatio).
    public var renderScale: Float
    public var shadowMapSize: Int
    public var ambientOcclusion: Bool
    public var reflections: Bool
    public var volumetricLight: Bool
    public var bloom: Bool
    public var antiAliasing: AntiAliasing
    public var filmGrain: Bool
    public var dynamicResolution: Bool
    public var targetFps: Double

    public init(tier: Tier, renderScale: Float, shadowMapSize: Int, ambientOcclusion: Bool, reflections: Bool,
                volumetricLight: Bool, bloom: Bool, antiAliasing: AntiAliasing, filmGrain: Bool,
                dynamicResolution: Bool = true, targetFps: Double = 60) {
        self.tier = tier
        self.renderScale = renderScale
        self.shadowMapSize = shadowMapSize
        self.ambientOcclusion = ambientOcclusion
        self.reflections = reflections
        self.volumetricLight = volumetricLight
        self.bloom = bloom
        self.antiAliasing = antiAliasing
        self.filmGrain = filmGrain
        self.dynamicResolution = dynamicResolution
        self.targetFps = targetFps
    }

    /// QUALITY_PRESETS (the post-relevant fields).
    public static func preset(_ tier: Tier) -> PostSettings {
        switch tier {
        case .low:
            PostSettings(tier: tier, renderScale: 0.5, shadowMapSize: 1024, ambientOcclusion: false, reflections: false,
                         volumetricLight: false, bloom: false, antiAliasing: .fxaa, filmGrain: false)
        case .medium:
            PostSettings(tier: tier, renderScale: 0.75, shadowMapSize: 2048, ambientOcclusion: true, reflections: false,
                         volumetricLight: true, bloom: true, antiAliasing: .traa, filmGrain: true)
        case .high:
            PostSettings(tier: tier, renderScale: 0.85, shadowMapSize: 4096, ambientOcclusion: true, reflections: true,
                         volumetricLight: true, bloom: true, antiAliasing: .traa, filmGrain: true)
        case .ultra:
            PostSettings(tier: tier, renderScale: 1, shadowMapSize: 4096, ambientOcclusion: true, reflections: true,
                         volumetricLight: true, bloom: true, antiAliasing: .traa, filmGrain: true)
        }
    }

    /// debugSettings: switches named in `off` are turned off and dynamic resolution is disabled.
    public func disabling(_ off: Set<String>) -> PostSettings {
        var s = self
        s.dynamicResolution = false
        s.reflections = reflections && !off.contains("ssr")
        s.ambientOcclusion = ambientOcclusion && !off.contains("ao")
        s.volumetricLight = volumetricLight && !off.contains("godrays")
        s.bloom = bloom && !off.contains("bloom")
        s.antiAliasing = off.contains("aa") ? .none : antiAliasing
        s.filmGrain = filmGrain && !off.contains("grain")
        s.shadowMapSize = off.contains("shadows") ? 0 : shadowMapSize
        return s
    }

    /// pipeline.ts: GTAO runs at full resolution only on ultra.
    var aoResolutionScale: Float { tier == .ultra ? 1 : 0.5 }
    /// pipeline.ts: 8 AO samples on medium, 12 otherwise.
    var aoSamples: UInt32 { tier == .medium ? 8 : 12 }
    /// pipeline.ts: 32 shaft steps on medium, 48 otherwise.
    var godraySteps: UInt32 { tier == .medium ? 32 : 48 }

    /// The web's GraphicsSettings.targetFps choices (settings.ts GRAPHICS_CHOICES).
    public static let targetFpsChoices: [Double] = [30, 60, 120]

    /// Parses `--q TIER` and `--no a,b,c` the way main.ts reads ?q= and ?no= (which turn dynamic
    /// resolution off), plus two of the player's own graphics settings that are not part of a tier:
    /// `--target-fps N` (Target FPS, 30, 60 or 120: the dynamic resolution budget) and
    /// `--dynamic-resolution on|off`. Nil when neither --q nor --no is given.
    public static func parse(_ arguments: some Sequence<String>) -> PostSettings? {
        var tier: Tier?
        var off: Set<String> = []
        var targetFps: Double?
        var dynamic: Bool?
        var iterator = arguments.makeIterator()
        while let arg = iterator.next() {
            switch arg {
            case "--q": tier = iterator.next().flatMap(Tier.init(rawValue:))
            case "--no": off = Set((iterator.next() ?? "").split(separator: ",").map(String.init))
            case "--target-fps": targetFps = iterator.next().flatMap(Double.init).flatMap { targetFpsChoices.contains($0) ? $0 : nil }
            case "--dynamic-resolution":
                switch iterator.next() {
                case "on": dynamic = true
                case "off": dynamic = false
                default: break
                }
            default: continue
            }
        }
        guard tier != nil || !off.isEmpty else { return nil }
        var settings = preset(tier ?? .high).disabling(off)
        if let targetFps { settings.targetFps = targetFps }
        if let dynamic { settings.dynamicResolution = dynamic }
        return settings
    }
}
