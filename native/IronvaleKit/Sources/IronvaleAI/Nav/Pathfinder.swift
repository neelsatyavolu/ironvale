// Ported from src/ai/pathfinder.ts at commit cbe0add. Scores and path points are Float32, as the
// web's Float32Arrays store them.
import Foundation

/// Most corner points a smoothed path keeps. Longer routes end early and are marked partial.
public let pathMaxPoints = 48
private let maxRaw = 1024
private let maxExpansions = 40000
private let smoothLookahead = 64
private let startCost = 8
private let avoidSmoothFraction = 0.75
private let sqrt2 = 2.0.squareRoot()
private let wetCost = 6.0

public enum PathStatus: Sendable { case idle, queued, ready, failed }

/// Area a route should swing wide of (flanking).
public struct PathAvoid: Sendable {
    public var x, z, radius, cost: Double
    public init(x: Double, z: Double, radius: Double, cost: Double) {
        self.x = x
        self.z = z
        self.radius = radius
        self.cost = cost
    }
}

/// A reusable path request and its result; each soldier owns one.
public final class PathHandle {
    public internal(set) var status = PathStatus.idle
    /// x, y, z corner points from the first turn to the goal (the start left out).
    public internal(set) var points = [Float](repeating: 0, count: pathMaxPoints * 3)
    public internal(set) var count = 0
    public internal(set) var partial = false
    var startX = 0.0, startY = 0.0, startZ = 0.0
    var goalX = 0.0, goalY = 0.0, goalZ = 0.0
    var avoidX = 0.0, avoidZ = 0.0, avoidRadius = 0.0, avoidCost = 0.0
    var waiting = false

    public init() {}

    public func point(_ i: Int) -> (x: Double, y: Double, z: Double) {
        (Double(points[i * 3]), Double(points[i * 3 + 1]), Double(points[i * 3 + 2]))
    }

    /// A one-point path straight to a spot (`BotBody.moveDirect`).
    func setDirect(_ x: Double, _ y: Double, _ z: Double) {
        points[0] = Float(x)
        points[1] = Float(y)
        points[2] = Float(z)
        count = 1
        partial = false
        status = .ready
    }
}

/// A* over a `NavGrid` that can stop and continue.
public final class Pathfinder {
    public enum State: Sendable { case idle, running, found, failed }
    public private(set) var state = State.idle
    private let grid: NavGrid
    private var g: [Float]
    private var parent: [Int32]
    private var seen: [UInt32]
    private var closed: [UInt32]
    private var heapNode = [Int32](repeating: 0, count: 1024)
    private var heapF = [Float](repeating: 0, count: 1024)
    private var heapSize = 0
    private var searchId: UInt32 = 0
    private var start = -1, goal = -1
    private var goalX = 0.0, goalY = 0.0, goalZ = 0.0
    private var best = -1
    private var bestH = Double.infinity
    private var expansions = 0
    private var avoidX = 0.0, avoidZ = 0.0, avoidRadius = 0.0, avoidCost = 0.0
    private var raw = [Int32](repeating: 0, count: maxRaw)

    public init(grid: NavGrid) {
        self.grid = grid
        let n = grid.nodeCount
        g = [Float](repeating: 0, count: n)
        parent = [Int32](repeating: 0, count: n)
        seen = [UInt32](repeating: 0, count: n)
        closed = [UInt32](repeating: 0, count: n)
    }

    public func begin(start: Int, goal: Int, handle: PathHandle) {
        searchId &+= 1
        self.start = start
        self.goal = goal
        goalX = grid.nodeX(goal)
        goalY = grid.y(goal)
        goalZ = grid.nodeZ(goal)
        avoidX = handle.avoidX
        avoidZ = handle.avoidZ
        avoidRadius = handle.avoidRadius
        avoidCost = handle.avoidCost
        heapSize = 0
        expansions = 0
        best = start
        bestH = heuristic(start)
        g[start] = 0
        parent[start] = -1
        seen[start] = searchId
        push(start, bestH)
        state = .running
    }

