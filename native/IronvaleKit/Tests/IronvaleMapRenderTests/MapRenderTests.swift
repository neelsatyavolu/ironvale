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
    // The sky dome (vertexNode) is one of them; most of the level goes through the generic path.
    #expect(skipped.count < scene.meshes.count / 4)
    let assets = try MapAssets(package: railyardRender.deletingLastPathComponent(), repositoryRoot: repo)
    #expect(assets.meta.lighting.hdri == "hdri-railyard")
}
