// Ported from tests/world/collision.test.ts at commit 185029e.
import Foundation
import Testing
@testable import IronvaleWorld

/// The world from collision.test.ts: a 100 m dirt plane, a 2 m metal wall at z = -5, a 0.15 m wood step at x = 20.
private let world: CollisionWorld = {
    var triangles: [Float] = []
    var surfaces: [Surface] = []
    func add(_ tris: [Float], _ surface: Surface) {
        triangles += tris
        surfaces += Array(repeating: surface, count: tris.count / 9)
    }
    add(Geometry.groundPlane(size: 100), .dirt)
    add(Geometry.box(center: Vec3(0, 1, -5), size: Vec3(10, 2, 0.4)), .metal)
    add(Geometry.box(center: Vec3(20, 0.075, 0), size: Vec3(2, 0.15, 2)), .wood)
    return try! CollisionWorld(triangles: triangles, surfaces: surfaces)
}()

/// Test-only triangle generators matching three's PlaneGeometry (rotated flat) and BoxGeometry.
enum Geometry {
    /// `new PlaneGeometry(size, size).rotateX(-PI / 2)`, non-indexed.
    static func groundPlane(size: Double) -> [Float] {
        let h = size / 2
        let c = cos(-Double.pi / 2), s = sin(-Double.pi / 2)
        // PlaneGeometry vertices (x, -y, 0) for iy, ix in 0...1, then rotateX.
        let raw = [Vec3(-h, h, 0), Vec3(h, h, 0), Vec3(-h, -h, 0), Vec3(h, -h, 0)]
        let v = raw.map { Vec3($0.x, $0.y * c - $0.z * s, $0.y * s + $0.z * c) }
        return [v[0], v[2], v[1], v[2], v[3], v[1]].flatMap { [Float($0.x), Float($0.y), Float($0.z)] }
    }

    /// An axis-aligned box as 12 outward-facing triangles.
    static func box(center: Vec3, size: Vec3) -> [Float] {
        let lo = center - size.scaled(0.5), hi = center + size.scaled(0.5)
        func p(_ i: Int) -> Vec3 { Vec3(i & 1 == 0 ? lo.x : hi.x, i & 2 == 0 ? lo.y : hi.y, i & 4 == 0 ? lo.z : hi.z) }
        let quads = [[1, 3, 7, 5], [0, 4, 6, 2], [2, 6, 7, 3], [0, 1, 5, 4], [4, 5, 7, 6], [0, 2, 3, 1]]
        return quads.flatMap { q in [q[0], q[1], q[2], q[0], q[2], q[3]].map(p) }.flatMap { [Float($0.x), Float($0.y), Float($0.z)] }
    }
}

private func settle(_ position: Vec3, _ velocity: Vec3, seconds: Double) -> CapsuleMoveResult {
    var pos = position
    var vel = velocity
    var result = world.moveCapsule(position: pos, velocity: vel, dt: 0, radius: 0.34, height: 1.8)
    var t = 0.0
    while t < seconds {
        vel = Vec3(vel.x, vel.y - 17.5 / 60, vel.z)
        result = world.moveCapsule(position: pos, velocity: vel, dt: 1.0 / 60, radius: 0.34, height: 1.8)
        pos = result.position
        vel = result.velocity
        if result.onGround && vel.y < 0 { vel = Vec3(vel.x, 0, vel.z) }
        t += 1.0 / 60
    }
    return result
}

/// vitest `toBeCloseTo(expected, digits)`.
private func close(_ value: Double?, _ expected: Double, _ digits: Int) -> Bool {
    guard let value else { return false }
    return abs(value - expected) < pow(10, Double(-digits)) / 2
}

@Suite struct CollisionWorldTests {
    @Test func raycastsToTheNearestSurfaceAndReportsItsKind() {
        let hit = world.raycast(origin: Vec3(0, 1, 0), direction: Vec3(0, 0, -1), maxDistance: 50)
        #expect(hit?.surface == .metal)
        #expect(close(hit?.distance, 4.8, 3))
        #expect(close(hit?.normal.z, 1, 3))
        #expect(world.raycast(origin: Vec3(0, 1, 0), direction: Vec3(0, -1, 0), maxDistance: 50)?.surface == .dirt)
        #expect(world.raycast(origin: Vec3(0, 1, 0), direction: Vec3(0, 1, 0), maxDistance: 50) == nil)
    }

    @Test func answersLineOfSight() {
        #expect(world.lineOfSight(Vec3(0, 1, 0), Vec3(0, 1, -10)) == false)
        #expect(world.lineOfSight(Vec3(0, 3, 0), Vec3(0, 3, -10)) == true)
    }

    @Test func dropsACapsuleOntoTheGroundAndReportsTheSurface() {
        let result = settle(Vec3(5, 2, 5), .zero, seconds: 1.5)
        #expect(result.onGround)
        #expect(close(result.position.y, 0, 1))
        #expect(result.groundSurface == .dirt)
    }

    @Test func stopsAWalkingCapsuleAtAWall() {
        let result = settle(Vec3(0, 0.02, 0), Vec3(0, 0, -4), seconds: 3)
        #expect(result.position.z > -4.8 + 0.3)
        #expect(result.position.z < -4)
    }

    @Test func walksUpALowStep() {
        var pos = Vec3(17.5, 0.02, 0)
        var vel = Vec3(3, 0, 0)
        for _ in 0 ..< 60 {
            vel = Vec3(3, vel.y - 17.5 / 60, 0)
            let result = world.moveCapsule(position: pos, velocity: vel, dt: 1.0 / 60, radius: 0.34, height: 1.8)
            pos = result.position
            vel = result.velocity
            if result.onGround && vel.y < 0 { vel = Vec3(vel.x, 0, vel.z) }
        }
        #expect(pos.x > 19.5)
        #expect(pos.y > 0.1)
    }

    @Test func findsGroundHeight() {
        #expect(close(world.groundHeight(x: 20, z: 0, fromY: 5), 0.15, 3))
        #expect(world.groundHeight(x: 500, z: 0, fromY: 5) == nil)
    }

    @Test func capsuleFitsInTheOpenButNotInsideTheWall() {
        #expect(world.capsuleFits(position: Vec3(5, 0, 5), radius: 0.34, height: 1.8))
        #expect(!world.capsuleFits(position: Vec3(0, 0, -5), radius: 0.34, height: 1.8))
    }
}
