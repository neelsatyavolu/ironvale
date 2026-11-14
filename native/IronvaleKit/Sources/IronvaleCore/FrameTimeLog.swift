import Foundation

/// Records per-frame timings and renders them as CSV (`frame,timestamp_s,dt_ms`).
/// Value type: `recording(_:)` returns a new log rather than mutating in place.
public struct FrameTimeLog: Sendable, Equatable {
    public struct Sample: Sendable, Equatable {
        public let frame: Int
        public let timestamp: Double
        public let dtMs: Double
    }

    public static let header = "frame,timestamp_s,dt_ms"

    public let samples: [Sample]

    public init(samples: [Sample] = []) {
        self.samples = samples
    }

    /// Appends one frame whose presentation-target time is `timestamp` (seconds).
    /// The first frame has no predecessor, so its `dt_ms` is 0.
    public func recording(timestamp: Double) -> FrameTimeLog {
        let dtMs = samples.last.map { (timestamp - $0.timestamp) * 1000 } ?? 0
        let sample = Sample(frame: samples.count, timestamp: timestamp, dtMs: dtMs)
        return FrameTimeLog(samples: samples + [sample])
    }

    public var csv: String {
        let rows = samples.map { s in
            "\(s.frame),\(String(format: "%.6f", s.timestamp)),\(String(format: "%.3f", s.dtMs))"
        }
        return ([Self.header] + rows).joined(separator: "\n") + "\n"
    }

    public func write(to url: URL) throws {
        try Data(csv.utf8).write(to: url, options: .atomic)
    }
}
