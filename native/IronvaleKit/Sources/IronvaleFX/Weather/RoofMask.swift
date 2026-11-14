// Ported from src/fx/roof-mask.ts at commit a487033.
import Darwin

/// A square grid of "highest surface" heights that follows the player, stored at wrapped positions
/// so the GPU samples it as a repeating texture with world coordinates.
public final class RoofMask {
    /// Height reported for a cell that has not been probed yet. High enough that rain stays hidden.
    public static let staleHeight = 1e4

    public let size: Int
    public let cell: Double
    /// Row-major heights, `size * size`.
    public private(set) var heights: [Float]
    /// Increases whenever `heights` changes.
    public private(set) var version = 0
    private var valid: [UInt8]
    private var columnCell: [Int]
    private var rowCell: [Int]
    public private(set) var stale: Int
    private var cursor = 0
    private var centred = false
    private var minX = 0
    private var minZ = 0

    public init(size: Int, cell: Double) {
        precondition(size >= 2 && size % 2 == 0, "RoofMask size must be even, got \(size)")
        precondition(cell > 0, "RoofMask cell must be positive, got \(cell)")
        self.size = size
        self.cell = cell
        heights = [Float](repeating: Float(Self.staleHeight), count: size * size)
        valid = [UInt8](repeating: 0, count: size * size)
        columnCell = [Int](repeating: 0, count: size)
        rowCell = [Int](repeating: 0, count: size)
        stale = size * size
    }

    /// Move the window so it is centred on a world position.
    public func setCentre(_ x: Double, _ z: Double) {
        let half = size / 2
        let minX = Int((x / cell).rounded(.down)) - half
        let minZ = Int((z / cell).rounded(.down)) - half
        if centred, minX == self.minX, minZ == self.minZ { return }
        for i in 0..<size {
            let ix = minX + i
            let column = wrap(ix)
            if !centred || columnCell[column] != ix {
                columnCell[column] = ix
                invalidate(column, size, size)
            }
            let iz = minZ + i
            let row = wrap(iz)
            if !centred || rowCell[row] != iz {
                rowCell[row] = iz
                invalidate(row * size, 1, size)
            }
        }
        self.minX = minX
        self.minZ = minZ
        centred = true
    }

    /// Probe up to `budget` stale cells. Returns how many were updated.
    @discardableResult
    public func refresh(_ probe: (Double, Double) -> Double, budget: Int) -> Int {
        guard centred else { return 0 }
        let total = size * size
        var done = 0
        var scanned = 0
        while scanned < total, stale > 0, done < budget {
            scanned += 1
            let index = cursor
            cursor = (cursor + 1) % total
            if valid[index] != 0 { continue }
            let column = index % size
            let row = (index - column) / size
            let x = (Double(columnCell[column]) + 0.5) * cell
            let z = (Double(rowCell[row]) + 0.5) * cell
            heights[index] = Float(probe(x, z))
            valid[index] = 1
            stale -= 1
            done += 1
        }
        if done > 0 { version += 1 }
        return done
    }

    /// Highest surface over a point, or `staleHeight` outside the window or before the cell is probed.
    public func heightAt(_ x: Double, _ z: Double) -> Double {
        guard centred else { return Self.staleHeight }
        let ix = Int((x / cell).rounded(.down))
        let iz = Int((z / cell).rounded(.down))
        if ix < minX || ix >= minX + size || iz < minZ || iz >= minZ + size { return Self.staleHeight }
        return Double(heights[wrap(iz) * size + wrap(ix)])
    }

    private func wrap(_ index: Int) -> Int { ((index % size) + size) % size }

    private func invalidate(_ start: Int, _ step: Int, _ count: Int) {
        for i in 0..<count {
            let index = start + i * step
            if valid[index] != 0 {
                valid[index] = 0
                stale += 1
            }
            heights[index] = Float(Self.staleHeight)
        }
        version += 1
    }
}
