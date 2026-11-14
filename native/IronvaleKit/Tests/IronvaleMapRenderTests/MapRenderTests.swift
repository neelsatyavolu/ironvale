import Foundation
import Testing
import simd
@testable import IronvaleMapRender
@testable import IronvaleRender

private let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../..").standardizedFileURL
private let railyardRender = repo.appending(path: "native/MapPackages/railyard/render")
private let hasRenderExport = FileManager.default.fileExists(atPath: railyardRender.appending(path: "scene.json").path)

@Test func optionsParseTheM3Switches() throws {
    let o = try MapRenderOptions.parse(["--frames", "3", "--map", "railyard", "--pose", "4,0,30,0,-2", "--capture", "/tmp/a.png",
                                        "--flythrough", "60", "--offscreen", "--gpu-log", "/tmp/g.csv", "--internal", "1280x800"])
    #expect(o.mapId == "railyard")
    #expect(o.pose == CameraPose(webPose: "4,0,30,0,-2"))
    #expect(o.capturePath == "/tmp/a.png" && o.gpuLogPath == "/tmp/g.csv")
    #expect(o.flythroughSeconds == 60 && o.offscreen)
    #expect(o.internalWidth == 1280 && o.internalHeight == 800)
    #expect(throws: MapRenderOptions.ParseError.invalid("--pose", "1,2")) { try MapRenderOptions.parse(["--pose", "1,2"]) }
    #expect(throws: MapRenderOptions.ParseError.missingValue("--map")) { try MapRenderOptions.parse(["--map"]) }
}

@Test func flythroughIsAClosedLoopAtEyeHeight() {
    let flight = Flythrough()
    let a = flight.pose(at: 0), b = flight.pose(at: 60)
    #expect(simd_distance(a.eye, b.eye) < 1e-3)
    #expect(a.eye.y == CameraPose.standEye)
    #expect(simd_distance(a.eye, SIMD3(-3, CameraPose.standEye, 45.5)) < 1e-3)
    // The camera looks along the path.
    let ahead = flight.pose(at: 0.05).eye - a.eye
    #expect(simd_dot(simd_normalize(SIMD3(ahead.x, 0, ahead.z)), simd_normalize(SIMD3(a.forward.x, 0, a.forward.z))) > 0.9)
}

@Test func genericPathSkipsMapPrograms() throws {
    func material(_ nodes: [String], maps: [String: Int] = [:]) throws -> MapRenderScene.Material {
        let json = #"{"type":"MeshStandardNodeMaterial","name":"","maps":\#(String(data: try JSONEncoder().encode(maps), encoding: .utf8)!),"nodes":\#(String(data: try JSONEncoder().encode(nodes), encoding: .utf8)!)}"#
        return try JSONDecoder().decode(MapRenderScene.Material.self, from: Data(json.utf8))
    }
    #expect(try material(["colorNode", "vertexNode"]).genericSkipReason == .customVertex)
    #expect(try material(["aoNode", "opacityNode"]).genericSkipReason == .nodeOpacity)
    #expect(try material(["opacityNode"], maps: ["map": 3]).genericSkipReason == nil)
    #expect(try material(["aoNode"]).genericSkipReason == nil)
    #expect(try material(["colorNode"]).hasNodeAlbedo)
    #expect(try !material(["colorNode"], maps: ["map": 0]).hasNodeAlbedo)
}

@Test(.enabled(if: hasRenderExport, "needs the git-ignored render export (map-export run.mjs)"))
func railyardRenderExportDecodes() throws {
    let bytes = try FileHandle(forReadingFrom: railyardRender.appending(path: "buffers.bin")).seekToEnd()
    let scene = try MapRenderScene.load(sceneJSON: Data(contentsOf: railyardRender.appending(path: "scene.json")), bufferLength: Int(bytes))
    #expect(scene.mapId == "railyard")
    #expect(!scene.meshes.isEmpty)
    let skipped = scene.meshes.filter { mesh in
        guard case .single(let m) = mesh.material else { return true }
        return scene.materials[m].genericSkipReason != nil
    }
    // With the Railyard programs ported none are left (railyardMaterialsAllHavePrograms); the bound guards other maps.
    #expect(skipped.count < scene.meshes.count / 4)
    let assets = try MapAssets(package: railyardRender.deletingLastPathComponent(), repositoryRoot: repo)
    #expect(assets.meta.lighting.hdri == "hdri-railyard")
}

