// IVM reader against the baked soldier and carbine (native/Tools/asset-bake/bake.mjs), plus the
// error paths for damaged files.
import Foundation
import Testing
@testable import IronvaleAssets

@Suite("IVM reader")
struct IVMTests {
    static let baked = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "BakedAssets/characters")

    static func load(_ name: String) throws -> IVMModel {
        let url = baked.appending(path: name)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw IVMModel.ReadError.invalid("\(url.path) missing: run node native/Tools/asset-bake/bake.mjs")
        }
        return try IVMModel(contentsOf: url)
    }

    @Test func readsTheSoldier() throws {
        let m = try Self.load("soldier.ivm")
        // Shapes measured from public/assets/local/characters/soldier.glb with @gltf-transform.
        #expect(m.nodes.count == 44)
        #expect(m.skins.count == 1 && m.skins[0].joints.count == 42)
        #expect(m.animations.map(\.name) == ["idle", "walk", "jog", "run", "crouchIdle", "crouchWalk", "crouchJog", "death", "deathFront"])
        #expect(m.animations.allSatisfy { $0.channels.count == 23 })
        let p = try #require(m.meshes.first?.primitives.first)
        #expect(p.vertexCount == 12845 && p.indices.count == 60846)
        #expect(p.joints.count == p.vertexCount * 4 && p.weights.count == p.vertexCount * 4)
        for v in 0..<p.vertexCount {
            let sum = p.weights[v * 4] + p.weights[v * 4 + 1] + p.weights[v * 4 + 2] + p.weights[v * 4 + 3]
            #expect(abs(sum - 1) < 1e-5)
            if abs(sum - 1) >= 1e-5 { break }
        }
        #expect(p.joints.allSatisfy { Int($0) < 42 })
        #expect(m.textures.map(\.srgb) == [true, false, false])
        #expect(m.materials[0].baseColorTexture == 0 && m.materials[0].normalTexture == 1 && m.materials[0].metallicRoughnessTexture == 2)
        // Parents come before children.
        for (i, n) in m.nodes.enumerated() { #expect((n.parent ?? -1) < i) }
    }

    @Test func readsTheCarbine() throws {
        let m = try Self.load("carbine.ivm")
        #expect(m.skins.isEmpty && m.animations.isEmpty)
        let p = try #require(m.meshes.first?.primitives.first)
        #expect(p.vertexCount == 3824 && p.indices.count == 9567)
        #expect(p.joints.isEmpty && p.normals.count == 3824 * 3 && p.uvs.count == 3824 * 2)
    }

    @Test func rejectsDamagedFiles() throws {
        let data = try Data(contentsOf: Self.baked.appending(path: "carbine.ivm"))
        #expect(throws: IVMModel.ReadError.badMagic) { try IVMModel(data: Data([0, 1, 2, 3]) + data.dropFirst(4)) }
        var future = data
        future[4] = 99
        #expect(throws: IVMModel.ReadError.unsupportedVersion(99)) { try IVMModel(data: future) }
        #expect(throws: IVMModel.ReadError.self) { try IVMModel(data: data.prefix(data.count - 8)) }
        #expect(throws: IVMModel.ReadError.self) { try IVMModel(data: data + Data([0, 0, 0, 0])) }
    }
}
