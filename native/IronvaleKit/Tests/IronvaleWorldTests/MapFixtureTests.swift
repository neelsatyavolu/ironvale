// Replays the collision query fixtures map-export recorded from the TypeScript CollisionWorld
// (native/Tools/map-export/page/queries.ts documents the format and the path driver).
// M2 exit check: same hit or miss, same surface, positions within 1e-5 m.
import Foundation
import Testing
@testable import IronvaleWorld

let packagesRoot = URL(filePath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appending(path: "MapPackages")

let fixtureMaps = ["range", "railyard", "headworks", "harbor"]
private let tolerance = 1e-5
private let gravity = 17.5
private let jumpSpeed = 4.6

func loadWorld(_ id: String) throws -> CollisionWorld {
    let dir = packagesRoot.appending(path: id)
    return try CollisionPackage.load(
        collision: Data(contentsOf: dir.appending(path: "collision.bin")),
        boundary: Data(contentsOf: dir.appending(path: "boundary.bin")),
        bvh: Data(contentsOf: dir.appending(path: "bvh.bin"))
    )
}

/// Collects mismatches instead of failing per query, so one report shows the whole picture.
private struct Tally {
    var checked = 0
    var failures: [String] = []
    var maxError = 0.0

    mutating func same(_ a: Bool, _ b: Bool, _ what: @autoclosure () -> String) {
        checked += 1
        if a != b { failures.append("\(what()): swift \(a), ts \(b)") }
    }

    mutating func same(_ a: Int, _ b: Int, _ what: @autoclosure () -> String) {
        checked += 1
        if a != b { failures.append("\(what()): swift \(a), ts \(b)") }
    }

    mutating func near(_ a: Double, _ b: Double, _ what: @autoclosure () -> String) {
        checked += 1
        let error = abs(a - b)
        maxError = max(maxError, error.isNaN ? .infinity : error)
        if !(error <= tolerance) { failures.append("\(what()): swift \(a), ts \(b)") }
    }

    mutating func near(_ a: Vec3, _ b: Vec3, _ what: @autoclosure () -> String) {
        near(a.x, b.x, "\(what()).x")
        near(a.y, b.y, "\(what()).y")
        near(a.z, b.z, "\(what()).z")
    }
}

private func surfaceIndex(_ s: Surface?) -> Int { s.map { Int($0.rawValue) } ?? -1 }

@Suite struct MapFixtureTests {
    @Test(arguments: fixtureMaps)
    func swiftBuildsTheSameTreeAsMeshBVH(_ id: String) throws {
        let world = try loadWorld(id)
        let rebuilt = TriangleBVH(positions: world.main.positions, targetLeafSize: 8)
        #expect(rebuilt.index == world.main.index)
        #expect(rebuilt.nodes == world.main.nodes)
        if let boundary = world.boundary {
            let rebuiltBoundary = TriangleBVH(positions: boundary.positions, targetLeafSize: 8)
            #expect(rebuiltBoundary.index == boundary.index)
            #expect(rebuiltBoundary.nodes == boundary.nodes)
        }
    }

    @Test(arguments: fixtureMaps)
    func swiftMatchesTheRecordedQueries(_ id: String) throws {
        let world = try loadWorld(id)
        var r = try ByteReader(Data(contentsOf: packagesRoot.appending(path: "\(id)/fixtures/queries.bin")))
        try r.magic("IVQ1")
        #expect(try r.u32() == 1)
        let rays = try r.count(), los = try r.count(), grounds = try r.count(), fits = try r.count(), paths = try r.count()
        let steps = try r.count(), sampleEvery = try r.count(), segmentCount = try r.count()
        try r.skip(8)
        #expect(rays + los + grounds + fits + paths == 10000)
        func vec() throws -> Vec3 { Vec3(try r.f64(), try r.f64(), try r.f64()) }

        var tally = Tally()
        for i in 0 ..< rays {
            let origin = try vec(), direction = try vec(), maxDistance = try r.f64()
            let hit = try r.f64() == 1, surface = Int(try r.f64()), point = try vec(), normal = try vec(), distance = try r.f64()
            let swift = world.raycast(origin: origin, direction: direction, maxDistance: maxDistance)
            tally.same(swift != nil, hit, "raycast \(i) hit")
            guard let swift, hit else { continue }
            tally.same(surfaceIndex(swift.surface), surface, "raycast \(i) surface")
            tally.near(swift.point, point, "raycast \(i) point")
            tally.near(swift.normal, normal, "raycast \(i) normal")
            tally.near(swift.distance, distance, "raycast \(i) distance")
        }
        for i in 0 ..< los {
            let a = try vec(), b = try vec(), visible = try r.f64() == 1
            tally.same(world.lineOfSight(a, b), visible, "los \(i)")
        }
        for i in 0 ..< grounds {
            let x = try r.f64(), z = try r.f64(), fromY = try r.f64(), maxDrop = try r.f64()
            let hit = try r.f64() == 1, y = try r.f64()
            let swift = world.groundHeight(x: x, z: z, fromY: fromY, maxDrop: maxDrop)
            tally.same(swift != nil, hit, "ground \(i) hit")
            if let swift, hit { tally.near(swift, y, "ground \(i) y") }
        }
        for i in 0 ..< fits {
            let p = try vec(), radius = try r.f64(), height = try r.f64(), fit = try r.f64() == 1
            tally.same(world.capsuleFits(position: p, radius: radius, height: height), fit, "fits \(i)")
        }
        let perSegment = steps / segmentCount
        for i in 0 ..< paths {
            var pos = try vec()
            let radius = try r.f64(), height = try r.f64(), dt = try r.f64()
            let segments = try (0 ..< segmentCount).map { _ in (try r.f64(), try r.f64(), try r.f64() == 1) }
            var vel = Vec3.zero
            var onGround = false
            var surface: Surface?
            for step in 0 ..< steps {
                let (vx, vz, jump) = segments[step / perSegment]
                vel = Vec3(vx, vel.y - gravity * dt, vz)
                if jump && step % perSegment == 0 && onGround { vel.y = jumpSpeed }
                let result = world.moveCapsule(position: pos, velocity: vel, dt: dt, radius: radius, height: height)
                pos = result.position
                vel = result.velocity
                onGround = result.onGround
                surface = result.groundSurface
                if onGround && vel.y < 0 { vel.y = 0 }
                if (step + 1) % sampleEvery == 0 { tally.near(pos, try vec(), "path \(i) step \(step) position") }
            }
            tally.near(vel, try vec(), "path \(i) velocity")
            tally.same(onGround, try r.f64() == 1, "path \(i) onGround")
            tally.same(surfaceIndex(surface), Int(try r.f64()), "path \(i) groundSurface")
        }
        #expect(r.remaining == 0)
        print("\(id): \(tally.checked) checks, \(tally.failures.count) mismatches, max position error \(tally.maxError) m")
        #expect(tally.failures.isEmpty, "\(id): \(tally.failures.count) mismatches, first: \(tally.failures.prefix(10).joined(separator: "; "))")
    }
}