    /// Expand up to `budget` nodes. Returns how many were expanded.
    @discardableResult
    public func step(_ budget: Int) -> Int {
        let id = searchId
        let cell = grid.cell
        var used = 0
        while state == .running, used < budget {
            if heapSize == 0 || expansions >= maxExpansions {
                state = best == start ? .failed : .found
                break
            }
            let node = pop()
            if closed[node] == id { continue }
            closed[node] = id
            used += 1
            expansions += 1
            if node == goal {
                best = node
                state = .found
                break
            }
            let h = heuristic(node)
            if h < bestH {
                bestH = h
                best = node
            }
            let base = Double(g[node])
            let y = grid.y(node)
            for d in 0 ..< 8 {
                let next = grid.neighbor(node, d)
                if next < 0 || closed[next] == id { continue }
                var cost = (d & 1 == 1 ? sqrt2 : 1) * cell + abs(grid.y(next) - y)
                if grid.wet[next] != 0 { cost += wetCost * cell }
                if avoidRadius > 0 {
                    let distance = hypot(grid.nodeX(next) - avoidX, grid.nodeZ(next) - avoidZ)
                    if distance < avoidRadius { cost += avoidCost * cell * (1 - distance / avoidRadius) }
                }
                let total = base + cost
                if seen[next] == id, total >= Double(g[next]) { continue }
                seen[next] = id
                g[next] = Float(total)
                parent[next] = Int32(node)
                push(next, total + heuristic(next))
            }
        }
        return used
    }

    /// Write the smoothed route into `handle`. Call once `state` is `.found`.
    public func writePath(_ handle: PathHandle) {
        let reachedGoal = best == goal
        var length = 0
        var n = best
        while n >= 0 {
            length += 1
            n = Int(parent[n])
        }
        var skip = max(0, length - maxRaw)
        let kept = length - skip
        var end = best
        while skip > 0 {
            end = Int(parent[end])
            skip -= 1
        }
        var index = kept - 1
        n = end
        while n >= 0 {
            raw[index] = Int32(n)
            index -= 1
            n = Int(parent[n])
        }

        handle.count = 0
        handle.partial = !reachedGoal || kept < length
        var anchor = 0
        while anchor < kept - 1 {
            var next = anchor + 1
            var span = min(kept - 1 - anchor, smoothLookahead)
            while span >= 2 {
                let from = Int(raw[anchor])
                let to = Int(raw[anchor + span])
                if shortcutAllowed(from, to), grid.walkLine(from, to, dryOnly: grid.wet[from] == 0 && grid.wet[to] == 0) {
                    next = anchor + span
                    break
                }
                span >>= 1
            }
            if handle.count == pathMaxPoints {
                handle.partial = true
                break
            }
            let node = Int(raw[next])
            let at = handle.count * 3
            handle.points[at] = Float(grid.nodeX(node))
            handle.points[at + 1] = grid.nodeY[node]
            handle.points[at + 2] = Float(grid.nodeZ(node))
            handle.count += 1
            anchor = next
        }
        // Finish on the exact spot asked for when it lies inside the goal cell.
        if !handle.partial, handle.count > 0 {
            let half = grid.cell / 2 + 1e-4
            if abs(handle.goalX - goalX) <= half, abs(handle.goalZ - goalZ) <= half {
                let at = (handle.count - 1) * 3
                handle.points[at] = Float(handle.goalX)
                handle.points[at + 2] = Float(handle.goalZ)
            }
        }
        state = .idle
    }

    public func abort() { state = .idle }

    private func shortcutAllowed(_ a: Int, _ b: Int) -> Bool {
        if avoidRadius <= 0 { return true }
        let ax = grid.nodeX(a) - avoidX, az = grid.nodeZ(a) - avoidZ
        let bx = grid.nodeX(b) - avoidX, bz = grid.nodeZ(b) - avoidZ
        let dx = bx - ax, dz = bz - az
        let lengthSq = dx * dx + dz * dz
        let t = lengthSq > 0 ? min(1, max(0, -(ax * dx + az * dz) / lengthSq)) : 0
        let closest = hypot(ax + dx * t, az + dz * t)
        let ends = min(hypot(ax, az), hypot(bx, bz))
        return closest >= min(avoidRadius * avoidSmoothFraction, ends - 0.01)
    }

