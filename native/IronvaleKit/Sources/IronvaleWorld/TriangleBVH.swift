// Ported at commit 185029e from three-mesh-bvh 0.9.18 (the version src/world/collision.ts uses):
//   src/core/build/buildTree.js, computeBoundsUtils.js, splitUtils.js (CENTER only), sortUtils.js,
//   src/core/MeshBVH.js (computePrimitiveBounds, raycastFirst, shapecast),
//   src/core/cast/raycastFirst.generated.js, shapecast.js, src/core/utils/intersectUtils.js,
//   src/core/utils/iterationUtils.generated.js, src/utils/ThreeRayIntersectUtilities.js.
//
// The node buffer is MeshBVH's packed layout, 32 bytes per node, depth first:
//   f32 min xyz, f32 max xyz,
//   u32 word 6: leaf -> first triangle; internal -> right child offset in nodes from this node,
//   u32 word 7: leaf -> count (low 16 bits) | 0xFFFF << 16; internal -> split axis.
// Walking the same buffer in the same order as the JavaScript reproduces the capsule solver's
// triangle visit order, which its result depends on (PLAN.md 3.6).

/// Number of 32-bit words per node.
let wordsPerNode = 8
private let leafFlag: UInt32 = 0xFFFF
private let float32Epsilon = 1.0 / 16_777_216.0 // Math.pow(2, -24)

/// One triangle soup with a `MeshBVH`-identical tree over it.
public struct TriangleBVH: Sendable {
    /// Vertex positions, xyz per vertex, three vertices per triangle (non-indexed soup).
    public let positions: [Float]
    /// The BVH-ordered index: triangle `t` of the tree uses vertices `index[3t ..< 3t+3]`.
    public let index: [UInt32]
    /// Packed nodes, `wordsPerNode` words each.
    public let nodes: [UInt32]

    public var triangleCount: Int { index.count / 3 }

    /// Wraps a serialized `MeshBVH` (root 0 and its index).
    public init(positions: [Float], index: [UInt32], nodes: [UInt32]) throws {
        guard positions.count % 9 == 0, index.count == positions.count / 3 else {
            throw MapFormatError.invalid("BVH index has \(index.count) entries for \(positions.count / 3) vertices")
        }
        guard nodes.count % wordsPerNode == 0, !nodes.isEmpty else {
            throw MapFormatError.invalid("BVH node buffer is \(nodes.count) words")
        }
        let vertexCount = UInt32(positions.count / 3)
        guard index.allSatisfy({ $0 < vertexCount }) else { throw MapFormatError.invalid("BVH index out of range") }
        self.positions = positions
        self.index = index
        self.nodes = nodes
    }

    /// Builds the tree exactly as `new MeshBVH(geometry, { targetLeafSize })` does with the
    /// default CENTER strategy and maxDepth 40, for a non-indexed geometry.
    public init(positions: [Float], targetLeafSize: Int = 10, maxDepth: Int = 40) {
        precondition(positions.count % 9 == 0 && !positions.isEmpty, "a BVH needs at least one whole triangle")
        self.positions = positions
        var builder = Builder(positions: positions, targetLeafSize: targetLeafSize, maxDepth: maxDepth)
        builder.build()
        index = builder.index
        nodes = builder.nodes
    }

    // MARK: - Node access

    @inline(__always) func bound(_ node: Int, _ k: Int) -> Double { Double(Float(bitPattern: nodes[node + k])) }
    @inline(__always) func isLeaf(_ node: Int) -> Bool { nodes[node + 7] >> 16 == leafFlag }
    @inline(__always) func leafOffset(_ node: Int) -> Int { Int(nodes[node + 6]) }
    @inline(__always) func leafCount(_ node: Int) -> Int { Int(nodes[node + 7] & 0xFFFF) }
    @inline(__always) func rightChild(_ node: Int) -> Int { node + Int(nodes[node + 6]) * wordsPerNode }
    @inline(__always) func splitAxis(_ node: Int) -> Int { Int(nodes[node + 7]) }
    @inline(__always) func box(_ node: Int) -> Box3 {
        Box3(min: Vec3(bound(node, 0), bound(node, 1), bound(node, 2)), max: Vec3(bound(node, 3), bound(node, 4), bound(node, 5)))
    }

