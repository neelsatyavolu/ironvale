import AppKit
import IronvaleCore
import Metal
import QuartzCore
import ShaderTypes
import os

/// An `NSView` backed by a `CAMetalLayer` whose drawable tracks the view's pixel size.
@MainActor
public final class MetalView: NSView {
    public let metalLayer: CAMetalLayer

    /// `pixelFormat`: the M0 clear pass relies on `.bgra8Unorm_srgb`; the M3 post pass encodes sRGB
    /// itself (the vignette is applied after encoding, as on the web) and wants `.bgra8Unorm`.
    public init(frame: NSRect, device: any MTLDevice, pixelFormat: MTLPixelFormat = .bgra8Unorm_srgb) {
        metalLayer = CAMetalLayer()
        metalLayer.device = device
        metalLayer.pixelFormat = pixelFormat
        metalLayer.framebufferOnly = true
        metalLayer.maximumDrawableCount = 3
        super.init(frame: frame)
        wantsLayer = true
        layer = metalLayer
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override public func layout() {
        super.layout()
        updateDrawableSize()
    }

    override public func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateDrawableSize()
    }

    private func updateDrawableSize() {
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        metalLayer.contentsScale = scale
        let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
        if size.width > 0, size.height > 0 { metalLayer.drawableSize = size }
    }
}

/// Draws one frame into a drawable. The frame loop owns the command buffer and presents it.
@MainActor
public protocol FrameEncoder: AnyObject {
    /// `time` is seconds since the first frame, `dt` the clamped frame delta (engine.ts: min(dt, 0.05)).
    func encode(commandBuffer: any MTLCommandBuffer, drawable: any CAMetalDrawable, time: Double, dt: Double)
}

/// Frame loop: `CAMetalDisplayLink` on the main run loop. Without an encoder it draws the M0
/// clear pass; with one (M3) it hands each frame to it. Frame times are logged through
/// `os.Logger` and optionally collected for a CSV, and GPU times go to an optional `GPUFrameLog`.
@MainActor
public final class FrameLoop: NSObject, @MainActor CAMetalDisplayLinkDelegate {
    public struct Configuration: Sendable {
        public var uncapped: Bool
        public var frameLimit: Int?
        public var collectFrameTimes: Bool
        /// Stop once this many seconds have passed since the first frame.
        public var duration: Double?

        public init(uncapped: Bool = false, frameLimit: Int? = nil, collectFrameTimes: Bool = false, duration: Double? = nil) {
            self.uncapped = uncapped
            self.frameLimit = frameLimit
            self.collectFrameTimes = collectFrameTimes
            self.duration = duration
        }
    }

    public enum SetupError: Error, CustomStringConvertible {
        case noCommandQueue
        case missingFunction(String)

        public var description: String {
            switch self {
            case .noCommandQueue: "Metal device could not create a command queue"
            case .missingFunction(let name): "Shader function \(name) is missing from default.metallib"
            }
        }
    }

    private static let logger = Logger(subsystem: "dev.n3el.ironvale", category: "frame")
    private static let summaryInterval = 120

    private let view: MetalView
    private let queue: any MTLCommandQueue
    private let pipeline: any MTLRenderPipelineState
    private let configuration: Configuration
    private let onFinish: @MainActor (FrameTimeLog) -> Void
    private let encoder: (any FrameEncoder)?
    private let gpuLog: GPUFrameLog?
    private var displayLink: CAMetalDisplayLink?
    private var log = FrameTimeLog()
    private var frameCount = 0
    private var lastTimestamp: Double?
    private var startTimestamp: Double?
    private var summaryWorstMs = 0.0

    public init(
        view: MetalView,
        library: any MTLLibrary,
        configuration: Configuration,
        encoder: (any FrameEncoder)? = nil,
        gpuLog: GPUFrameLog? = nil,
        onFinish: @escaping @MainActor (FrameTimeLog) -> Void
    ) throws {
        guard let device = view.metalLayer.device, let queue = device.makeCommandQueue() else {
            throw SetupError.noCommandQueue
        }
        guard let vertex = library.makeFunction(name: "ivFullscreenVertex") else {
            throw SetupError.missingFunction("ivFullscreenVertex")
        }
        guard let fragment = library.makeFunction(name: "ivClearFragment") else {
            throw SetupError.missingFunction("ivClearFragment")
        }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.label = "M0 clear"
        descriptor.vertexFunction = vertex
        descriptor.fragmentFunction = fragment
        descriptor.colorAttachments[0].pixelFormat = view.metalLayer.pixelFormat
        self.pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        self.view = view
        self.queue = queue
        self.configuration = configuration
        self.onFinish = onFinish
        self.encoder = encoder
        self.gpuLog = gpuLog
        super.init()
    }

