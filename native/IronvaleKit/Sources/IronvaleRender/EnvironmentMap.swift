import Foundation
import Metal
import ShaderTypes

/// Image-based light from an equirect HDR (PLAN.md 3.3). Until asset-bake ships baked IBL, the
/// prefiltered chain is built at load with a compute kernel: an rgba16Float equirect whose mip
/// level i holds GGX-filtered radiance for roughness i / maxLod. Diffuse irradiance reads the
/// roughness-1 level, as three's getIBLIrradiance reads its PMREM at roughness 1.
@MainActor
public final class EnvironmentMap {
    public let texture: any MTLTexture
    public var maxLod: Float { Float(texture.mipmapLevelCount - 1) }

    public static let baseWidth = 1024
    public static let levels = 7
    public static let sampleCount: UInt32 = 512

    public init(hdr: RadianceHDR, device: any MTLDevice, library: any MTLLibrary, queue: any MTLCommandQueue) throws {
        let source = try Self.upload(hdr, device: device)
        guard let function = library.makeFunction(name: "ivPrefilterEnvironment") else {
            throw RenderError.missingFunction("ivPrefilterEnvironment")
        }
        let pipeline = try device.makeComputePipelineState(function: function)
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba16Float, width: Self.baseWidth,
                                                                  height: Self.baseWidth / 2, mipmapped: true)
        descriptor.mipmapLevelCount = Self.levels
        descriptor.usage = [.shaderRead, .shaderWrite]
        descriptor.storageMode = .private
        guard let target = device.makeTexture(descriptor: descriptor),
              let commands = queue.makeCommandBuffer()
        else { throw RenderError.allocation("environment chain") }
        target.label = "environment (prefiltered)"

        if let blit = commands.makeBlitCommandEncoder() {
            blit.generateMipmaps(for: source)
            blit.endEncoding()
        }
        guard let encoder = commands.makeComputeCommandEncoder() else { throw RenderError.allocation("compute encoder") }
        encoder.setComputePipelineState(pipeline)
        encoder.setTexture(source, index: 0)
        for level in 0..<Self.levels {
            guard let view = target.makeTextureView(pixelFormat: .rgba16Float, textureType: .type2D,
                                                    levels: level..<(level + 1), slices: 0..<1)
            else { throw RenderError.allocation("environment level view") }
            var uniforms = IVPrefilterUniforms(
                roughness: Float(level) / Float(Self.levels - 1),
                sampleCount: level == 0 ? 1 : Self.sampleCount,
                sourceWidth: Float(source.width),
                level: UInt32(level)
            )
            encoder.setTexture(view, index: 1)
            encoder.setBytes(&uniforms, length: MemoryLayout<IVPrefilterUniforms>.stride, index: 0)
            let grid = MTLSize(width: view.width, height: view.height, depth: 1)
            encoder.dispatchThreads(grid, threadsPerThreadgroup: MTLSize(width: 16, height: 16, depth: 1))
        }
        encoder.endEncoding()
        commands.commit()
        commands.waitUntilCompleted()
        if let error = commands.error { throw RenderError.allocation("environment prefilter failed: \(error)") }
        texture = target
    }

    private static func upload(_ hdr: RadianceHDR, device: any MTLDevice) throws -> any MTLTexture {
        // rgba32Float: Float16 is not available to every slice a Release build compiles, and Apple
        // GPUs filter 32-bit float textures (needed for the mip chain).
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba32Float, width: hdr.width,
                                                                  height: hdr.height, mipmapped: true)
        descriptor.usage = [.shaderRead]
        guard device.supports32BitFloatFiltering, let texture = device.makeTexture(descriptor: descriptor) else {
            throw RenderError.allocation("HDR texture (needs 32-bit float filtering)")
        }
        texture.label = "environment (source)"
        var rgba = [Float](repeating: 1, count: hdr.width * hdr.height * 4)
        for i in 0..<(hdr.width * hdr.height) {
            rgba[i * 4] = hdr.pixels[i * 3]
            rgba[i * 4 + 1] = hdr.pixels[i * 3 + 1]
            rgba[i * 4 + 2] = hdr.pixels[i * 3 + 2]
        }
        texture.replace(region: MTLRegionMake2D(0, 0, hdr.width, hdr.height), mipmapLevel: 0, withBytes: rgba,
                        bytesPerRow: hdr.width * 16)
        return texture
    }
}
