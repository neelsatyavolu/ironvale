// Ported from src/characters/lod.ts at commit f14381f.
public enum PoseLOD {
    /// Frames between skeleton updates.
    public static func interval(visible: Bool, distance: Double, tables: CharacterTables = .shared) -> Int {
        let lod = tables.lod
        if !visible { return lod.hiddenInterval }
        if distance > lod.farDistance { return lod.farInterval }
        if distance > lod.midDistance { return lod.midInterval }
        return 1
    }

    /// true on the frames a soldier in `slot` should pose; slots spread the work across frames.
    public static func shouldPose(frame: Int, slot: Int, interval: Int) -> Bool {
        interval <= 1 || (frame + slot) % interval == 0
    }
}

/// Whether the main camera drew the soldier recently. The renderer's frustum cull calls `seen`.
public struct VisibilityTracker: Sendable {
    public private(set) var distance = 0.0
    private var sinceSeen = 0
    private let hiddenAfter: Int

    public init(tables: CharacterTables = .shared) { hiddenAfter = tables.lod.hiddenAfterFrames }

    public var visible: Bool { sinceSeen <= hiddenAfter }

    public mutating func seen(distance: Double) {
        sinceSeen = 0
        self.distance = distance
    }

    public mutating func tick() { sinceSeen += 1 }
}
