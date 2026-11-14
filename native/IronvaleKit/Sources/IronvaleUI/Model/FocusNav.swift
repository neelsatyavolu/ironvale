// Ported from src/ui/focus-nav.ts (pickNeighbour) at cbe0add.
import CoreGraphics

public enum NavDirection: Sendable { case up, down, left, right }

public enum FocusNav {
    /// How much being off to the side counts against a candidate that is otherwise in line.
    static let sideWeight = 0.3
    static let epsilon = 0.5

    /// Index of the box to move to from `current` in `direction`, or -1 when there is none. Boxes that overlap
    /// the current one across the direction of travel win over ones that are merely closer.
    public static func pickNeighbour(_ boxes: [CGRect], current: Int, direction: NavDirection) -> Int {
        guard boxes.indices.contains(current) else { return -1 }
        let from = boxes[current]
        let horizontal = direction == .left || direction == .right
        let forward = direction == .right || direction == .down
        func main(_ box: CGRect) -> (Double, Double) { horizontal ? (box.minX, box.width) : (box.minY, box.height) }
        func side(_ box: CGRect) -> (Double, Double) { horizontal ? (box.minY, box.height) : (box.minX, box.width) }
        let (fromMain, fromMainSize) = main(from)
        let (fromSide, fromSideSize) = side(from)
        let fromCentre = fromMain + fromMainSize / 2

        var best = -1
        var bestInLine = false
        var bestScore = Double.infinity
        for (index, box) in boxes.enumerated() where index != current {
            let (boxMain, boxMainSize) = main(box)
            let centre = boxMain + boxMainSize / 2
            if forward ? centre <= fromCentre + epsilon : centre >= fromCentre - epsilon { continue }
            let gap = max(0, forward ? boxMain - (fromMain + fromMainSize) : fromMain - (boxMain + boxMainSize))
            let (boxSide, boxSideSize) = side(box)
            let inLine = boxSide < fromSide + fromSideSize - epsilon && boxSide + boxSideSize > fromSide + epsilon
            let offset = abs(boxSide + boxSideSize / 2 - (fromSide + fromSideSize / 2))
            let score = gap + offset * sideWeight
            if (inLine && !bestInLine) || (inLine == bestInLine && score < bestScore) {
                best = index
                bestInLine = inLine
                bestScore = score
            }
        }
        return best
    }
}
