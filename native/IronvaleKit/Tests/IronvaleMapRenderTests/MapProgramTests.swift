// M9 map parity: the Headworks, Harbor and test-range surface programs (SurfacePrograms.swift,
// Shaders/MapHeadworks*.metal, MapHarbor*.metal, MapRangeMaterials.metal).
import Foundation
import Testing
@testable import IronvaleMapRender
@testable import IronvaleRender

private let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../..").standardizedFileURL

/// IV_PROGRAM_* names of Shaders/MapSurface.h for the maps after Railyard (checked with Railyard's
/// in surfaceProgramIdsMatchTheShaderHeader).
let mapProgramDefines: [SurfaceProgram: String] = [
    .headworksConcrete: "IV_PROGRAM_HW_CONCRETE", .headworksConcreteRound: "IV_PROGRAM_HW_CONCRETE_ROUND",
    .headworksPaving: "IV_PROGRAM_HW_PAVING", .headworksRoad: "IV_PROGRAM_HW_ROAD", .headworksPaint: "IV_PROGRAM_HW_PAINT",
    .headworksStainless: "IV_PROGRAM_HW_STAINLESS", .headworksGalvanised: "IV_PROGRAM_HW_GALVANISED",
    .headworksMatte: "IV_PROGRAM_HW_MATTE", .headworksHazard: "IV_PROGRAM_HW_HAZARD", .headworksGrating: "IV_PROGRAM_HW_GRATING",
    .headworksGlass: "IV_PROGRAM_HW_GLASS", .headworksWater: "IV_PROGRAM_HW_WATER", .headworksStain: "IV_PROGRAM_HW_STAIN",
    .headworksRunOff: "IV_PROGRAM_HW_RUNOFF", .headworksLine: "IV_PROGRAM_HW_LINE", .headworksTyres: "IV_PROGRAM_HW_TYRES",
    .headworksRange: "IV_PROGRAM_HW_RANGE", .headworksRangeFloor: "IV_PROGRAM_HW_RANGE_FLOOR",
    .harborPlaster: "IV_PROGRAM_HB_PLASTER", .harborMasonry: "IV_PROGRAM_HB_MASONRY", .harborMasonrySlab: "IV_PROGRAM_HB_MASONRY_SLAB",
    .harborCobbles: "IV_PROGRAM_HB_COBBLES", .harborRoofTiles: "IV_PROGRAM_HB_ROOF_TILES", .harborStained: "IV_PROGRAM_HB_STAINED",
    .harborPainted: "IV_PROGRAM_HB_PAINTED", .harborLouvred: "IV_PROGRAM_HB_LOUVRED", .harborLitRoom: "IV_PROGRAM_HB_LIT_ROOM",
    .harborLampGlass: "IV_PROGRAM_HB_LAMP_GLASS", .harborStriped: "IV_PROGRAM_HB_STRIPED", .harborScuffed: "IV_PROGRAM_HB_SCUFFED",
    .harborStainDecal: "IV_PROGRAM_HB_STAIN_DECAL", .harborHillside: "IV_PROGRAM_HB_HILLSIDE",
    .harborTreeShadow: "IV_PROGRAM_HB_TREE_SHADOW", .harborLeafy: "IV_PROGRAM_HB_LEAFY", .harborSea: "IV_PROGRAM_HB_SEA",
    .harborGlow: "IV_PROGRAM_HB_GLOW", .harborHaze: "IV_PROGRAM_HB_HAZE", .harborBoat: "IV_PROGRAM_HB_BOAT",
    .rangeWetConcrete: "IV_PROGRAM_RG_WET_CONCRETE",
]

@Test func freezeSwitchParses() throws {
    #expect(try MapRenderOptions.parse(["--map", "harbor", "--freeze"]).freeze)
    #expect(try !MapRenderOptions.parse(["--map", "harbor"]).freeze)
}

