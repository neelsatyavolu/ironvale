// Ported from src/ai/navgrid.ts at commit cbe0add. Node counts, edge masks, edge layers and cover
// masks must equal the web's for the same map: native/Contract/nav/<map>.json (Tools/nav-fixtures)
// pins them, so every expression keeps the TypeScript's float64 order, and floor heights are stored
// as Float32 exactly as the web's Float32Array does.
import IronvaleWorld

/// Agent dimensions match the player's capsule so bots fit wherever the player does.
public enum Nav {
    public static let cell = 0.6
    public static let radius = 0.34
    public static let height = 1.8
    /// Tallest ledge walked up without jumping.
    public static let step = 0.18
    /// Surfaces with a flatter normal than this are not floor.
    public static let minNormalY = 0.6
    /// Floors stacked in one column.
    public static let maxLayers = 4
    /// Obstacles this tall hide a crouching soldier.
    public static let coverLowHeight = 1.15
    /// Obstacles this tall hide a standing soldier.
    public static let coverHighHeight = 1.65
}

/// Eight neighbours, clockwise from +X seen from above with +Z down: E, SE, S, SW, W, NW, N, NE.
public let navDirX = [1, 1, 0, -1, -1, -1, 0, 1]
public let navDirZ = [0, 1, 1, 1, 0, -1, -1, -1]
/// Direction index for a (dx, dz) step of -1, 0 or 1, at `(dz + 1) * 3 + dx + 1`.
let stepToDir = [5, 6, 7, 4, -1, 0, 3, 2, 1]

/// Walkable cells over a map, column by column; each column owns 0 to 4 nodes, top down.
public struct NavGrid: Sendable {
    public let cell = Nav.cell
    public let nx: Int
    public let nz: Int
    public let originX: Double
    public let originZ: Double
    /// First node of each column; `colStart[cols]` is the node count.
    public let colStart: [Int32]
    /// Floor height of each node (Float32, as the web stores it).
    public let nodeY: [Float]
    public let nodeCol: [Int32]
    /// Bit d set when the neighbour in direction d can be walked to.
    public internal(set) var edges: [UInt8]
    /// Two bits per direction: the level index inside the neighbouring column.
    public internal(set) var edgeLayers: [UInt16]
    public internal(set) var coverLow: [UInt8]
    public internal(set) var coverHigh: [UInt8]
    /// 1 where the floor is water.
    public let wet: [UInt8]
    private let colOffset: [Int]

    public var nodeCount: Int { nodeY.count }

    init(nx: Int, nz: Int, originX: Double, originZ: Double, colStart: [Int32], nodeY: [Float], nodeCol: [Int32], wet: [UInt8]) {
        self.nx = nx
        self.nz = nz
        self.originX = originX
        self.originZ = originZ
        self.colStart = colStart
        self.nodeY = nodeY
        self.nodeCol = nodeCol
        self.wet = wet
        edges = [UInt8](repeating: 0, count: nodeY.count)
        edgeLayers = [UInt16](repeating: 0, count: nodeY.count)
        coverLow = [UInt8](repeating: 0, count: nodeY.count)
        coverHigh = [UInt8](repeating: 0, count: nodeY.count)
        colOffset = (0 ..< 8).map { navDirX[$0] + navDirZ[$0] * nx }
    }

    @inline(__always) public func y(_ node: Int) -> Double { Double(nodeY[node]) }

    @inline(__always) public func nodeX(_ node: Int) -> Double {
        originX + (Double(Int(nodeCol[node]) % nx) + 0.5) * cell
    }

    @inline(__always) public func nodeZ(_ node: Int) -> Double {
        originZ + (Double(Int(nodeCol[node]) / nx) + 0.5) * cell
    }

    /// Node reached by walking from `node` in direction `d`, or -1.
    @inline(__always) public func neighbor(_ node: Int, _ d: Int) -> Int {
        if edges[node] & (1 << d) == 0 { return -1 }
        let col = Int(nodeCol[node]) + colOffset[d]
        return Int(colStart[col]) + Int((edgeLayers[node] >> (d * 2)) & 3)
    }

