// The particle and detail densities of the web's quality tiers (src/core/settings.ts
// graphicsForTier), which the effects scale by; pinned by native/Contract/fx/pure.json `tiers`.

public enum FXQuality: String, Sendable, CaseIterable {
    case low, medium, high, ultra

    public var particleDensity: Double {
        switch self { case .low: 0.5; case .medium: 0.75; case .high, .ultra: 1 }
    }

    public var detailDensity: Double {
        switch self { case .low: 0.35; case .medium: 0.6; case .high: 0.85; case .ultra: 1 }
    }
}