@Test func mapProgramNamesCarryTheirMap() {
    #expect(SurfaceProgram(name: "headworks.paint") == .headworksPaint)
    #expect(SurfaceProgram(name: "paint") == .railyardPaint)
    #expect(SurfaceProgram(name: "harbor.plaster") == .harborPlaster)
    #expect(SurfaceProgram(name: "range.wetConcrete") == .rangeWetConcrete)
    #expect(SurfaceProgram(name: "headworks.sign") == SurfaceProgram.none)
    #expect(SurfaceProgram(name: "harbor.somethingNew") == nil)
    #expect(SurfaceProgram(name: "nowhere.paint") == nil)
    for sky in [SurfaceProgram.railyardSky, .headworksSky, .harborSky] { #expect(sky.isSky && sky.skyFunction != nil) }
    #expect(!SurfaceProgram.harborSea.isSky)
    #expect(SurfaceProgram.aoProgramID("headworksSkyVisibility") == 1 && SurfaceProgram.aoProgramID("harborShade") == 2)
    #expect(SurfaceProgram.aoProgramID("skyVisibility") == 0 && SurfaceProgram.aoProgramID(nil) == 0)
    #expect(SurfaceProgram.emissiveProgramID("headworksLampGlow") == 1 && SurfaceProgram.emissiveProgramID("harborBounce") == 2)
}

@Test func occlusionAndEmissionIdsMatchTheShaderHeader() throws {
    let header = try String(contentsOf: repo.appending(path: "native/IronvaleApp/Shaders/MapSurface.h"), encoding: .utf8)
    for (define, value) in [("IV_AO_HW_SKY_VISIBILITY", SurfaceProgram.aoProgramID("headworksSkyVisibility")),
                            ("IV_AO_HB_SHADE", SurfaceProgram.aoProgramID("harborShade")),
                            ("IV_EMISSIVE_HW_LAMP_GLOW", SurfaceProgram.emissiveProgramID("headworksLampGlow")),
                            ("IV_EMISSIVE_HB_BOUNCE", SurfaceProgram.emissiveProgramID("harborBounce"))] {
        #expect(header.contains("#define \(define) \(value)u"), "\(define)")
    }
}

@Test func programRowsPackIntoFloat4() {
    let rows = ProgramRows.pack([[1, 2, 3, 4], [5, 6]])
    #expect(rows == [SIMD4(1, 2, 3, 4), SIMD4(5, 6, 0, 0)])
    #expect(ProgramRows.maxRows == 256)
}

/// Every material whose web version overrides colour, opacity, normal or vertex nodes is matched to
/// a ported program, nothing is left to the generic skip list, and the rows and textures the
/// programs read are there.
@Test(arguments: ["headworks", "harbor", "range"])
func mapMaterialsAllHavePrograms(map: String) throws {
    let dir = repo.appending(path: "native/MapPackages/\(map)/render")
    guard FileManager.default.fileExists(atPath: dir.appending(path: "scene.json").path) else { return }  // git-ignored export
    let bytes = try FileHandle(forReadingFrom: dir.appending(path: "buffers.bin")).seekToEnd()
    let scene = try MapRenderScene.load(sceneJSON: Data(contentsOf: dir.appending(path: "scene.json")), bufferLength: Int(bytes))
    for (i, m) in scene.materials.enumerated() where !Set(m.nodes).isDisjoint(with: ["colorNode", "opacityNode", "normalNode", "vertexNode"]) {
        #expect(m.program.flatMap(SurfaceProgram.init(name:)).map { $0 != .none } == true, "\(map) material \(i) nodes \(m.nodes) program \(m.program ?? "nil")")
    }
    for (i, m) in scene.materials.enumerated() where m.nodes.contains("aoNode") {
        #expect(SurfaceProgram.aoProgramID(m.aoProgram) != 0, "\(map) material \(i) aoNode \(m.aoProgram ?? "nil")")
    }
    #expect(scene.meshes.allSatisfy { mesh in
        guard case .single(let m) = mesh.material else { return false }
        // Materials three never draws (visible or colourWrite false) are the only skips left.
        let reason = scene.materials[m].genericSkipReason
        return reason == nil || reason == .invisible
    })
    let rows = try #require(scene.programRows)
    #expect(!rows.isEmpty && rows.count <= ProgramRows.maxRows)
    if map == "harbor" {
        #expect(Set(scene.programTextures?.keys.map { $0 } ?? []) == Set(ProgramTextures.names))
        #expect(scene.materials.contains { $0.program == "harbor.plaster" && $0.programArgs?.count == 5 })
    }
}
