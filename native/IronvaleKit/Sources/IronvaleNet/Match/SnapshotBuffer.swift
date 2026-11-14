// Ported from src/net/interp.ts at commit cbe0add.
//
// Snapshot buffer for showing another player or a bot a little in the past. Snapshots arrive at
// 12 to 30 a second, late and sometimes out of order. The buffer keeps them sorted by time; `sample`
// blends the two around the asked time, and when the newest one is already behind, carries on along
// its velocity for a short, capped while.
import Foundation

public struct InterpPose: Sendable, Equatable {
    public var x = 0.0, y = 0.0, z = 0.0
    public var vx = 0.0, vy = 0.0, vz = 0.0
    public var yaw = 0.0, pitch = 0.0
    public init() {}
    public init(x: Double, y: Double, z: Double, vx: Double, vy: Double, vz: Double, yaw: Double, pitch: Double) {
        (self.x, self.y, self.z, self.vx, self.vy, self.vz, self.yaw, self.pitch) = (x, y, z, vx, vy, vz, yaw, pitch)
    }
}

public struct InterpSnapshot: Sendable, Equatable {
    /// Receiver's clock, milliseconds.
    public var time: Double
    /// Changes when the body teleports (a respawn): poses are never blended across a change.
    public var epoch: Int
    public var pose: InterpPose
    public init(time: Double, epoch: Int, pose: InterpPose) {
        self.time = time
        self.epoch = epoch
        self.pose = pose
    }
}

public enum SampleMode: String, Sendable { case empty, held, interpolated, extrapolated, stalled }

/// Blend two angles the short way round (`lerpAngle`).
public func lerpAngle(_ from: Double, _ to: Double, _ t: Double) -> Double {
    let turn = Double.pi * 2
    // JS `%` is truncated: fmod.
    let difference = fmod(fmod(to - from + Double.pi, turn) + turn, turn) - Double.pi
    return from + difference * t
}

public struct SnapshotBuffer: Sendable {
    public static let defaultCapacity = 32
    public static let maxExtrapolationMs: Double = 250

    /// Oldest first.
    private var items: [InterpSnapshot] = []
    private let capacity: Int
    private let maxExtrapolationMs: Double
    private let deriveVelocity: Bool

    public init(capacity: Int = SnapshotBuffer.defaultCapacity, maxExtrapolationMs: Double = SnapshotBuffer.maxExtrapolationMs,
                deriveVelocity: Bool = false) {
        self.capacity = max(2, capacity)
        self.maxExtrapolationMs = maxExtrapolationMs
        self.deriveVelocity = deriveVelocity
    }

    public var size: Int { items.count }

    /// Time of the newest snapshot, or -infinity when empty.
    public var newestTime: Double { items.last?.time ?? -.infinity }

    /// Returns false when the snapshot was refused: not finite, a duplicate, or older than the kept window.
    @discardableResult
    public mutating func push(_ snapshot: InterpSnapshot) -> Bool {
        let p = snapshot.pose
        guard [snapshot.time, p.x, p.y, p.z, p.vx, p.vy, p.vz, p.yaw, p.pitch].allSatisfy(\.isFinite) else { return false }
        var index = items.count
        while index > 0, items[index - 1].time > snapshot.time { index -= 1 }
        if index > 0, items[index - 1].time == snapshot.time { return false }
        if index == 0, items.count >= capacity { return false }
        let entry = deriveVelocity ? Self.withVelocity(snapshot, previous: index > 0 ? items[index - 1] : nil) : snapshot
        items.insert(entry, at: index)
        if items.count > capacity { items.removeFirst(items.count - capacity) }
        return true
    }

    /// The pose at `time` and how it was found.
    public func sample(_ time: Double, into out: inout InterpPose) -> SampleMode {
        guard let newest = items.last else { return .empty }
        if time >= newest.time {
            let ahead = time - newest.time
            let seconds = min(ahead, maxExtrapolationMs) / 1000
            out = newest.pose
            out.x += newest.pose.vx * seconds
            out.y += newest.pose.vy * seconds
            out.z += newest.pose.vz * seconds
            if ahead <= maxExtrapolationMs { return ahead == 0 ? .interpolated : .extrapolated }
            out.vx = 0
            out.vy = 0
            out.vz = 0
            return .stalled
        }
        let oldest = items[0]
        if time <= oldest.time {
            out = oldest.pose
            return .held
        }
        var after = items.count - 1
        while after > 0, items[after - 1].time > time { after -= 1 }
        let a = items[after - 1], b = items[after]
        if a.epoch != b.epoch {
            out = a.pose
            return .held
        }
        let t = (time - a.time) / (b.time - a.time)
        let pa = a.pose, pb = b.pose
        out.x = pa.x + (pb.x - pa.x) * t
        out.y = pa.y + (pb.y - pa.y) * t
        out.z = pa.z + (pb.z - pa.z) * t
        out.vx = pa.vx + (pb.vx - pa.vx) * t
        out.vy = pa.vy + (pb.vy - pa.vy) * t
        out.vz = pa.vz + (pb.vz - pa.vz) * t
        out.yaw = lerpAngle(pa.yaw, pb.yaw, t)
        out.pitch = pa.pitch + (pb.pitch - pa.pitch) * t
        return .interpolated
    }

    public mutating func reset() { items = [] }

    private static func withVelocity(_ snapshot: InterpSnapshot, previous: InterpSnapshot?) -> InterpSnapshot {
        guard let previous, previous.epoch == snapshot.epoch else { return snapshot }
        let seconds = (snapshot.time - previous.time) / 1000
        if seconds <= 0 { return snapshot }
        var next = snapshot
        next.pose.vx = (snapshot.pose.x - previous.pose.x) / seconds
        next.pose.vy = (snapshot.pose.y - previous.pose.y) / seconds
        next.pose.vz = (snapshot.pose.z - previous.pose.z) / seconds
        return next
    }
}
