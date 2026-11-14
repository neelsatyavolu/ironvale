import Dispatch
import Foundation
import IronvaleCore
import IronvaleRender
import Metal
import QuartzCore
import Synchronization

/// Renders the flythrough offscreen, uncapped, with up to three frames in flight, for `duration`
/// seconds of wall time. Frame times are the intervals between GPU completions (what a display
/// would receive back to back), so the log does not depend on the window being visible: macOS
/// stops a display link while its window is covered or on another Space.
@MainActor
public enum OffscreenBenchmark {
    public struct Result: Sendable {
        public let frames: FrameTimeLog
        public let gpu: GPUFrameLog
    }

    public static func run(renderer: MapRenderer, device: any MTLDevice, duration: Double,
                           poseAt: (Double) -> CameraPose) throws -> Result {
        guard let queue = device.makeCommandQueue() else { throw RenderError.allocation("benchmark queue") }
        if let repeats = ProcessInfo.processInfo.environment["IV_BENCH_REPEAT"].flatMap(Int.init), repeats > 0 {
            try minimumGPUTimes(renderer: renderer, device: device, queue: queue, duration: duration, repeats: repeats, poseAt: poseAt)
            exit(0)
        }
        let outputs = try (0..<3).map { _ -> any MTLTexture in
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: renderer.settings.internalWidth,
                                                             height: renderer.settings.internalHeight, mipmapped: false)
            d.usage = [.renderTarget]
            d.storageMode = .private
            guard let t = device.makeTexture(descriptor: d) else { throw RenderError.allocation("benchmark target") }
            return t
        }
        let inFlight = DispatchSemaphore(value: outputs.count)
        let completions = Mutex<[(frame: Int, time: Double)]>([])
        let gpu = GPUFrameLog()
        let start = CACurrentMediaTime()
        var frame = 0
        while CACurrentMediaTime() - start < duration {
            inFlight.wait()
            guard let commands = queue.makeCommandBuffer() else { inFlight.signal(); throw RenderError.allocation("command buffer") }
            let time = CACurrentMediaTime() - start
            renderer.encode(commandBuffer: commands, pose: poseAt(time), time: time, output: outputs[frame % outputs.count])
            let index = frame
            commands.addCompletedHandler { buffer in
                completions.withLock { $0.append((index, CACurrentMediaTime())) }
                gpu.record(frame: index, gpuStart: buffer.gpuStartTime, gpuEnd: buffer.gpuEndTime)
                inFlight.signal()
            }
            commands.commit()
            frame += 1
        }
        // Drain, then restore the count: libdispatch traps when a semaphore dies below its start value.
        for _ in outputs { inFlight.wait() }
        for _ in outputs { inFlight.signal() }
        let ordered = completions.withLock { $0.sorted { $0.frame < $1.frame } }
        let log = ordered.reduce(FrameTimeLog()) { $0.recording(timestamp: $1.time) }
        return Result(frames: log, gpu: gpu)
    }

    /// Development aid (IV_BENCH_REPEAT=N): GPU cost per frame with the GPU shared with other work.
    /// Renders 20 poses per second of the flight one frame at a time (no overlap between frames), each
    /// N times in a row, keeps each pose's fastest GPU time (other processes' work only adds to it)
    /// and prints the distribution over the poses to stderr, then exits.
    private static func minimumGPUTimes(renderer: MapRenderer, device: any MTLDevice, queue: any MTLCommandQueue,
                                        duration: Double, repeats: Int, poseAt: (Double) -> CameraPose) throws {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: renderer.settings.internalWidth,
                                                         height: renderer.settings.internalHeight, mipmapped: false)
        d.usage = [.renderTarget]
        d.storageMode = .private
        guard let output = device.makeTexture(descriptor: d) else { throw RenderError.allocation("benchmark target") }
        var best: [Double] = []
        let poses = Int(duration * 20)
        for p in 0..<poses {
            let time = Double(p) / 20
            var fastest = Double.infinity
            for r in 0..<repeats {
                guard let commands = queue.makeCommandBuffer() else { throw RenderError.allocation("command buffer") }
                renderer.encode(commandBuffer: commands, pose: poseAt(time), time: time + Double(r) / 120, output: output)
                commands.commit()
                commands.waitUntilCompleted()
                fastest = min(fastest, (commands.gpuEndTime - commands.gpuStartTime) * 1000)
            }
            best.append(fastest)
        }
        let sorted = best.sorted()
        func q(_ f: Double) -> Double { sorted[Int(Double(sorted.count - 1) * f)] }
        let worst = sorted.suffix(max(1, sorted.count / 100))
        let report = String(format: "fastest GPU ms per pose over %d poses x %d: mean %.3f  median %.3f  p90 %.3f  p99 %.3f  worst 1%% mean %.3f  max %.3f\n",
                            sorted.count, repeats, sorted.reduce(0, +) / Double(sorted.count), q(0.5), q(0.9), q(0.99),
                            worst.reduce(0, +) / Double(worst.count), sorted.last ?? 0)
        let slowest = best.enumerated().sorted { $0.element > $1.element }.prefix(8)
            .map { String(format: "%.2f s %.2f ms", Double($0.offset) / 20, $0.element) }.joined(separator: ", ")
        FileHandle.standardError.write(Data((report + "slowest poses: \(slowest)\n").utf8))
    }
}
