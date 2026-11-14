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
}