    /// Column index for a world position, or -1 outside the grid.
    public func columnAt(_ x: Double, _ z: Double) -> Int {
        let fx = ((x - originX) / cell).rounded(.down)
        let fz = ((z - originZ) / cell).rounded(.down)
        guard fx.isFinite, fz.isFinite, fx >= 0, fz >= 0, fx < Double(nx), fz < Double(nz) else { return -1 }
        return Int(fz) * nx + Int(fx)
    }

    /// Walkable node in the column under (x, z) whose floor is closest to `y`, or -1.
    public func nodeAt(_ x: Double, _ y: Double, _ z: Double) -> Int {
        let col = columnAt(x, z)
        return col < 0 ? -1 : nodeInColumn(col, y)
    }

    /// `nodeAt`, widening ring by ring when the column itself has no walkable node.
    public func nearestNode(_ x: Double, _ y: Double, _ z: Double, maxRing: Int = 6) -> Int {
        let fx = ((x - originX) / cell).rounded(.down)
        let fz = ((z - originZ) / cell).rounded(.down)
        guard fx.isFinite, fz.isFinite, abs(fx) < 1e9, abs(fz) < 1e9 else { return -1 }
        let cx = Int(fx), cz = Int(fz)
        for ring in 0 ... maxRing {
            var best = -1
            var bestScore = Double.infinity
            for iz in (cz - ring) ... (cz + ring) {
                if iz < 0 || iz >= nz { continue }
                let edgeRow = iz == cz - ring || iz == cz + ring
                let stride = edgeRow || ring == 0 ? 1 : ring * 2
                var ix = cx - ring
                while ix <= cx + ring {
                    defer { ix += stride }
                    if ix < 0 || ix >= nx { continue }
                    let node = nodeInColumn(iz * nx + ix, y)
                    if node < 0 { continue }
                    let dx = nodeX(node) - x
                    let dz = nodeZ(node) - z
                    let dy = (self.y(node) - y) * 2
                    let score = dx * dx + dz * dz + dy * dy
                    if score < bestScore {
                        bestScore = score
                        best = node
                    }
                }
            }
            if best >= 0 { return best }
        }
        return -1
    }

    /// true when a soldier can go straight from `a` to `b` along the grid line (every step a link).
    public func walkLine(_ a: Int, _ b: Int, dryOnly: Bool = false) -> Bool {
        if a < 0 || b < 0 { return false }
        if a == b { return true }
        let colA = Int(nodeCol[a]), colB = Int(nodeCol[b])
        var ix = colA % nx
        var iz = colA / nx
        let tx = colB % nx
        let tz = colB / nx
        let dx = abs(tx - ix)
        let dz = abs(tz - iz)
        let sx = tx > ix ? 1 : -1
        let sz = tz > iz ? 1 : -1
        var err = dx - dz
        var node = a
        while ix != tx || iz != tz {
            let e2 = err * 2
            var mx = 0, mz = 0
            if e2 > -dz {
                err -= dz
                mx = sx
            }
            if e2 < dx {
                err += dx
                mz = sz
            }
            node = neighbor(node, stepToDir[(mz + 1) * 3 + mx + 1])
            if node < 0 || (dryOnly && wet[node] != 0) { return false }
            ix += mx
            iz += mz
        }
        return node == b
    }

    func nodeInColumn(_ col: Int, _ y: Double) -> Int {
        var best = -1
        var bestDy = Double.infinity
        var n = Int(colStart[col])
        let end = Int(colStart[col + 1])
        while n < end {
            defer { n += 1 }
            if edges[n] == 0 { continue }
            let dy = abs(self.y(n) - y)
            if dy < bestDy {
                bestDy = dy
                best = n
            }
        }
        return best
    }

    /// Approximate memory use, as `gridBytes` in src/ai/debug.ts.
    public var bytes: Int { colStart.count * 4 + nodeCount * (4 + 4 + 1 + 2 + 1 + 1 + 1) }
}

/// The world queries the builder samples (a subset of `CollisionWorld`).
public protocol NavWorld {
    func raycast(origin: Vec3, direction: Vec3, maxDistance: Double) -> RayHit?
    func groundHeight(x: Double, z: Double, fromY: Double, maxDrop: Double) -> Double?
    func moveCapsule(position: Vec3, velocity: Vec3, dt: Double, radius: Double, height: Double) -> CapsuleMoveResult
}

