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
    // Headworks (Shaders/MapHeadworks*.metal), exported as "headworks.<name>".
    case headworksConcrete = 100
    case headworksConcreteRound = 101
    case headworksPaving = 102
    case headworksRoad = 103
    case headworksPaint = 104
    case headworksStainless = 105
    case headworksGalvanised = 106
    case headworksMatte = 107
    case headworksHazard = 108
    case headworksGrating = 109
    case headworksGlass = 110
    case headworksWater = 111
    case headworksStain = 112
    case headworksRunOff = 113
    case headworksLine = 114
    case headworksTyres = 115
    case headworksRange = 116
    case headworksRangeFloor = 117
    // Harbor (Shaders/MapHarbor*.metal), exported as "harbor.<name>"; families carry programArgs.
    case harborPlaster = 200
    case harborMasonry = 201
    case harborMasonrySlab = 202
    case harborCobbles = 203
    case harborRoofTiles = 204
    case harborStained = 205
    case harborPainted = 206
    case harborLouvred = 207
    case harborLitRoom = 208
    case harborLampGlass = 209
    case harborStriped = 210
    case harborScuffed = 211
    case harborStainDecal = 212
    case harborHillside = 213
    case harborTreeShadow = 214
    case harborLeafy = 215
    case harborSea = 216
    case harborGlow = 217
    case harborHaze = 218
    case harborBoat = 219
    // Test range (Shaders/MapRangeMaterials.metal).
    case rangeWetConcrete = 300
    /// The Railyard sky dome; drawn by the sky pass (Shaders/SkyRailyard.metal), never as a mesh.
    case railyardSky = 1000
    /// The Headworks sky dome (Shaders/SkyHeadworks.metal).
    case headworksSky = 1001
    /// The Harbor sky dome (Shaders/SkyHarbor.metal).
    case harborSky = 1002

    /// Programs whose web material has no node override beyond the sky visibility; they draw generically.
    static let generic: Set<String> = ["ballast", "rawSteel", "glass", "lettering", "lamp"]

    /// Headworks programs by their exported name (programs-headworks.ts); sign and lamp have no
    /// colour, opacity or normal node and draw generically.
    static let headworks: [String: SurfaceProgram] = [
        "concrete": .headworksConcrete, "concreteRound": .headworksConcreteRound, "paving": .headworksPaving,
        "road": .headworksRoad, "paint": .headworksPaint, "stainless": .headworksStainless, "galvanised": .headworksGalvanised,
        "matte": .headworksMatte, "hazard": .headworksHazard, "grating": .headworksGrating, "glass": .headworksGlass,
        "water": .headworksWater, "stain": .headworksStain, "runOff": .headworksRunOff, "line": .headworksLine,
        "tyres": .headworksTyres, "range": .headworksRange, "rangeFloor": .headworksRangeFloor, "sky": .headworksSky,
        "sign": .none, "lamp": .none,
    ]
    static let range: [String: SurfaceProgram] = ["wetConcrete": .rangeWetConcrete]
    static let harbor: [String: SurfaceProgram] = [
        "plaster": .harborPlaster, "masonry": .harborMasonry, "masonrySlab": .harborMasonrySlab, "cobbles": .harborCobbles,
        "roofTiles": .harborRoofTiles, "stained": .harborStained, "painted": .harborPainted, "louvred": .harborLouvred,
        "litRoom": .harborLitRoom, "lampGlass": .harborLampGlass, "striped": .harborStriped, "scuffed": .harborScuffed,
        "stainDecal": .harborStainDecal, "hillside": .harborHillside, "treeShadow": .harborTreeShadow, "leafy": .harborLeafy,
        "sea": .harborSea, "glow": .harborGlow, "haze": .harborHaze, "boat": .harborBoat, "sky": .harborSky,
    ]

    /// The program for an exported name: Railyard's bare names (the key in createMaterials'
    /// `Materials`, or "sky"), or "<map>.<name>" for the maps after it.
    public init?(name: String) {
        if let dot = name.firstIndex(of: ".") {
            let map = name[..<dot], bare = String(name[name.index(after: dot)...])
            let table: [String: SurfaceProgram]? = switch map {
            case "headworks": Self.headworks
            case "range": Self.range
            case "harbor": Self.harbor
            default: nil
            }
            guard let program = table?[bare] else { return nil }
            self = program
            return
        }
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

    /// Drawn by the sky pass as a full-screen fragment, never as a mesh.
    public var isSky: Bool { rawValue >= 1000 }

    /// The sky pass fragment of a sky program (Shaders/Sky*.metal).
    var skyFunction: String? {
        switch self {
        case .railyardSky: "ivSkyRailyardFragment"
        case .headworksSky: "ivSkyHeadworksFragment"
        case .harborSky: "ivSkyHarborFragment"
        default: nil
        }
    }

    /// IV_AO_* of Shaders/MapSurface.h for an exported aoProgram name (function constant 5).
    /// Railyard's "skyVisibility" keeps its own constant (2).
    static func aoProgramID(_ name: String?) -> UInt32 {
        switch name {
        case "headworksSkyVisibility": 1
        case "harborShade": 2
        default: 0
        }
    }

    /// IV_EMISSIVE_* of Shaders/MapSurface.h for an exported emissiveProgram name (function constant 6).
    static func emissiveProgramID(_ name: String?) -> UInt32 {
        switch name {
        case "headworksLampGlow": 1
        case "harborBounce": 2
        default: 0
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
        case .railyardCladding, .railyardContainer, .headworksConcrete, .headworksConcreteRound,
             .headworksPaving, .headworksRoad: "colorNode"
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

/// Packs scene.json `programRows` (the maps after Railyard) into float4 rows.
enum ProgramRows {
    /// setFragmentBytes takes at most 4 KB.
    static let maxRows = 4096 / MemoryLayout<SIMD4<Float>>.stride

    static func pack(_ rows: [[Double]]) -> [SIMD4<Float>] {
        rows.map { r in SIMD4((0..<4).map { $0 < r.count ? Float(r[$0]) : 0 }) }
    }
}
