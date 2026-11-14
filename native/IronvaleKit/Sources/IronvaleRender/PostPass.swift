import Metal
import ShaderTypes

/// Final pass of PLAN.md 3.3 as far as M3 goes: ACES Filmic with exposure, sRGB encoding and
/// the vignette of src/render/pipeline.ts, from the HDR scene colour into a `bgra8Unorm` target.
/// GTAO, SSR, godrays, bloom, FXAA and grain arrive with M9.
@MainActor
public final class PostPass {
    private let pipeline: any MTLRenderPipelineState
    public var uniforms: IVPostUniforms

    public init(device: any MTLDevice, library: any MTLLibrary, outputFormat: MTLPixelFormat, exposure: Float) throws {
        guard let vertex = library.makeFunction(name: "ivPostVertex") else { throw RenderError.missingFunction("ivPostVertex") }
        guard let fragment = library.makeFunction(name: "ivPostFragment") else { throw RenderError.missingFunction("ivPostFragment") }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.label = "post"
        descriptor.vertexFunction = vertex
        descriptor.fragmentFunction = fragment
        descriptor.colorAttachments[0].pixelFormat = outputFormat
        pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        // pipeline.ts: mix(1, 0.78, smoothstep(0.35, 0.85, |uv - 0.5|)).
        uniforms = IVPostUniforms(exposure: exposure, vignetteInner: 0.35, vignetteOuter: 0.85, vignetteStrength: 0.78)
    }

    public func encode(commandBuffer: any MTLCommandBuffer, source: any MTLTexture, target: any MTLTexture,
                       profiler: PostProfiler? = nil) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .dontCare
        pass.colorAttachments[0].storeAction = .store
        profiler?.attach(pass, label: "tone map", commandBuffer: commandBuffer)
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.label = "post"
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<IVPostUniforms>.stride, index: 0)
        encoder.setFragmentTexture(source, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
    }
}