extension CollisionWorld: NavWorld {}

private let maxHitsPerColumn = 8
private let probeLift = Nav.step + 0.02
private let probeTolerance = 0.03
private let maxEdgeRise = Nav.cell * 1.4
private let flatEpsilon = 0.03
private let edgeSamples = 4
private let stepTolerance = 0.025
private let coverReach = 1.0
private let coverReachDiagonal = 1.35

public enum NavGridBuilder {
    /// Samples the collision world into a grid (`buildNavGrid`, run to completion). `seeds` are points
    /// known to be reachable (spawns); cells no seed can walk to lose their links.
    public static func build(world: some NavWorld, bounds: Box3, seeds: [Vec3]) -> NavGrid {
        let cell = Nav.cell
        let nx = max(1, Int(((bounds.max.x - bounds.min.x) / cell).rounded(.down)))
        let nz = max(1, Int(((bounds.max.z - bounds.min.z) / cell).rounded(.down)))
        let cols = nx * nz
        let originX = bounds.min.x
        let originZ = bounds.min.z
        let top = bounds.max.y + 0.5
        let bottom = bounds.min.y - 0.5
        let down = Vec3(0, -1, 0)

        // 1. Floors: cast down through each column and keep every surface a capsule can stand on.
        var colStart = [Int32](repeating: 0, count: cols + 1)
        var heights: [Float] = []
        var water: [UInt8] = []
        heights.reserveCapacity(cols + cols >> 2 + 16)
        water.reserveCapacity(cols + cols >> 2 + 16)
        for iz in 0 ..< nz {
            let z = originZ + (Double(iz) + 0.5) * cell
            for ix in 0 ..< nx {
                let x = originX + (Double(ix) + 0.5) * cell
                colStart[iz * nx + ix] = Int32(heights.count)
                var fromY = top
                var ceiling = Double.infinity
                var layers = 0
                var i = 0
                while i < maxHitsPerColumn, layers < Nav.maxLayers, fromY > bottom {
                    i += 1
                    guard let hit = world.raycast(origin: Vec3(x, fromY, z), direction: down, maxDistance: fromY - bottom) else { break }
                    let y = hit.point.y
                    if hit.normal.y >= Nav.minNormalY, ceiling - y >= Nav.height, capsuleFits(world, x, y, z) {
                        water.append(hit.surface == .water ? 1 : 0)
                        heights.append(Float(y))
                        layers += 1
                    }
                    ceiling = y
                    fromY = y - 0.05
                }
            }
        }
        let count = heights.count
        colStart[cols] = Int32(count)

        var nodeCol = [Int32](repeating: 0, count: count)
        for col in 0 ..< cols {
            var n = Int(colStart[col])
            while n < Int(colStart[col + 1]) {
                nodeCol[n] = Int32(col)
                n += 1
            }
        }
        var grid = NavGrid(nx: nx, nz: nz, originX: originX, originZ: originZ, colStart: colStart, nodeY: heights,
                           nodeCol: nodeCol, wet: water)

        func link(_ a: Int, _ d: Int, _ b: Int) {
            let colA = Int(nodeCol[a]), colB = Int(nodeCol[b])
            grid.edges[a] |= UInt8(1 << d)
            grid.edgeLayers[a] = (grid.edgeLayers[a] & ~UInt16(3 << (d * 2))) | UInt16((b - Int(colStart[colB])) << (d * 2))
            let back = (d + 4) & 7
            grid.edges[b] |= UInt8(1 << back)
            grid.edgeLayers[b] = (grid.edgeLayers[b] & ~UInt16(3 << (back * 2))) | UInt16((a - Int(colStart[colA])) << (back * 2))
        }

        // 2. Straight links (east and south; `link` adds the way back).
        for n in 0 ..< count {
            let col = Int(nodeCol[n])
            let ix = col % nx
            let iz = col / nx
            let y = Double(heights[n])
            for d in stride(from: 0, through: 2, by: 2) {
                if d == 0 ? ix + 1 >= nx : iz + 1 >= nz { continue }
                let other = col + (d == 0 ? 1 : nx)
                var best = -1
                var bestDy = maxEdgeRise
                var m = Int(colStart[other])
                while m < Int(colStart[other + 1]) {
                    let dy = abs(Double(heights[m]) - y)
                    if dy < bestDy {
                        bestDy = dy
                        best = m
                    }
                    m += 1
                }
                if best < 0 { continue }
                if bestDy > flatEpsilon, !stepsWalkable(world, grid, n, best) { continue }
                link(n, d, best)
            }
        }

        // 3. Diagonal links, only where both ways round the corner exist and meet.
        for n in 0 ..< count {
            for d in stride(from: 1, through: 3, by: 2) {
                let side = d == 1 ? 0 : 4
                let viaSide = grid.neighbor(n, side)
                let viaSouth = grid.neighbor(n, 2)
                if viaSide < 0 || viaSouth < 0 { continue }
                let corner = grid.neighbor(viaSide, 2)
                if corner < 0 || corner != grid.neighbor(viaSouth, side) { continue }
                link(n, d, corner)
            }
        }

        // 4. Keep what can be reached from the seeds.
        if !seeds.isEmpty {
            var reached = [UInt8](repeating: 0, count: count)
            var stack: [Int] = []
            stack.reserveCapacity(count)
            for seed in seeds {
                let start = grid.nearestNode(seed.x, seed.y, seed.z)
                if start < 0 || reached[start] != 0 { continue }
                reached[start] = 1
                stack.append(start)
            }
            while let n = stack.popLast() {
                for d in 0 ..< 8 {
                    let m = grid.neighbor(n, d)
                    if m < 0 || reached[m] != 0 { continue }
                    reached[m] = 1
                    stack.append(m)
                }
            }
            for n in 0 ..< count where reached[n] == 0 { grid.edges[n] = 0 }
        }

        // 5. Cover: which directions have something solid at crouch and standing height.
        let directions = (0 ..< 8).map { Vec3(Double(navDirX[$0]), 0, Double(navDirZ[$0])).normalized() }
        for n in 0 ..< count {
            let mask = grid.edges[n]
            if mask == 0 || mask == 0xFF { continue }
            let x = grid.nodeX(n)
            let z = grid.nodeZ(n)
            let y = grid.y(n)
            for d in 0 ..< 8 {
                let reach = d & 1 == 1 ? coverReachDiagonal : coverReach
                if world.raycast(origin: Vec3(x, y + Nav.coverLowHeight, z), direction: directions[d], maxDistance: reach) == nil { continue }
                grid.coverLow[n] |= UInt8(1 << d)
                if world.raycast(origin: Vec3(x, y + Nav.coverHighHeight, z), direction: directions[d], maxDistance: reach) != nil {
                    grid.coverHigh[n] |= UInt8(1 << d)
                }
            }
        }
        return grid
    }

