import Foundation
import Testing
@testable import IronvaleMapData
@testable import IronvaleWorld

private let packagesRoot = URL(filePath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appending(path: "MapPackages")

@Suite struct MapPackageTests {
    @Test func registryListsEveryExportedMap() throws {
        let registry = try MapRegistry(root: packagesRoot)
        #expect(registry.ids == ["harbor", "headworks", "railyard", "range"])
        #expect(!registry.has("guns"))
        #expect(!registry.has("atlantis"))
    }

    @Test(arguments: ["range", "railyard", "headworks", "harbor"])
    func packageLoadsAndValidates(_ id: String) throws {
        let package = try MapRegistry(root: packagesRoot).load(id)
        let meta = package.meta
        #expect(meta.id == id)
        #expect(meta.playable == (id != "range"))
        #expect(meta.detailDensity == 1)
        #expect(!meta.spawns.player.isEmpty)
        #expect(!meta.spawns.enemy.isEmpty)
        #expect(meta.sourceCommit.count == 40)
        // Spawns stand on or just above the collision floor.
        for spawn in meta.spawns.player + meta.spawns.enemy {
            let p = spawn.point
            let ground = package.world.groundHeight(x: p.x, z: p.z, fromY: p.y + 1)
            #expect(ground != nil, "\(id) spawn \(p) has no floor")
            if let ground { #expect(abs(p.y - ground) < 0.3, "\(id) spawn \(p) is \(p.y - ground) m above the floor") }
        }
        #expect(package.world.main.triangleCount == meta.collision.triangles)
    }

    @Test func railyardSpawnsMatchThePlan() throws {
        // src/maps/railyard/plan.ts: the first player spawn, yaw 0 (degrees converted to radians).
        let meta = try MapRegistry(root: packagesRoot).load("railyard").meta
        #expect(meta.spawns.player[0].position == [-3, 0.05, 45.5])
        #expect(meta.spawns.player[0].yaw == 0)
        #expect(meta.spawns.enemy[0].yaw == Double.pi)
    }

    @Test func tamperedCollisionIsRefused() throws {
        let source = packagesRoot.appending(path: "range")
        let copy = FileManager.default.temporaryDirectory.appending(path: "ironvale-map-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: copy, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: copy) }
        for name in ["meta.json", "collision.bin", "boundary.bin", "bvh.bin"] {
            try FileManager.default.copyItem(at: source.appending(path: name), to: copy.appending(path: name))
        }
        var bytes = try Data(contentsOf: copy.appending(path: "collision.bin"))
        bytes[100] ^= 0x01
        try bytes.write(to: copy.appending(path: "collision.bin"))
        #expect(throws: MapPackageError.self) { try MapPackage.load(directory: copy) }
    }
}
