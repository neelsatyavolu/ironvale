// Development aid: per-pass GPU times of the M9 post chain, from stage-boundary timestamp counters
// (each pass from the previous pass's last fragment to its own).
// Enabled with IV_POST_PROFILE=1; every 240 frames it prints each pass's mean, median and 10th-percentile
// milliseconds to stderr (the low percentiles are the useful ones on a GPU shared with other processes).
// Work encoded outside the chain's passes is timed with markers (`mark`): "scene tail" is the part of the
// scene pass still running when the chain starts, "MetalFX temporal" the scaler's own encoders. The
// scene's full cost is the frame's GPU time (--gpu-log) minus the listed passes after "scene tail".
import Foundation
import Metal
import Synchronization

@MainActor
final class PostProfiler {
    static let enabled = ProcessInfo.processInfo.environment["IV_POST_PROFILE"] == "1"
    private static let samplesPerFrame = 128
    private static let reportEvery = 240

    private let buffers: [any MTLCounterSampleBuffer]
    private let markerBuffer: any MTLBuffer
    private var frame = 0
    private var labels: [String] = []
    private final class Totals: Sendable {
        let state = Mutex<(sums: [String: Double], samples: [String: [Double]], frames: Int, order: [String])>(([:], [:], 0, []))
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
        guard let marker = device.makeBuffer(length: 16, options: .storageModePrivate) else { return nil }
        markerBuffer = marker
        // Calibrate GPU ticks against the CPU clock (nanoseconds) over a short interval.
        let (cpu0, gpu0) = device.sampleTimestamps()
        usleep(20_000)
        let (cpu1, gpu1) = device.sampleTimestamps()
        nanosecondsPerTick = gpu1 > gpu0 ? Double(cpu1 - cpu0) / Double(gpu1 - gpu0) : 1
    }

    /// Times the render pass `pass` under `label` (one vertex-start and one fragment-end sample).
    func attach(_ pass: MTLRenderPassDescriptor, label: String) {
        guard let (buffer, index) = reserve(label) else { return }
        let a = pass.sampleBufferAttachments[0]!
        a.sampleBuffer = buffer
        a.startOfVertexSampleIndex = index
        a.endOfVertexSampleIndex = MTLCounterDontSample
        a.startOfFragmentSampleIndex = MTLCounterDontSample
        a.endOfFragmentSampleIndex = index + 1
    }

    /// Times the compute pass `pass` under `label`.
    func attach(_ pass: MTLComputePassDescriptor, label: String) {
        guard let (buffer, index) = reserve(label) else { return }
        let a = pass.sampleBufferAttachments[0]!
        a.sampleBuffer = buffer
        a.startOfEncoderSampleIndex = index
        a.endOfEncoderSampleIndex = index + 1
    }

    /// Ends a stretch of GPU work encoded outside the chain's own passes (the scene, MetalFX) under
    /// `label`: a one-texel copy out of `after`, which therefore runs once the work writing it is done.
    func mark(_ commandBuffer: any MTLCommandBuffer, label: String, after texture: any MTLTexture) {
        guard let (buffer, index) = reserve(label) else { return }
        let pass = MTLBlitPassDescriptor()
        let a = pass.sampleBufferAttachments[0]!
        a.sampleBuffer = buffer
        a.startOfEncoderSampleIndex = index
        a.endOfEncoderSampleIndex = index + 1
        guard let blit = commandBuffer.makeBlitCommandEncoder(descriptor: pass) else { return }
        blit.label = label
        blit.copy(from: texture, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(), sourceSize: MTLSize(width: 1, height: 1, depth: 1),
                  to: markerBuffer, destinationOffset: 0, destinationBytesPerRow: 16, destinationBytesPerImage: 16)
        blit.endEncoding()
    }

    private func reserve(_ label: String) -> ((any MTLCounterSampleBuffer), Int)? {
        guard labels.count * 2 + 2 <= Self.samplesPerFrame else { return nil }
        let index = labels.count * 2
        labels.append(label)
        return (buffers[frame % buffers.count], index)
    }

    /// Records this frame's scene size, reported as the mean scene width with the pass times.
    func noteScene(width: Int) { sceneWidthSum += width; sceneFrames += 1 }
    private var sceneWidthSum = 0, sceneFrames = 0

    /// Resolves this frame's samples once `commandBuffer` completes and starts the next frame.
    func endFrame(_ commandBuffer: any MTLCommandBuffer) {
        nonisolated(unsafe) let buffer = buffers[frame % buffers.count]
        let labels = self.labels
        let scale = nanosecondsPerTick
        let totals = self.totals
        let sceneWidth = sceneFrames > 0 ? Double(sceneWidthSum) / Double(sceneFrames) : 0
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
                    let ms = Double(end - start) * scale / 1e6
                    t.sums[label, default: 0] += ms
                    t.samples[label, default: []].append(ms)
                }
                t.frames += 1
                guard t.frames % Self.reportEvery == 0 else { return nil }
                let frames = Double(t.frames)
                // Other processes' GPU work lands inside whichever pass it interrupts and inflates the
                // mean; the median is closer to the pass's own cost on a shared GPU.
                // The 10th percentile is the closest to the pass's cost on an idle GPU.
                func quantile(_ v: [Double], _ q: Double) -> Double { v.isEmpty ? 0 : v.sorted()[Int(Double(v.count - 1) * q)] }
                func median(_ v: [Double]) -> Double { quantile(v, 0.5) }
                let lines = t.order.map {
                    String(format: "  %-22@ mean %6.3f  median %6.3f  p10 %6.3f ms", $0 as NSString, t.sums[$0]! / frames,
                           median(t.samples[$0] ?? []), quantile(t.samples[$0] ?? [], 0.1))
                }
                let sum = t.sums.values.reduce(0, +) / frames
                let medians = t.samples.values.reduce(0) { $0 + median($1) }
                let lows = t.samples.values.reduce(0) { $0 + quantile($1, 0.1) }
                return String(format: "post profile, %d frames, mean scene width so far %.0f px:\n", t.frames, sceneWidth) + lines.joined(separator: "\n")
                    + String(format: "\n  %-22@ mean %6.3f  median %6.3f  p10 %6.3f ms\n", "listed passes" as NSString, sum, medians, lows)
            }
            if let report { FileHandle.standardError.write(Data(report.utf8)) }
        }
        frame += 1
        self.labels.removeAll(keepingCapacity: true)
    }
}
