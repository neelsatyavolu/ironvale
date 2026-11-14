// Ported from src/world/collision.ts and src/world/types.ts (Surface) at commit 185029e.
// Queries take and return float64 values in metres, Y up, exactly as the TypeScript does.

/// Physical surface kind. Raw values are the order of `SURFACES` in collision.ts, which is the byte
/// stored per triangle in collision.bin.
public enum Surface: UInt8, Sendable, CaseIterable, Codable {
    case concrete, cobble, asphalt, gravel, dirt, grass, sand, wood, metal, plaster, glass, water, foliage, flesh

    public var name: String { String(describing: self) }
}

public struct RayHit: Sendable, Equatable {
    public let point: Vec3
    /// Face normal, flipped to face the ray origin.
    public let normal: Vec3
    public let distance: Double
    public let surface: Surface
}

public struct CapsuleMoveResult: Sendable, Equatable {
    /// Feet position after sliding along the world.
    public let position: Vec3
    /// Velocity after removing the component that pushed into walls or floor.
    public let velocity: Vec3
    public let onGround: Bool
    /// Surface under the feet when grounded.
    public let groundSurface: Surface?
}

/// Capsule sub-steps never move further than this fraction of the radius.
let maxStepFraction = 0.5
let maxSubsteps = 6
/// Slopes steeper than this (normal.y below it) do not count as ground.
let groundNormalY = 0.55

/// Static triangle-soup collision world: one BVH for colliders, one for the boundary that blocks
/// bodies but not rays. Immutable, so it can be shared across actors.
public final class CollisionWorld: Sendable {
    public let main: TriangleBVH
    public let boundary: TriangleBVH?
    /// Surface per triangle in original (registration) order.
    public let surfaces: [Surface]
    /// Box of every non-boundary vertex (`geometry.computeBoundingBox()`).
    public let bounds: Box3

    public init(main: TriangleBVH, boundary: TriangleBVH?, surfaces: [Surface]) throws {
        guard surfaces.count == main.triangleCount else {
            throw MapFormatError.invalid("\(surfaces.count) surfaces for \(main.triangleCount) triangles")
        }
        self.main = main
        self.boundary = boundary
        self.surfaces = surfaces
        var box = Box3.empty
        let p = main.positions
        var i = 0
        while i < p.count {
            box = box.expanded(by: Vec3(Double(p[i]), Double(p[i + 1]), Double(p[i + 2])))
            i += 3
        }
        bounds = box
    }

    /// Builds both trees the way `CollisionWorld.build()` does (`targetLeafSize: 8`).
    public convenience init(triangles: [Float], surfaces: [Surface], boundary: [Float] = []) throws {
        try self.init(
            main: TriangleBVH(positions: triangles, targetLeafSize: 8),
            boundary: boundary.isEmpty ? nil : TriangleBVH(positions: boundary, targetLeafSize: 8),
            surfaces: surfaces
        )
    }

    public func raycast(origin: Vec3, direction: Vec3, maxDistance: Double) -> RayHit? {
        let ray = Ray3(origin: origin, direction: direction.normalized())
        guard let hit = main.raycastFirst(ray, near: 0, far: maxDistance) else { return nil }
        var normal = main.triangle(hit.triangle).normal
        // Double-sided hits can report a back-facing normal; always face the shooter.
        if normal.dot(ray.direction) > 0 { normal = Vec3(-normal.x, -normal.y, -normal.z) }
        return RayHit(point: hit.point, normal: normal, distance: hit.distance, surface: surface(ofTreeTriangle: hit.triangle))
    }

    /// true when nothing solid lies between a and b.
    public func lineOfSight(_ a: Vec3, _ b: Vec3) -> Bool {
        let delta = b - a
        let distance = delta.length
        if distance < 1e-4 { return true }
        let ray = Ray3(origin: a, direction: delta.scaled(1 / distance))
        return main.raycastFirst(ray, near: 0, far: distance - 0.02) == nil
    }

    /// Height of the ground below a point, or nil when there is none within `maxDrop`.
    public func groundHeight(x: Double, z: Double, fromY: Double, maxDrop: Double = 50) -> Double? {
        let ray = Ray3(origin: Vec3(x, fromY, z), direction: Vec3(0, -1, 0))
        return main.raycastFirst(ray, near: 0, far: maxDrop)?.point.y
    }

