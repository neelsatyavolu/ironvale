// The M7b nav gate: for each exported map, the Swift NavGrid build equals the web's buildNavGrid
// (native/Contract/nav/<map>.json, written by native/Tools/nav-fixtures from src/ai/navgrid.ts):
// same grid size, node count, floor heights, edge masks, edge layers, cover masks and wet cells.
import CryptoKit
import Foundation
import IronvaleAI
import IronvaleMapData
import IronvaleWorld
import Testing

private struct NavFixture: Decodable {
    let map: String
    let nx: Int
    let nz: Int
    let originX: Double
    let originZ: Double
    let nodeCount: Int
    let linkedNodes: Int
    let sha256: [String: String]
    let edges: String
    let edgeLayers: String
}

private func sha<T>(_ array: [T]) -> String {
    array.withUnsafeBytes { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() }
}

@Test(arguments: ["range", "railyard", "headworks", "harbor"])
func navGridMatchesTheWebBuild(_ mapId: String) throws {
    let fixture = try JSONDecoder().decode(NavFixture.self, from: Data(contentsOf: navFixturesRoot.appending(path: "\(mapId).json")))
    let package = try MapPackage.load(directory: packagesRoot.appending(path: mapId))
    let seeds = (package.meta.spawns.enemy + package.meta.spawns.player).map(\.point)
    let started = ContinuousClock.now
    let grid = NavGridBuilder.build(world: package.world, bounds: package.meta.bounds.box, seeds: seeds)
    let elapsed = ContinuousClock.now - started
    print("nav \(mapId): \(grid.nodeCount) nodes (\(grid.edges.filter { $0 != 0 }.count) linked) in \(elapsed)")

    #expect(grid.nx == fixture.nx && grid.nz == fixture.nz)
    #expect(grid.originX == fixture.originX && grid.originZ == fixture.originZ)
    #expect(grid.nodeCount == fixture.nodeCount, "node count")
    #expect(grid.edges.filter { $0 != 0 }.count == fixture.linkedNodes, "linked nodes")
    let edges = [UInt8](Data(base64Encoded: fixture.edges)!)
    let layers = Data(base64Encoded: fixture.edgeLayers)!.withUnsafeBytes { Array($0.bindMemory(to: UInt16.self)) }
    if grid.nodeCount == fixture.nodeCount {
        let firstEdge = (0 ..< edges.count).first { grid.edges[$0] != edges[$0] }
        #expect(firstEdge == nil, "first edge-mask difference at node \(firstEdge ?? -1)")
        let firstLayer = (0 ..< layers.count).first { grid.edgeLayers[$0] != layers[$0] }
        #expect(firstLayer == nil, "first edge-layer difference at node \(firstLayer ?? -1)")
    }
    let hashes = [
        "colStart": sha(grid.colStart), "nodeY": sha(grid.nodeY), "edges": sha(grid.edges), "edgeLayers": sha(grid.edgeLayers),
        "coverLow": sha(grid.coverLow), "coverHigh": sha(grid.coverHigh), "wet": sha(grid.wet),
    ]
    for (name, hash) in hashes.sorted(by: { $0.key < $1.key }) {
        #expect(hash == fixture.sha256[name], "\(name) differs from the web build")
    }
}
