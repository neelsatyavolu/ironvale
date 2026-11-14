// Ported from src/fx/surfaces.ts and src/fx/decal-sheet.ts (DECAL_GRID, DECAL_ROW) at commit a487033.
import Darwin
import IronvaleWorld

public enum DecalKind: Int, Sendable, CaseIterable {
    case masonry = 0, metal, wood, soft
    /// decal-sheet.ts DECAL_GRID: cells per side; each kind is one row.
    public static let grid = 4
}

public enum SurfaceFamily: String, Sendable { case masonry, metal, wood, soil, water, glass, foliage, none }

public struct SurfaceLook: Sendable {
    public let family: SurfaceFamily
    public let dust: D3
    public let debris: D3
    public let dustiness: Double
    public let decal: DecalKind?

    public static func of(_ surface: Surface) -> SurfaceLook {
        switch surface {
        case .concrete: SurfaceLook(family: .masonry, dust: D3(0.56, 0.55, 0.53), debris: D3(0.5, 0.49, 0.47), dustiness: 1, decal: .masonry)
        case .plaster: SurfaceLook(family: .masonry, dust: D3(0.8, 0.78, 0.73), debris: D3(0.82, 0.8, 0.75), dustiness: 1.35, decal: .masonry)
        case .asphalt: SurfaceLook(family: .masonry, dust: D3(0.3, 0.3, 0.31), debris: D3(0.1, 0.1, 0.11), dustiness: 0.7, decal: .masonry)
        case .cobble: SurfaceLook(family: .masonry, dust: D3(0.5, 0.47, 0.43), debris: D3(0.36, 0.34, 0.31), dustiness: 0.85, decal: .masonry)
        case .metal: SurfaceLook(family: .metal, dust: D3(0.45, 0.45, 0.47), debris: D3(0.3, 0.3, 0.32), dustiness: 0.3, decal: .metal)
        case .wood: SurfaceLook(family: .wood, dust: D3(0.62, 0.52, 0.38), debris: D3(0.72, 0.58, 0.36), dustiness: 0.6, decal: .wood)
        case .dirt: SurfaceLook(family: .soil, dust: D3(0.13, 0.1, 0.07), debris: D3(0.09, 0.065, 0.045), dustiness: 1, decal: .soft)
        case .gravel: SurfaceLook(family: .soil, dust: D3(0.38, 0.36, 0.33), debris: D3(0.3, 0.28, 0.26), dustiness: 1, decal: .soft)
        case .sand: SurfaceLook(family: .soil, dust: D3(0.7, 0.6, 0.42), debris: D3(0.62, 0.52, 0.36), dustiness: 1.3, decal: .soft)
        case .grass: SurfaceLook(family: .soil, dust: D3(0.14, 0.11, 0.07), debris: D3(0.15, 0.27, 0.08), dustiness: 0.8, decal: .soft)
        case .water: SurfaceLook(family: .water, dust: D3(0.85, 0.9, 0.95), debris: D3(0.9, 0.94, 1), dustiness: 1, decal: nil)
        case .glass: SurfaceLook(family: .glass, dust: D3(0.9, 0.93, 0.95), debris: D3(0.82, 0.95, 1), dustiness: 0.4, decal: nil)
        case .foliage: SurfaceLook(family: .foliage, dust: D3(0.3, 0.34, 0.2), debris: D3(0.18, 0.32, 0.08), dustiness: 0.2, decal: nil)
        case .flesh: SurfaceLook(family: .none, dust: .zero, debris: .zero, dustiness: 0, decal: nil)
        }
    }
}

/// textures.ts SPRITE: cells of the particle sprite sheet (4 x 4).
public enum Sprite {
    public static let grid = 4
    public static let puffA = 0, puffB = 1, wisp = 2, chipA = 3, chipB = 4, splinter = 5, shard = 6, leaf = 7
    public static let drop = 8, splash = 9, streak = 10, glow = 11, flare = 12, grains = 13
}
