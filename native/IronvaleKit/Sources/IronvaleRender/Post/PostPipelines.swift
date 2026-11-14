// Pipeline states and the full-screen draw helper for the M9 post chain (Shaders/Post*.metal),
// plus the kernel tables three's post nodes compute on the CPU.
import Metal
import ShaderTypes

@MainActor
struct PostPipelines {
    let gtao: any MTLRenderPipelineState
    let ssr: any MTLRenderPipelineState
    let ssrDepthBounds: any MTLComputePipelineState
    let ssrCoarseBounds: any MTLComputePipelineState
    let ssrMetalMask: any MTLComputePipelineState
    let ssrBlur: any MTLComputePipelineState
    let godrays: any MTLRenderPipelineState
    let bilateral: any MTLRenderPipelineState
    let composite: any MTLRenderPipelineState
    /// TRAA resolve into the history colour and depth (PostTRAA).
    let traa: any MTLRenderPipelineState
    let bloomHighPass: any MTLRenderPipelineState
    let bloomBlur: any MTLRenderPipelineState
    let bloomComposite: any MTLRenderPipelineState
    private var outputs: [MTLPixelFormat: any MTLRenderPipelineState] = [:]
    private let device: any MTLDevice
    private let library: any MTLLibrary

    init(device: any MTLDevice, library: any MTLLibrary) throws {
        self.device = device
        self.library = library
        func make(_ fragment: String, _ formats: [MTLPixelFormat]) throws -> any MTLRenderPipelineState {
            try Self.pipeline(device: device, library: library, fragment: fragment, formats: formats)
        }
        gtao = try make("ivGTAOFragment", [.r8Unorm])
        ssr = try make("ivSSRFragment", [.rgba16Float])
        ssrDepthBounds = try Self.kernel(device: device, library: library, "ivSSRDepthBoundsKernel")
        ssrCoarseBounds = try Self.kernel(device: device, library: library, "ivSSRCoarseBoundsKernel")
        ssrMetalMask = try Self.kernel(device: device, library: library, "ivSSRMetalMaskKernel")
        ssrBlur = try Self.kernel(device: device, library: library, "ivSSRBlurKernel")
        godrays = try make("ivGodraysFragment", [.rgba8Unorm])
        bilateral = try make("ivBilateralBlurFragment", [.rgba8Unorm])
        composite = try make("ivPostCompositeFragment", [.rgba16Float])
        traa = try make("ivTRAAFragment", [.rgba16Float, .r32Float])
        bloomHighPass = try make("ivBloomHighPassFragment", [.rgba16Float])
        bloomBlur = try make("ivBloomBlurFragment", [.rgba16Float])
        bloomComposite = try make("ivBloomCompositeFragment", [.rgba16Float])
    }

    /// The display pass, specialised for the output texture's format.
    mutating func output(format: MTLPixelFormat) throws -> any MTLRenderPipelineState {
        if let p = outputs[format] { return p }
        let p = try Self.pipeline(device: device, library: library, fragment: "ivPostOutputFragment", formats: [format])
        outputs[format] = p
        return p
    }

    private static func kernel(device: any MTLDevice, library: any MTLLibrary, _ name: String) throws -> any MTLComputePipelineState {
        guard let f = library.makeFunction(name: name) else { throw RenderError.missingFunction(name) }
        return try device.makeComputePipelineState(function: f)
    }

    private static func pipeline(device: any MTLDevice, library: any MTLLibrary, fragment: String,
                                 formats: [MTLPixelFormat]) throws -> any MTLRenderPipelineState {
        guard let vertex = library.makeFunction(name: "ivPostVertex") else { throw RenderError.missingFunction("ivPostVertex") }
        guard let f = library.makeFunction(name: fragment) else { throw RenderError.missingFunction(fragment) }
        let d = MTLRenderPipelineDescriptor()
        d.label = fragment
        d.vertexFunction = vertex
        d.fragmentFunction = f
        for (i, format) in formats.enumerated() { d.colorAttachments[i].pixelFormat = format }
        return try device.makeRenderPipelineState(descriptor: d)
    }