    /// Moves an upright capsule (feet at `position`) by `velocity * dt`, sliding along geometry.
    public func moveCapsule(position: Vec3, velocity: Vec3, dt: Double, radius: Double, height: Double) -> CapsuleMoveResult {
        var pos = position
        var vel = velocity
        let travel = vel.length * dt
        let steps = Int(Swift.min(Double(maxSubsteps), Swift.max(1, (travel / (radius * maxStepFraction)).rounded(.up))))
        let stepDt = dt / Double(steps)
        var onGround = false

        for _ in 0 ..< steps {
            pos = pos.adding(vel, scaledBy: stepDt)
            var segment = Segment(
                start: Vec3(pos.x, pos.y + radius, pos.z),
                end: Vec3(pos.x, pos.y + Swift.max(radius, height - radius), pos.z)
            )
            let box = Box3.empty.expanded(by: segment.start).expanded(by: segment.end).expanded(byScalar: radius)

            var groundedThisStep = false
            let intersectsBounds = { (node: Box3) in node.intersects(box) }
            let intersectsTriangle = { (tri: Triangle3, _: Int) -> Bool in
                guard let closest = tri.closestPoints(to: segment) else { return false }
                if closest.distance >= radius { return false }
                let depth = radius - closest.distance
                var push = closest.onSegment - closest.onTriangle
                if push.lengthSq < 1e-10 { push = tri.normal } else { push = push.normalized() }
                if push.y > groundNormalY { groundedThisStep = true }
                segment.start = segment.start.adding(push, scaledBy: depth)
                segment.end = segment.end.adding(push, scaledBy: depth)
                // Remove the velocity component pushing into the surface.
                let into = vel.dot(push)
                if into < 0 { vel = vel.adding(push, scaledBy: -into) }
                return false
            }
            _ = main.shapecast(intersectsBounds: intersectsBounds, intersectsTriangle: intersectsTriangle)
            _ = boundary?.shapecast(intersectsBounds: intersectsBounds, intersectsTriangle: intersectsTriangle)

            pos = Vec3(segment.start.x, segment.start.y - radius, segment.start.z)
            onGround = groundedThisStep
        }

        var groundSurface: Surface?
        if onGround {
            let ray = Ray3(origin: Vec3(pos.x, pos.y + radius, pos.z), direction: Vec3(0, -1, 0))
            groundSurface = main.raycastFirst(ray, near: 0, far: radius + 0.4).map { surface(ofTreeTriangle: $0.triangle) }
        }
        return CapsuleMoveResult(position: pos, velocity: vel, onGround: onGround, groundSurface: groundSurface)
    }

    /// true when an upright capsule with its feet at `position` touches nothing.
    public func capsuleFits(position: Vec3, radius: Double, height: Double) -> Bool {
        // Lift the bottom a little so standing on the floor does not count as touching.
        let lift = 0.05
        let segment = Segment(
            start: Vec3(position.x, position.y + radius + lift, position.z),
            end: Vec3(position.x, position.y + Swift.max(radius + lift, height - radius), position.z)
        )
        let box = Box3.empty.expanded(by: segment.start).expanded(by: segment.end).expanded(byScalar: radius)
        let intersectsBounds = { (node: Box3) in node.intersects(box) }
        let intersectsTriangle = { (tri: Triangle3, _: Int) -> Bool in
            guard let closest = tri.closestPoints(to: segment) else { return false }
            return closest.distance < radius
        }
        if main.shapecast(intersectsBounds: intersectsBounds, intersectsTriangle: intersectsTriangle) { return false }
        return !(boundary?.shapecast(intersectsBounds: intersectsBounds, intersectsTriangle: intersectsTriangle) ?? false)
    }

    /// `surfaceOfFace`: the surface byte of the face's first vertex in the BVH-reordered index.
    func surface(ofTreeTriangle t: Int) -> Surface {
        let vertex = Int(main.index[t * 3])
        return surfaces[vertex / 3]
    }
}