    @inline(__always) func vertex(_ v: UInt32) -> Vec3 {
        let i = Int(v) * 3
        return Vec3(Double(positions[i]), Double(positions[i + 1]), Double(positions[i + 2]))
    }

    /// Triangle `t` in tree order (`setTriangle(tri, t * 3, index, position)`).
    @inline(__always) public func triangle(_ t: Int) -> Triangle3 {
        Triangle3(vertex(index[t * 3]), vertex(index[t * 3 + 1]), vertex(index[t * 3 + 2]))
    }

    // MARK: - raycastFirst

    public struct Hit: Sendable {
        public let distance: Double
        public let point: Vec3
        /// Triangle index in tree order (`faceIndex`).
        public let triangle: Int
    }

    /// `MeshBVH.raycastFirst(ray, DoubleSide, near, far)`.
    public func raycastFirst(_ ray: Ray3, near: Double, far: Double) -> Hit? {
        guard intersectsNodeBounds(0, ray, near, far) else { return nil }
        return raycastFirst(node: 0, ray, near, far)
    }

    private func raycastFirst(node: Int, _ ray: Ray3, _ near: Double, _ far: Double) -> Hit? {
        if isLeaf(node) {
            var dist = Double.infinity
            var result: Hit?
            let offset = leafOffset(node)
            for t in offset ..< offset + leafCount(node) {
                let tri = triangle(t)
                guard let point = ray.intersectTriangle(tri.a, tri.b, tri.c) else { continue }
                let distance = ray.origin.distance(to: point)
                if distance < near || distance > far { continue }
                if distance < dist {
                    result = Hit(distance: distance, point: point, triangle: t)
                    dist = distance
                }
            }
            return result
        }
        let axis = splitAxis(node)
        let leftToRight = ray.direction[axis] >= 0
        let c1 = leftToRight ? node + wordsPerNode : rightChild(node)
        let c2 = leftToRight ? rightChild(node) : node + wordsPerNode
        let c1Result = intersectsNodeBounds(c1, ray, near, far) ? raycastFirst(node: c1, ray, near, far) : nil
        if let c1Result {
            let point = c1Result.point[axis]
            let isOutside = leftToRight ? point <= bound(c2, axis) : point >= bound(c2, axis + 3)
            if isOutside { return c1Result }
        }
        let c2Result = intersectsNodeBounds(c2, ray, near, far) ? raycastFirst(node: c2, ray, near, far) : nil
        if let c1Result, let c2Result { return c1Result.distance <= c2Result.distance ? c1Result : c2Result }
        return c1Result ?? c2Result
    }

    /// `intersectsNodeBounds` (slab test with three's NaN handling).
    private func intersectsNodeBounds(_ node: Int, _ ray: Ray3, _ near: Double, _ far: Double) -> Bool {
        let invdirx = 1 / ray.direction.x, invdiry = 1 / ray.direction.y, invdirz = 1 / ray.direction.z
        let ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z
        let minx = bound(node, 0), maxx = bound(node, 3)
        let miny = bound(node, 1), maxy = bound(node, 4)
        let minz = bound(node, 2), maxz = bound(node, 5)
        var tmin, tmax: Double
        if invdirx >= 0 {
            tmin = (minx - ox) * invdirx
            tmax = (maxx - ox) * invdirx
        } else {
            tmin = (maxx - ox) * invdirx
            tmax = (minx - ox) * invdirx
        }
        let tymin, tymax: Double
        if invdiry >= 0 {
            tymin = (miny - oy) * invdiry
            tymax = (maxy - oy) * invdiry
        } else {
            tymin = (maxy - oy) * invdiry
            tymax = (miny - oy) * invdiry
        }
        if tmin > tymax || tymin > tmax { return false }
        if tymin > tmin || tmin.isNaN { tmin = tymin }
        if tymax < tmax || tmax.isNaN { tmax = tymax }
        let tzmin, tzmax: Double
        if invdirz >= 0 {
            tzmin = (minz - oz) * invdirz
            tzmax = (maxz - oz) * invdirz
        } else {
            tzmin = (maxz - oz) * invdirz
            tzmax = (minz - oz) * invdirz
        }
        if tmin > tzmax || tzmin > tmax { return false }
        if tzmin > tmin || tmin.isNaN { tmin = tzmin }
        if tzmax < tmax || tmax.isNaN { tmax = tzmax }
        return tmin <= far && tmax >= near
    }