    /// The chain's profiler while it encodes a frame (IV_POST_PROFILE=1), else nil.
    static var profiler: PostProfiler?

    /// One full-screen triangle into `targets` (mip `level`); `clear` clears first, else the
    /// previous contents are not needed.
    static func draw(_ commandBuffer: any MTLCommandBuffer, label: String, pipeline: any MTLRenderPipelineState,
                     targets: [any MTLTexture], level: Int = 0, clear: MTLClearColor? = nil,
                     bind: (any MTLRenderCommandEncoder) -> Void) {
        let pass = MTLRenderPassDescriptor()
        for (i, t) in targets.enumerated() {
            pass.colorAttachments[i].texture = t
            pass.colorAttachments[i].level = level
            pass.colorAttachments[i].loadAction = clear == nil ? .dontCare : .clear
            pass.colorAttachments[i].clearColor = clear ?? MTLClearColor()
            pass.colorAttachments[i].storeAction = .store
        }
        profiler?.attach(pass, label: label, commandBuffer: commandBuffer)
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.label = label
        encoder.setRenderPipelineState(pipeline)
        bind(encoder)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
    }
}

extension PostPipelines {
    /// One compute dispatch of `threadgroups` groups of `threadsPerGroup` threads.
    static func dispatch(_ commandBuffer: any MTLCommandBuffer, label: String, pipeline: any MTLComputePipelineState,
                         threadgroups: MTLSize, threadsPerGroup: MTLSize, bind: (any MTLComputeCommandEncoder) -> Void) {
        let pass = MTLComputePassDescriptor()
        profiler?.attach(pass, label: label, commandBuffer: commandBuffer)
        guard let encoder = commandBuffer.makeComputeCommandEncoder(descriptor: pass) else { return }
        encoder.label = label
        encoder.setComputePipelineState(pipeline)
        bind(encoder)
        encoder.dispatchThreadgroups(threadgroups, threadsPerThreadgroup: threadsPerGroup)
        encoder.endEncoding()
    }
}

/// CPU-side tables of three's post nodes.
enum PostKernels {
    /// 0.39894 exp(-i^2 / 2 sigma^2) / sigma with sigma = radius / 3 (BloomNode, BilateralBlurNode).
    static func gaussian(radius: Int) -> [Float] {
        let sigma = Float(radius) / 3
        return (0..<radius).map { i in 0.39894 * exp(-0.5 * Float(i * i) / (sigma * sigma)) / sigma }
    }

    /// BloomNode._getSeparableBlurMaterial: centre weight and linearly-sampled (offset, weight) pairs.
    static func bloomTaps(radius: Int) -> (center: Float, taps: [SIMD2<Float>]) {
        let c = gaussian(radius: radius)
        var taps: [SIMD2<Float>] = []
        var i = 1
        while i < radius {
            let wa = c[i]
            let wb = i + 1 < radius ? c[i + 1] : 0
            let w = wa + wb
            taps.append(SIMD2((Float(i) * wa + Float(i + 1) * wb) / w, w))
            i += 2
        }
        return (c[0], taps)
    }

    /// GTAONode temporal tables (Activision GTAO).
    static let temporalRotations: [Float] = [60, 300, 180, 240, 120, 0]
    static let spatialOffsets: [Float] = [0, 0.5, 0.25, 0.75]

    /// Radical inverse in `base` (TAAUtils halton), for TRAA's sub-pixel jitter sequence.
    static func halton(_ index: Int, _ base: Int) -> Float {
        var f: Float = 1, r: Float = 0, i = index
        while i > 0 {
            f /= Float(base)
            r += f * Float(i % base)
            i /= base
        }
        return r
    }
}