    /// Octile distance.
    private func heuristic(_ node: Int) -> Double {
        let dx = abs(grid.nodeX(node) - goalX)
        let dz = abs(grid.nodeZ(node) - goalZ)
        let dy = abs(grid.y(node) - goalY)
        return max(dx, dz) + (sqrt2 - 1) * min(dx, dz) + dy
    }

    private func push(_ node: Int, _ score: Double) {
        let f = Float(score)
        if heapSize == heapNode.count {
            heapNode += [Int32](repeating: 0, count: heapSize)
            heapF += [Float](repeating: 0, count: heapSize)
        }
        var i = heapSize
        heapSize += 1
        while i > 0 {
            let up = (i - 1) >> 1
            if Double(heapF[up]) <= score { break }
            heapNode[i] = heapNode[up]
            heapF[i] = heapF[up]
            i = up
        }
        heapNode[i] = Int32(node)
        heapF[i] = f
    }

    private func pop() -> Int {
        let top = Int(heapNode[0])
        heapSize -= 1
        let size = heapSize
        if size > 0 {
            let node = heapNode[size]
            let f = heapF[size]
            var i = 0
            while true {
                var child = i * 2 + 1
                if child >= size { break }
                if child + 1 < size, heapF[child + 1] < heapF[child] { child += 1 }
                if heapF[child] >= f { break }
                heapNode[i] = heapNode[child]
                heapF[i] = heapF[child]
                i = child
            }
            heapNode[i] = node
            heapF[i] = f
        }
        return top
    }
}

/// Serves path requests first come, first served, within a per-frame budget of node expansions.
public final class PathQueue {
    private let grid: NavGrid
    private let finder: Pathfinder
    private var waiting: [PathHandle] = []
    private var current: PathHandle?

    public init(grid: NavGrid) {
        self.grid = grid
        finder = Pathfinder(grid: grid)
    }

    public var pending: Int { waiting.count + (current == nil ? 0 : 1) }

    public func request(_ handle: PathHandle, start: (Double, Double, Double), goal: (Double, Double, Double), avoid: PathAvoid? = nil) {
        (handle.startX, handle.startY, handle.startZ) = start
        (handle.goalX, handle.goalY, handle.goalZ) = goal
        handle.avoidX = avoid?.x ?? 0
        handle.avoidZ = avoid?.z ?? 0
        handle.avoidRadius = avoid?.radius ?? 0
        handle.avoidCost = avoid?.cost ?? 0
        handle.count = 0
        handle.partial = false
        if current === handle {
            finder.abort()
            current = nil
        }
        if handle.status != .queued { waiting.append(handle) }
        handle.status = .queued
    }

    public func cancel(_ handle: PathHandle) {
        if current === handle {
            finder.abort()
            current = nil
        } else if let index = waiting.firstIndex(where: { $0 === handle }) {
            waiting.remove(at: index)
        }
        handle.status = .idle
        handle.count = 0
    }

    /// Work through the queue. Returns the budget spent.
    @discardableResult
    public func update(_ budget: Int) -> Int {
        var used = 0
        while used < budget {
            if current == nil {
                if used + startCost > budget, used > 0 { break }
                guard !waiting.isEmpty else { break }
                let next = waiting.removeFirst()
                used += startCost
                let start = grid.nearestNode(next.startX, next.startY, next.startZ)
                let goal = grid.nearestNode(next.goalX, next.goalY, next.goalZ)
                if start < 0 || goal < 0 {
                    next.status = .failed
                    continue
                }
                current = next
                finder.begin(start: start, goal: goal, handle: next)
            }
            used += finder.step(max(0, budget - used))
            if finder.state == .running { break }
            guard let handle = current else { break }
            if finder.state == .found {
                finder.writePath(handle)
                handle.status = .ready
            } else {
                finder.abort()
                handle.status = .failed
            }
            current = nil
        }
        return min(used, budget)
    }

    public func clear() {
        for handle in waiting { handle.status = .idle }
        waiting.removeAll()
        current?.status = .idle
        current = nil
        finder.abort()
    }
}