    // MARK: - shapecast

    /// `MeshBVH.shapecast({ intersectsBounds, intersectsTriangle })` for callbacks that never return
    /// CONTAINED. `intersectsTriangle` gets the triangle and its tree index; returning true stops.
    public func shapecast(
        intersectsBounds: (Box3) -> Bool,
        intersectsTriangle: (Triangle3, Int) -> Bool
    ) -> Bool {
        shapecast(node: 0, intersectsBounds, intersectsTriangle)
    }

    private func shapecast(
        node: Int,
        _ intersectsBounds: (Box3) -> Bool,
        _ intersectsTriangle: (Triangle3, Int) -> Bool
    ) -> Bool {
        if isLeaf(node) {
            let offset = leafOffset(node)
            for t in offset ..< offset + leafCount(node) where intersectsTriangle(triangle(t), t) {
                return true
            }
            return false
        }
        let c1 = node + wordsPerNode
        let c2 = rightChild(node)
        if intersectsBounds(box(c1)), shapecast(node: c1, intersectsBounds, intersectsTriangle) { return true }
        if intersectsBounds(box(c2)), shapecast(node: c2, intersectsBounds, intersectsTriangle) { return true }
        return false
    }
}

// MARK: - Build

private struct Builder {
    let positions: [Float]
    let targetLeafSize: Int
    let maxDepth: Int
    var index: [UInt32]
    /// Per triangle: centre x, half x, centre y, half y, centre z, half z (Float32Array in JS).
    var primitiveBounds: [Float]
    var nodes: [UInt32] = []
    var nodeBounds = [Float](repeating: 0, count: 6)
    var centroidBounds = [Float](repeating: 0, count: 6)

    init(positions: [Float], targetLeafSize: Int, maxDepth: Int) {
        self.positions = positions
        self.targetLeafSize = targetLeafSize
        self.maxDepth = maxDepth
        let vertexCount = positions.count / 3
        index = (0 ..< UInt32(vertexCount)).map { $0 }
        let count = vertexCount / 3
        var bounds = [Float](repeating: 0, count: count * 6)
        for tri in 0 ..< count {
            let ai = tri * 9, bi = tri * 9 + 3, ci = tri * 9 + 6
            for el in 0 ..< 3 {
                let a = Double(positions[ai + el]), b = Double(positions[bi + el]), c = Double(positions[ci + el])
                var lo = a
                if b < lo { lo = b }
                if c < lo { lo = c }
                var hi = a
                if b > hi { hi = b }
                if c > hi { hi = c }
                let halfExtents = (hi - lo) / 2
                bounds[tri * 6 + el * 2] = Float(lo + halfExtents)
                bounds[tri * 6 + el * 2 + 1] = Float(halfExtents + (abs(lo) + halfExtents) * float32Epsilon)
            }
        }
        primitiveBounds = bounds
    }

    mutating func build() {
        let count = index.count / 3
        nodes.reserveCapacity(wordsPerNode * max(1, 2 * count - 1))
        getBounds(offset: 0, count: count)
        splitNode(offset: 0, count: count, depth: 0)
    }

