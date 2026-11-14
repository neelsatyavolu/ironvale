// MetalFX Temporal in place of the web's TRAA and its dynamic-resolution resize (PLAN.md 3.3, 11):
// the scene is rendered with a sub-pixel jittered projection at the scene size and the scaler
// resolves it, with camera motion and reverse-Z depth, into an HDR texture at the output size.
import Metal
import MetalFX

@MainActor
final class PostTemporal {
    /// Jitter sequence length (Halton 2, 3), as TRAA's.
    static let phases = 32

    private let device: any MTLDevice
    private var scalers: [Key: any MTLFXTemporalScaler] = [:]
    private var outputs: [Key: any MTLTexture] = [:]
    private var lastKey: Key?

    struct Key: Hashable {
        let inputWidth: Int, inputHeight: Int, outputWidth: Int, outputHeight: Int
    }

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

    /// Resolves `color` (scene size) into an output-size HDR texture and returns it.
    func resolve(commandBuffer: any MTLCommandBuffer, color: any MTLTexture, depth: any MTLTexture, motion: any MTLTexture,
                 outputWidth: Int, outputHeight: Int, jitterPixels: SIMD2<Float>, reset: Bool) throws -> any MTLTexture {
        let key = Key(inputWidth: color.width, inputHeight: color.height, outputWidth: outputWidth, outputHeight: outputHeight)
        let (scaler, output) = try scaler(for: key)
        scaler.colorTexture = color
        scaler.depthTexture = depth
        scaler.motionTexture = motion
        scaler.outputTexture = output
        scaler.inputContentWidth = color.width
        scaler.inputContentHeight = color.height
        // The projection is shifted by +jitter pixels (x right, y down); MetalFX wants the offset of
        // the sample from the pixel centre in the same convention.
        // (Checked on Railyard: the opposite sign converges visibly softer.)
        scaler.jitterOffsetX = jitterPixels.x
        scaler.jitterOffsetY = jitterPixels.y
        scaler.motionVectorScaleX = Float(color.width)
        scaler.motionVectorScaleY = Float(color.height)
        scaler.isDepthReversed = true
        scaler.reset = reset || key != lastKey
        lastKey = key
        scaler.encode(commandBuffer: commandBuffer)
        return output
    }

    private func scaler(for key: Key) throws -> (any MTLFXTemporalScaler, any MTLTexture) {
        if let s = scalers[key], let o = outputs[key] { return (s, o) }
        let d = MTLFXTemporalScalerDescriptor()
        d.colorTextureFormat = .rgba16Float
        d.depthTextureFormat = .depth32Float
        d.motionTextureFormat = .rg16Float
        d.outputTextureFormat = .rgba16Float
        d.inputWidth = key.inputWidth
        d.inputHeight = key.inputHeight
        d.outputWidth = key.outputWidth
        d.outputHeight = key.outputHeight
        d.isAutoExposureEnabled = true
        guard let scaler = d.makeTemporalScaler(device: device) else {
            throw RenderError.allocation("MetalFX temporal scaler \(key.inputWidth)x\(key.inputHeight) -> \(key.outputWidth)x\(key.outputHeight)")
        }
        let t = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba16Float, width: key.outputWidth,
                                                         height: key.outputHeight, mipmapped: false)
        t.usage = scaler.outputTextureUsage.union(.shaderRead)
        t.storageMode = .private
        guard let output = device.makeTexture(descriptor: t) else { throw RenderError.allocation("temporal output") }
        output.label = "post temporal output"
        // Dynamic resolution visits a handful of sizes; keep the most recent few.
        if scalers.count >= 4 {
            scalers.removeAll()
            outputs.removeAll()
        }
        scalers[key] = scaler
        outputs[key] = output
        return (scaler, output)
    }
}