    /// Starts the display link, asking for the screen's full refresh range (120 Hz on ProMotion).
    public func start() {
        let layer = view.metalLayer
        layer.displaySyncEnabled = !configuration.uncapped
        let maxFPS = Float(view.window?.screen?.maximumFramesPerSecond ?? NSScreen.main?.maximumFramesPerSecond ?? 60)
        let link = CAMetalDisplayLink(metalLayer: layer)
        link.preferredFrameRateRange = CAFrameRateRange(minimum: min(30, maxFPS), maximum: maxFPS, preferred: maxFPS)
        link.preferredFrameLatency = 1
        link.delegate = self
        link.add(to: .main, forMode: .common)
        displayLink = link
        Self.logger.info("Frame loop started: max \(maxFPS, privacy: .public) Hz, uncapped \(self.configuration.uncapped, privacy: .public)")
    }

    public func stop() {
        displayLink?.invalidate()
        displayLink = nil
    }

    /// Called on the main run loop (the link is added to `.main`), hence the isolated conformance.
    public func metalDisplayLink(_ link: CAMetalDisplayLink, needsUpdate update: CAMetalDisplayLink.Update) {
        render(to: update.drawable, timestamp: update.targetPresentationTimestamp)
    }

    private func render(to drawable: any CAMetalDrawable, timestamp: Double) {
        guard displayLink != nil else { return }
        let start = startTimestamp ?? timestamp
        startTimestamp = start
        if let encoder {
            encodeFrame(encoder, to: drawable, time: timestamp - start, dt: min(lastTimestamp.map { timestamp - $0 } ?? 0, 0.05))
        } else {
            encodeClear(to: drawable, time: Float(timestamp - start))
        }
        record(timestamp: timestamp)
        let expired = configuration.duration.map { timestamp - start >= $0 } ?? false
        if expired || configuration.frameLimit.map({ frameCount >= $0 }) == true {
            stop()
            onFinish(log)
        }
    }

    private func encodeFrame(_ encoder: any FrameEncoder, to drawable: any CAMetalDrawable, time: Double, dt: Double) {
        guard let commandBuffer = queue.makeCommandBuffer() else {
            Self.logger.error("Dropped frame \(self.frameCount): no command buffer")
            return
        }
        commandBuffer.label = "frame \(frameCount)"
        if let gpuLog {
            let frame = frameCount
            commandBuffer.addCompletedHandler { buffer in
                gpuLog.record(frame: frame, gpuStart: buffer.gpuStartTime, gpuEnd: buffer.gpuEndTime)
            }
        }
        encoder.encode(commandBuffer: commandBuffer, drawable: drawable, time: time, dt: dt)
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    private func encodeClear(to drawable: any CAMetalDrawable, time: Float) {
        guard let commandBuffer = queue.makeCommandBuffer() else {
            Self.logger.error("Dropped frame \(self.frameCount): no command buffer")
            return
        }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = drawable.texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        if let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) {
            var uniforms = IVClearUniforms(color: SIMD4<Float>(0.055, 0.055, 0.051, 1), time: time, _pad0: 0, _pad1: 0, _pad2: 0)
            encoder.setRenderPipelineState(pipeline)
            encoder.setFragmentBytes(&uniforms, length: MemoryLayout<IVClearUniforms>.stride, index: 0)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            encoder.endEncoding()
        }
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    private func record(timestamp: Double) {
        let dtMs = lastTimestamp.map { (timestamp - $0) * 1000 } ?? 0
        lastTimestamp = timestamp
        frameCount += 1
        if configuration.collectFrameTimes { log = log.recording(timestamp: timestamp) }
        summaryWorstMs = max(summaryWorstMs, dtMs)
        Self.logger.debug("frame \(self.frameCount) dt \(dtMs, format: .fixed(precision: 3), privacy: .public) ms")
        if frameCount % Self.summaryInterval == 0 {
            Self.logger.info("frames \(self.frameCount) last dt \(dtMs, format: .fixed(precision: 3), privacy: .public) ms, worst \(self.summaryWorstMs, format: .fixed(precision: 3), privacy: .public) ms over last \(Self.summaryInterval) frames")
            summaryWorstMs = 0
        }
    }
}
