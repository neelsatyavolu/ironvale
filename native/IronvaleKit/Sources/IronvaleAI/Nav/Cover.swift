// Ported from src/ai/cover.ts at commit cbe0add.
import Foundation
import IronvaleCore

/// 0: exposed, 1: hides a crouching soldier, 2: hides a standing one.
public typealias CoverKind = Int

/// Which of the grid's eight directions a bearing falls in (`Math.round`, halves toward +infinity).
public func directionToward(_ dx: Double, _ dz: Double) -> Int {
    Int(JS.round(atan2(dz, dx) / (Double.pi / 4))) & 7
}

/// How well the cell at `node` is protected from a threat at (threatX, threatZ).
public func coverAgainst(_ grid: NavGrid, _ node: Int, _ threatX: Double, _ threatZ: Double) -> CoverKind {
    let d = directionToward(threatX - grid.nodeX(node), threatZ - grid.nodeZ(node))
    let left = 1 << ((d + 7) & 7)
    let right = 1 << ((d + 1) & 7)
    let bit = 1 << d
    let low = Int(grid.coverLow[node])
    if low & bit == 0, (low & left) * (low & right) == 0 { return 0 }
    let high = Int(grid.coverHigh[node])
    return high & bit != 0 || (high & left) * (high & right) != 0 ? 2 : 1
}

public struct CoverQuery {
    public var x = 0.0, y = 0.0, z = 0.0
    public var threatX = 0.0, threatZ = 0.0
    public var radius = 0.0
    public var minThreatDistance: Double?
    public var idealThreatDistance: Double?
    public var taken: [Int]?
    public var exclude: Int?
    public var skip: [Int]?
    public init() {}
}

private let sameFloor = 2.5
private let rangeWeight = 0.6
private let standingCoverBonus = 0.5
private let spacing = 1.5

/// Best cover cell near the soldier against the threat, or -1. Reads only precomputed masks.
public func findCover(_ grid: NavGrid, _ query: CoverQuery) -> Int {
    let cell = grid.cell
    let reach = Int((query.radius / cell).rounded(.up))
    let cx = Int(((query.x - grid.originX) / cell).rounded(.down))
    let cz = Int(((query.z - grid.originZ) / cell).rounded(.down))
    let minThreat = query.minThreatDistance ?? 0
    var best = -1
    var bestScore = Double.infinity
    let zLow = max(0, cz - reach), zHigh = min(grid.nz - 1, cz + reach)
    let xLow = max(0, cx - reach), xHigh = min(grid.nx - 1, cx + reach)
    if zLow > zHigh || xLow > xHigh { return -1 }
    for iz in zLow ... zHigh {
        for ix in xLow ... xHigh {
            let col = iz * grid.nx + ix
            var node = Int(grid.colStart[col])
            let end = Int(grid.colStart[col + 1])
            while node < end {
                defer { node += 1 }
                if grid.coverLow[node] == 0 || grid.edges[node] == 0 || grid.wet[node] != 0 || node == query.exclude { continue }
                if abs(grid.y(node) - query.y) > sameFloor { continue }
                let x = grid.nodeX(node)
                let z = grid.nodeZ(node)
                let travel = hypot(x - query.x, z - query.z)
                if travel > query.radius { continue }
                let threatDistance = hypot(x - query.threatX, z - query.threatZ)
                if threatDistance < minThreat { continue }
                let kind = coverAgainst(grid, node, query.threatX, query.threatZ)
                if kind == 0 { continue }
                var score = travel - (kind == 2 ? standingCoverBonus : 0)
                if let ideal = query.idealThreatDistance { score += abs(threatDistance - ideal) * rangeWeight }
                if score >= bestScore { continue }
                if let skip = query.skip, skip.contains(node) { continue }
                if let taken = query.taken, isCrowded(grid, x, z, taken) { continue }
                bestScore = score
                best = node
            }
        }
    }
    return best
}

private func isCrowded(_ grid: NavGrid, _ x: Double, _ z: Double, _ taken: [Int]) -> Bool {
    for other in taken where other >= 0 {
        if hypot(grid.nodeX(other) - x, grid.nodeZ(other) - z) < spacing { return true }
    }
    return false
}
