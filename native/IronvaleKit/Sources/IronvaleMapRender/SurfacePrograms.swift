// Surface programs (PLAN.md 3.4): the exporter tags each map material with the web factory that
// made it (native/Tools/map-export/page/programs.ts); this maps those names to the MSL programs
// selected by function constant in Shaders/MapPBR.metal. Raw values must match IV_PROGRAM_* in
// Shaders/MapSurface.h.
import Foundation

public enum SurfaceProgram: UInt32, Sendable, CaseIterable {
    case none = 0
    case railyardAsphalt = 1
    case railyardQuay = 2
    case railyardFloor = 3
    case railyardWall = 4
    case railyardCladding = 5
    case railyardContainer = 6
    case railyardSteel = 7
    case railyardHazard = 8
    case railyardWood = 9
    case railyardMatte = 10
    case railyardCarton = 11
    case railyardWrap = 12
    case railyardPaint = 13
    case railyardStain = 14
    case railyardChainlink = 15
    case railyardWater = 16
    /// The Railyard sky dome; drawn by the sky pass (Shaders/SkyRailyard.metal), never as a mesh.
    case railyardSky = 1000

    /// Programs whose web material has no node override beyond the sky visibility; they draw generically.
    static let generic: Set<String> = ["ballast", "rawSteel", "glass", "lettering", "lamp"]

    /// The program for an exported name (the key in createMaterials' `Materials`, or "sky").
    public init?(name: String) {
        switch name {
        case "asphalt": self = .railyardAsphalt
        case "quay": self = .railyardQuay
        case "floor": self = .railyardFloor
        case "wall": self = .railyardWall
        case "cladding": self = .railyardCladding
        case "containerPaint": self = .railyardContainer
        case "steel": self = .railyardSteel
        case "hazard": self = .railyardHazard
        case "wood": self = .railyardWood
        case "matte": self = .railyardMatte
        case "carton": self = .railyardCarton
        case "wrap": self = .railyardWrap
        case "paint": self = .railyardPaint
        case "stain": self = .railyardStain
        case "chainlink": self = .railyardChainlink
        case "water": self = .railyardWater
        case "sky": self = .railyardSky
        default:
            if Self.generic.contains(name) { self = .none } else { return nil }
        }
    }

    /// lampLit() of src/maps/railyard/materials.ts: these surfaces take the lamp pools as emission.
    var lampLit: Bool {
        switch self {
        case .railyardAsphalt, .railyardQuay, .railyardWall, .railyardCladding, .railyardSteel, .railyardContainer: true
        default: false
        }
    }

    /// The node slot whose texture the program samples at IV_TEXTURE_PROGRAM, if any.
    var nodeTextureSlot: String? {
        switch self {
        case .railyardCladding, .railyardContainer: "colorNode"
        case .railyardAsphalt, .railyardQuay: "normalNode"
        default: nil
        }
    }
}

/// Packs scene.json `programParams` into the float4 rows of Shaders/MapSurface.h (IV_RY_*).
enum RailyardProgramParams {
    static let maxGlows = 32

    static func pack(_ p: MapRenderScene.ProgramParams) -> [SIMD4<Float>] {
        func f(_ d: Double) -> Float { Float(d) }
        let glows = p.glows.prefix(maxGlows)
        let w = p.warehouse
        var rows: [SIMD4<Float>] = [
            SIMD4(f(p.sunInSky[0]), f(p.sunInSky[1]), f(p.sunInSky[2]), Float(glows.count)),
            SIMD4(f(w.west), f(w.east), f(w.north), f(w.south)),
            SIMD4(f(w.eaves), f(w.ridge), f(w.doorWest), f(w.doorEast)),
            SIMD4(f(w.mezzanine.east), f(w.mezzanine.north), f(w.mezzanine.south), f(w.mezzanine.top)),
            SIMD4(f(p.office.west), f(p.office.east), f(p.office.north), f(p.office.south)),
            SIMD4(f(p.office.height), 0, 0, 0),
        ]
        for g in glows {
            rows.append(SIMD4(f(g.at[0]), f(g.at[1]), f(g.at[2]), f(g.strength)))
            rows.append(SIMD4(f(g.linear[0]), f(g.linear[1]), f(g.linear[2]), f(g.reach)))
            let facing = g.facing ?? [0, 0]
            rows.append(SIMD4(g.down == true ? 1 : 0, f(facing[0]), f(facing[1]), g.facing == nil ? 0 : 1))
        }
        return rows
    }
}