@Test func programsReplaceTheGenericSkips() throws {
    func material(_ nodes: [String], program: String?) throws -> MapRenderScene.Material {
        let p = program.map { "\"\($0)\"" } ?? "null"
        let json = #"{"type":"MeshStandardNodeMaterial","name":"","maps":{},"nodes":\#(String(data: try JSONEncoder().encode(nodes), encoding: .utf8)!),"program":\#(p)}"#
        return try JSONDecoder().decode(MapRenderScene.Material.self, from: Data(json.utf8))
    }
    #expect(try material(["aoNode", "opacityNode"], program: "chainlink").genericSkipReason == nil)
    #expect(try material(["colorNode", "vertexNode"], program: "sky").genericSkipReason == nil)
    #expect(try material(["aoNode", "opacityNode"], program: nil).genericSkipReason == .nodeOpacity)
    // A label this build has no program for keeps the generic behaviour.
    #expect(try material(["aoNode", "opacityNode"], program: "somethingNew").genericSkipReason == .nodeOpacity)
    #expect(try !material(["colorNode"], program: "steel").hasNodeAlbedo)
}

@Test func surfaceProgramIdsMatchTheShaderHeader() throws {
    // Raw values are the IV_PROGRAM_* defines of Shaders/MapSurface.h.
    let header = try String(contentsOf: repo.appending(path: "native/IronvaleApp/Shaders/MapSurface.h"), encoding: .utf8)
    var defines: [String: UInt32] = [:]
    for line in header.split(separator: "\n") where line.hasPrefix("#define IV_PROGRAM_") {
        let parts = line.split(separator: " ")
        if parts.count >= 3, let v = UInt32(parts[2].trimmingCharacters(in: CharacterSet(charactersIn: "u"))) { defines[String(parts[1])] = v }
    }
    let expected: [SurfaceProgram: String] = [
        .none: "IV_PROGRAM_NONE", .railyardAsphalt: "IV_PROGRAM_RY_ASPHALT", .railyardQuay: "IV_PROGRAM_RY_QUAY",
        .railyardFloor: "IV_PROGRAM_RY_FLOOR", .railyardWall: "IV_PROGRAM_RY_WALL", .railyardCladding: "IV_PROGRAM_RY_CLADDING",
        .railyardContainer: "IV_PROGRAM_RY_CONTAINER", .railyardSteel: "IV_PROGRAM_RY_STEEL", .railyardHazard: "IV_PROGRAM_RY_HAZARD",
        .railyardWood: "IV_PROGRAM_RY_WOOD", .railyardMatte: "IV_PROGRAM_RY_MATTE", .railyardCarton: "IV_PROGRAM_RY_CARTON",
        .railyardWrap: "IV_PROGRAM_RY_WRAP", .railyardPaint: "IV_PROGRAM_RY_PAINT", .railyardStain: "IV_PROGRAM_RY_STAIN",
        .railyardChainlink: "IV_PROGRAM_RY_CHAINLINK", .railyardWater: "IV_PROGRAM_RY_WATER",
    ].merging(mapProgramDefines) { a, _ in a }
    for (program, name) in expected { #expect(defines[name] == program.rawValue, "\(name)") }
    #expect(defines.count == expected.count)
}

@Test(.enabled(if: hasRenderExport, "needs the git-ignored render export (map-export run.mjs)"))
func railyardMaterialsAllHavePrograms() throws {
    let bytes = try FileHandle(forReadingFrom: railyardRender.appending(path: "buffers.bin")).seekToEnd()
    let scene = try MapRenderScene.load(sceneJSON: Data(contentsOf: railyardRender.appending(path: "scene.json")), bufferLength: Int(bytes))
    // Every material whose web version overrides colour, opacity, normal or vertex nodes is matched to a ported program.
    for (i, m) in scene.materials.enumerated() where !Set(m.nodes).isDisjoint(with: ["colorNode", "opacityNode", "normalNode", "vertexNode"]) {
        #expect(m.program.flatMap(SurfaceProgram.init(name:)) != nil, "material \(i) nodes \(m.nodes) program \(m.program ?? "nil")")
    }
    // Nothing is left to the generic skip list.
    #expect(scene.meshes.allSatisfy { mesh in
        guard case .single(let m) = mesh.material else { return false }
        return scene.materials[m].genericSkipReason == nil
    })
    // Containers carry their livery per instance.
    let containers = scene.meshes.filter { mesh in
        guard case .single(let m) = mesh.material else { return false }
        return scene.materials[m].program == "containerPaint"
    }
    #expect(!containers.isEmpty && containers.allSatisfy { $0.instances?.attributes?["livery"] != nil })
    let params = try #require(scene.programParams)
    let rows = RailyardProgramParams.pack(params)
    #expect(rows.count == 6 + 3 * min(params.glows.count, RailyardProgramParams.maxGlows))
    #expect(Int(rows[0].w) == params.glows.count && params.glows.count <= RailyardProgramParams.maxGlows)
}
