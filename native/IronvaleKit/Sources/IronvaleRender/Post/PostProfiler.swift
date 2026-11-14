// Development aid: per-pass GPU times of the M9 post chain, from stage-boundary timestamp counters
// (each pass from the previous pass's last fragment to its own).
// Enabled with IV_POST_PROFILE=1; every 240 frames it prints each pass's mean milliseconds to stderr.
// MetalFX encodes its own work, so the temporal pass is not listed; it is the frame's GPU time minus
// the scene and the listed passes.
import Foundation
import Metal
import Synchronization

@MainActor
final class PostProfiler {
    static let enabled = ProcessInfo.processInfo.environment["IV_POST_PROFILE"] == "1"
    private static let samplesPerFrame = 128
    private static let reportEvery = 240

    private let buffers: [any MTLCounterSampleBuffer]
    private var frame = 0
    private var labels: [String] = []
    private final class Totals: Sendable {
        let state = Mutex<(sums: [String: Double], frames: Int, order: [String])>(([:], 0, []))
    }
    private let totals = Totals()
    private let nanosecondsPerTick: Double

    init?(device: any MTLDevice) {
        guard Self.enabled, device.supportsCounterSampling(.atStageBoundary),
              let set = device.counterSets?.first(where: { $0.name == MTLCommonCounterSet.timestamp.rawValue }) else { return nil }
        let d = MTLCounterSampleBufferDescriptor()
        d.counterSet = set
        d.sampleCount = Self.samplesPerFrame
        d.storageMode = .shared
        guard let buffers = try? (0..<3).map({ _ in try device.makeCounterSampleBuffer(descriptor: d) }) else { return nil }
        self.buffers = buffers
        // Calibrate GPU ticks against the CPU clock (nanoseconds) over a short interval.
        let (cpu0, gpu0) = device.sampleTimestamps()
        usleep(20_000)
        let (cpu1, gpu1) = device.sampleTimestamps()
        nanosecondsPerTick = gpu1 > gpu0 ? Double(cpu1 - cpu0) / Double(gpu1 - gpu0) : 1
    }

    /// Times the render pass `pass` under `label` (one vertex-start and one fragment-end sample).
    func attach(_ pass: MTLRenderPassDescriptor, label: String) {
        guard labels.count * 2 + 2 <= Self.samplesPerFrame else { return }
        let index = labels.count * 2
        labels.append(label)
        let a = pass.sampleBufferAttachments[0]!
        a.sampleBuffer = buffers[frame % buffers.count]
        a.startOfVertexSampleIndex = index
        a.endOfVertexSampleIndex = MTLCounterDontSample
        a.startOfFragmentSampleIndex = MTLCounterDontSample
        a.endOfFragmentSampleIndex = index + 1
    }

    /// Resolves this frame's samples once `commandBuffer` completes and starts the next frame.
    func endFrame(_ commandBuffer: any MTLCommandBuffer) {
        nonisolated(unsafe) let buffer = buffers[frame % buffers.count]
        let labels = self.labels
        let scale = nanosecondsPerTick
        let totals = self.totals
        commandBuffer.addCompletedHandler { _ in
            guard !labels.isEmpty, let data = try? buffer.resolveCounterRange(0..<labels.count * 2) else { return }
            let stamps = data.withUnsafeBytes { Array($0.bindMemory(to: MTLCounterResultTimestamp.self)) }
            let report: String? = totals.state.withLock { t in
                // Passes overlap (a vertex stage starts before the previous pass's fragments finish), so
                // each pass is charged from the previous pass's end to its own end.
                for (i, label) in labels.enumerated() {
                    let start = i == 0 ? stamps[0].timestamp : stamps[i * 2 - 1].timestamp, end = stamps[i * 2 + 1].timestamp
                    guard end > start, start != MTLCounterErrorValue, end != MTLCounterErrorValue else { continue }
                    if t.sums[label] == nil { t.order.append(label) }
                    t.sums[label, default: 0] += Double(end - start) * scale / 1e6
                }
                t.frames += 1
                guard t.frames % Self.reportEvery == 0 else { return nil }
                let frames = Double(t.frames)
                let lines = t.order.map { String(format: "  %-22@ %6.3f ms", $0 as NSString, t.sums[$0]! / frames) }
                let sum = t.sums.values.reduce(0, +) / frames
                return "post profile, mean of \(t.frames) frames:\n" + lines.joined(separator: "\n")
                    + String(format: "\n  %-22@ %6.3f ms\n", "listed passes" as NSString, sum)
            }
            if let report { FileHandle.standardError.write(Data(report.utf8)) }
        }
        frame += 1
        self.labels.removeAll(keepingCapacity: true)
    }
}
