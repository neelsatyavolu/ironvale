import Foundation
import Synchronization

/// GPU execution time per frame, filled from command-buffer completion handlers (any thread).
/// Written as `frame,gpu_ms` CSV next to the frame-time log.
public final class GPUFrameLog: Sendable {
    private let samples = Mutex<[(frame: Int, gpuMs: Double)]>([])

    public init() {}

    public func record(frame: Int, gpuStart: CFTimeInterval, gpuEnd: CFTimeInterval) {
        guard gpuEnd > gpuStart else { return }
        samples.withLock { $0.append((frame, (gpuEnd - gpuStart) * 1000)) }
    }

    public var csv: String {
        let rows = samples.withLock { $0.sorted { $0.frame < $1.frame } }
        return (["frame,gpu_ms"] + rows.map { "\($0.frame),\(String(format: "%.4f", $0.gpuMs))" }).joined(separator: "\n") + "\n"
    }

    public func write(to url: URL) throws {
        try Data(csv.utf8).write(to: url, options: .atomic)
    }
}
