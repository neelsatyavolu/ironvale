// MetalFX Temporal in place of the web's TRAA and its dynamic-resolution resize (PLAN.md 3.3, 11):
// the scene is rendered with a sub-pixel jittered projection at the scene size and the scaler
// resolves it, with camera motion and reverse-Z depth, into an HDR texture at the output size.
// One scaler per output size serves every dynamic scene size: its inputs (composite colour, motion,
// depth) are allocated at the largest scene size and the composite pass fills their top-left
// corner, so a resolution step neither rebuilds the scaler nor drops its history.
import Metal
import MetalFX

@MainActor
final class PostTemporal {
    /// Jitter sequence length (Halton 2, 3), as TRAA's.
    static let phases = 32

    /// The scaler's inputs at the largest scene size; the composite pass draws into them.
    struct Inputs {
        let color: any MTLTexture   // rgba16Float
        let motion: any MTLTexture  // rg16Float, uv units of the content region
        let depth: any MTLTexture   // depth32Float, reverse-Z
    }

    private struct Key: Equatable {
        let inputWidth: Int, inputHeight: Int, outputWidth: Int, outputHeight: Int
    }

    private let device: any MTLDevice
    private var current: (key: Key, scaler: any MTLFXTemporalScaler, inputs: Inputs, output: any MTLTexture)?
    private var resetNext = true

    init(device: any MTLDevice) throws {
        guard MTLFXTemporalScalerDescriptor.supportsDevice(device) else {
            throw RenderError.allocation("MetalFX temporal scaler is not supported on \(device.name)")
        }
        self.device = device
    }

    /// Sub-pixel offset of frame `index` in scene pixels, each component in [-0.5, 0.5).
    static func jitter(frame index: Int) -> SIMD2<Float> {
        let i = index % phases + 1
        return SIMD2(PostKernels.halton(i, 2) - 0.5, PostKernels.halton(i, 3) - 0.5)
    }

    /// The inputs for scenes up to `maxWidth` x `maxHeight` resolved to the output size, (re)building
    /// the scaler when either size changes. `minScale` is the smallest scene size relative to the largest.
    func inputs(maxWidth: Int, maxHeight: Int, outputWidth: Int, outputHeight: Int, minScale: Double) throws -> Inputs {
        let key = Key(inputWidth: maxWidth, inputHeight: maxHeight, outputWidth: outputWidth, outputHeight: outputHeight)
        if let c = current, c.key == key { return c.inputs }
        current = nil
        let d = MTLFXTemporalScalerDescriptor()
        d.colorTextureFormat = .rgba16Float
        d.depthTextureFormat = .depth32Float
        d.motionTextureFormat = .rg16Float
        d.outputTextureFormat = .rgba16Float
        d.inputWidth = maxWidth
        d.inputHeight = maxHeight
        d.outputWidth = outputWidth
        d.outputHeight = outputHeight
        d.isAutoExposureEnabled = true
        // Output size over input content size, from the largest scene to the smallest.
        let low = Float(outputWidth) / Float(maxWidth)
        let high = Float(outputWidth) / (Float(maxWidth) * Float(minScale))
        d.isInputContentPropertiesEnabled = true
        d.inputContentMinScale = max(low, MTLFXTemporalScalerDescriptor.supportedInputContentMinScale(device: device))
        d.inputContentMaxScale = min(max(high, d.inputContentMinScale),
                                     MTLFXTemporalScalerDescriptor.supportedInputContentMaxScale(device: device))
        guard let scaler = d.makeTemporalScaler(device: device) else {
            throw RenderError.allocation("MetalFX temporal scaler \(maxWidth)x\(maxHeight) -> \(outputWidth)x\(outputHeight)")
        }
        func make(_ format: MTLPixelFormat, _ w: Int, _ h: Int, _ usage: MTLTextureUsage, _ label: String) throws -> any MTLTexture {
            let t = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: w, height: h, mipmapped: false)
            t.usage = usage
            t.storageMode = .private
            guard let texture = device.makeTexture(descriptor: t) else { throw RenderError.allocation(label) }
            texture.label = label
            return texture
        }
        let inputs = Inputs(
            color: try make(.rgba16Float, maxWidth, maxHeight, scaler.colorTextureUsage.union([.renderTarget, .shaderRead]), "post composite"),
            motion: try make(.rg16Float, maxWidth, maxHeight, scaler.motionTextureUsage.union(.renderTarget), "camera motion"),
            depth: try make(.depth32Float, maxWidth, maxHeight, scaler.depthTextureUsage.union(.renderTarget), "temporal depth"))
        let output = try make(.rgba16Float, outputWidth, outputHeight, scaler.outputTextureUsage.union(.shaderRead), "post temporal output")
        current = (key, scaler, inputs, output)
        resetNext = true
        return inputs
    }

    /// Discards the history at the next resolve (a cut, or the first frame).
    func reset() { resetNext = true }

    /// Resolves the `contentWidth` x `contentHeight` top-left region of the inputs into the output-size
    /// HDR texture and returns it. `inputs(...)` must have been called for this frame's sizes.
    func resolve(commandBuffer: any MTLCommandBuffer, contentWidth: Int, contentHeight: Int,
                 jitterPixels: SIMD2<Float>) -> any MTLTexture {
        guard let c = current else { preconditionFailure("PostTemporal.resolve before inputs") }
        let scaler = c.scaler
        scaler.colorTexture = c.inputs.color
        scaler.depthTexture = c.inputs.depth
        scaler.motionTexture = c.inputs.motion
        scaler.outputTexture = c.output
        scaler.inputContentWidth = contentWidth
        scaler.inputContentHeight = contentHeight
        // The projection is shifted by +jitter pixels (x right, y down); MetalFX wants the offset of
        // the sample from the pixel centre in the same convention.
        // (Checked on Railyard: the opposite sign converges visibly softer.)
        scaler.jitterOffsetX = jitterPixels.x
        scaler.jitterOffsetY = jitterPixels.y
        // Motion is in uv units of the content region.
        scaler.motionVectorScaleX = Float(contentWidth)
        scaler.motionVectorScaleY = Float(contentHeight)
        scaler.isDepthReversed = true
        scaler.reset = resetNext
        resetNext = false
        scaler.encode(commandBuffer: commandBuffer)
        return c.output
    }
}