    /// `getBounds`: node bounds and centroid bounds, computed in double and stored as float.
    mutating func getBounds(offset: Int, count: Int) {
        var minx = Double.infinity, miny = Double.infinity, minz = Double.infinity
        var maxx = -Double.infinity, maxy = -Double.infinity, maxz = -Double.infinity
        var cminx = Double.infinity, cminy = Double.infinity, cminz = Double.infinity
        var cmaxx = -Double.infinity, cmaxy = -Double.infinity, cmaxz = -Double.infinity
        var i = offset * 6
        let end = (offset + count) * 6
        while i < end {
            let cx = Double(primitiveBounds[i]), hx = Double(primitiveBounds[i + 1])
            let lx = cx - hx, rx = cx + hx
            if lx < minx { minx = lx }
            if rx > maxx { maxx = rx }
            if cx < cminx { cminx = cx }
            if cx > cmaxx { cmaxx = cx }
            let cy = Double(primitiveBounds[i + 2]), hy = Double(primitiveBounds[i + 3])
            let ly = cy - hy, ry = cy + hy
            if ly < miny { miny = ly }
            if ry > maxy { maxy = ry }
            if cy < cminy { cminy = cy }
            if cy > cmaxy { cmaxy = cy }
            let cz = Double(primitiveBounds[i + 4]), hz = Double(primitiveBounds[i + 5])
            let lz = cz - hz, rz = cz + hz
            if lz < minz { minz = lz }
            if rz > maxz { maxz = rz }
            if cz < cminz { cminz = cz }
            if cz > cmaxz { cmaxz = cz }
            i += 6
        }
        nodeBounds = [Float(minx), Float(miny), Float(minz), Float(maxx), Float(maxy), Float(maxz)]
        centroidBounds = [Float(cminx), Float(cminy), Float(cminz), Float(cmaxx), Float(cmaxy), Float(cmaxz)]
    }

    /// `getLongestEdgeIndex`.
    static func longestEdge(_ bounds: [Float]) -> Int {
        var splitDimIdx = -1
        var splitDist = -Double.infinity
        for i in 0 ..< 3 {
            let dist = Double(bounds[i + 3]) - Double(bounds[i])
            if dist > splitDist {
                splitDist = dist
                splitDimIdx = i
            }
        }
        return splitDimIdx
    }

    /// Hoare partition of triangles around `pos` on `axis`; returns the first right-side triangle.
    mutating func partition(offset: Int, count: Int, axis: Int, pos: Double) -> Int {
        var left = offset
        var right = offset + count - 1
        let axisOffset = axis * 2
        while true {
            while left <= right && Double(primitiveBounds[left * 6 + axisOffset]) < pos { left += 1 }
            while left <= right && Double(primitiveBounds[right * 6 + axisOffset]) >= pos { right -= 1 }
            if left < right {
                for i in 0 ..< 3 { index.swapAt(left * 3 + i, right * 3 + i) }
                for i in 0 ..< 6 { primitiveBounds.swapAt(left * 6 + i, right * 6 + i) }
                left += 1
                right -= 1
            } else {
                return left
            }
        }
    }

    mutating func writeBounds(_ node: Int) {
        for k in 0 ..< 6 { nodes[node + k] = nodeBounds[k].bitPattern }
    }

    mutating func writeLeaf(_ node: Int, offset: Int, count: Int) {
        nodes[node + 6] = UInt32(offset)
        nodes[node + 7] = UInt32(count) | (leafFlag << 16)
    }

    mutating func splitNode(offset: Int, count: Int, depth: Int) {
        let nodeIndex = nodes.count / wordsPerNode
        let node = nodes.count
        nodes.append(contentsOf: repeatElement(0, count: wordsPerNode))
        writeBounds(node)

        if count <= targetLeafSize || depth >= maxDepth {
            writeLeaf(node, offset: offset, count: count)
            return
        }
        let axis = Builder.longestEdge(centroidBounds)
        guard axis != -1 else {
            writeLeaf(node, offset: offset, count: count)
            return
        }
        let pos = (Double(centroidBounds[axis]) + Double(centroidBounds[axis + 3])) / 2
        let splitOffset = partition(offset: offset, count: count, axis: axis, pos: pos)
        if splitOffset == offset || splitOffset == offset + count {
            writeLeaf(node, offset: offset, count: count)
            return
        }
        nodes[node + 7] = UInt32(axis)

        let leftCount = splitOffset - offset
        getBounds(offset: offset, count: leftCount)
        splitNode(offset: offset, count: leftCount, depth: depth + 1)

        nodes[node + 6] = UInt32(nodes.count / wordsPerNode - nodeIndex)

        let rightCount = count - leftCount
        getBounds(offset: splitOffset, count: rightCount)
        splitNode(offset: splitOffset, count: rightCount, depth: depth + 1)
    }
}