    /// true when the capsule stands at (x, y, z) without touching anything but the floor.
    private static func capsuleFits(_ world: some NavWorld, _ x: Double, _ y: Double, _ z: Double) -> Bool {
        let origin = Vec3(x, y + probeLift, z)
        let moved = world.moveCapsule(position: origin, velocity: .zero, dt: 0, radius: Nav.radius, height: Nav.height - probeLift).position
        return moved.distanceToSquared(origin) < probeTolerance * probeTolerance
    }

    /// Samples the floor between two neighbouring cells; no single rise or drop may exceed a step.
    private static func stepsWalkable(_ world: some NavWorld, _ grid: NavGrid, _ a: Int, _ b: Int) -> Bool {
        let ax = grid.nodeX(a), az = grid.nodeZ(a)
        let bx = grid.nodeX(b), bz = grid.nodeZ(b)
        var previous = grid.y(a)
        for i in 1 ... edgeSamples {
            let t = Double(i) / Double(edgeSamples)
            let height: Double? = i == edgeSamples
                ? grid.y(b)
                : world.groundHeight(x: ax + (bx - ax) * t, z: az + (bz - az) * t, fromY: previous + 0.9, maxDrop: 2)
            guard let height, abs(height - previous) <= Nav.step + stepTolerance else { return false }
            previous = height
        }
        return true
    }
}
