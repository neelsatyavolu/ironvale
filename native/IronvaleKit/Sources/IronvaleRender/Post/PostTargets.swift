// Render targets of the M9 post chain at one scene size: the scene MRT (pipeline.ts mrt()), the
// half- or full-resolution effect targets with three's sizes, the composite and camera motion the
// temporal pass reads, and the bloom mip chain (sized from the scene size, as the web blooms before
// the canvas is upscaled).
import Metal

@MainActor
final class PostTargets {
    struct BloomChain {
        let bright: any MTLTexture
        let horizontal: [any MTLTexture]
        let vertical: [any MTLTexture]
    }

    let scene: PostChain.SceneTargets
    let ao: (any MTLTexture)?
    let ssr: (any MTLTexture)?
    let ssrBlur: (any MTLTexture)?
    /// Nearest depth per 16 x 16 block of scene depth texels (PostSSR.metal IV_SSR_BLOCK).
    let ssrDepthBounds: (any MTLTexture)?
    let godrays: (any MTLTexture)?
    let shaftsH: (any MTLTexture)?
    let shaftsV: (any MTLTexture)?
    let composite: any MTLTexture
    let motion: any MTLTexture
    private var bloomChain: (width: Int, height: Int, chain: BloomChain)?
    private let device: any MTLDevice

    /// SSRNode's blur target: base level plus the four pushed mipmaps.
    static let ssrBlurLevels = 5
    /// PostSSR.metal IV_SSR_BLOCK.
    static let ssrBlock = 16

    init(device: any MTLDevice, width: Int, height: Int, settings: PostSettings) throws {
        self.device = device
        func make(_ format: MTLPixelFormat, _ w: Int, _ h: Int, _ label: String, levels: Int = 1) throws -> any MTLTexture {
            try Self.texture(device: device, format: format, width: w, height: h, label: label, levels: levels)
        }
        scene = PostChain.SceneTargets(
            color: try make(.rgba16Float, width, height, "scene colour"),
            normal: try make(.rgba8Unorm, width, height, "scene normal"),
            metalRough: try make(.rg8Unorm, width, height, "scene metal/rough"),
            depth: try make(.depth32Float, width, height, "scene depth"))
        if settings.ambientOcclusion {
            // GTAONode.setSize: round(width x resolutionScale).
            let s = settings.aoResolutionScale
            ao = try make(.r8Unorm, Self.round(width, s), Self.round(height, s), "GTAO")
        } else {
            ao = nil
        }
        if settings.reflections {
            // SSRNode.setSize: round(width x 0.5) for the march and the blur chain.
            let w = Self.round(width, 0.5), h = Self.round(height, 0.5)
            ssr = try make(.rgba16Float, w, h, "SSR")
            ssrBlur = try make(.rgba16Float, w, h, "SSR blur", levels: min(Self.ssrBlurLevels, Self.maxLevels(w, h)))
            ssrDepthBounds = try make(.r32Float, (width + Self.ssrBlock - 1) / Self.ssrBlock,
                                      (height + Self.ssrBlock - 1) / Self.ssrBlock, "SSR depth bounds")
        } else {
            ssr = nil
            ssrBlur = nil
            ssrDepthBounds = nil
        }
        if settings.volumetricLight && settings.shadowMapSize > 0 {
            // GodraysNode resolutionScale 0.5 (floor), the bilateral blur at the same scale.
            let w = max(1, width / 2), h = max(1, height / 2)
            godrays = try make(.rgba8Unorm, w, h, "godrays")
            shaftsH = try make(.rgba8Unorm, w, h, "godrays blur H")
            shaftsV = try make(.rgba8Unorm, w, h, "godrays blur V")
        } else {
            godrays = nil
            shaftsH = nil
            shaftsV = nil
        }
        composite = try make(.rgba16Float, width, height, "post composite")
        motion = try make(.rg16Float, width, height, "camera motion")
    }

    func matches(width: Int, height: Int) -> Bool { scene.width == width && scene.height == height }

    /// BloomNode.setSize: floor(size x 0.5), halved (floor) per mip.
    func bloom(device: any MTLDevice, width: Int, height: Int) throws -> BloomChain {
        if let b = bloomChain, b.width == width, b.height == height { return b.chain }
        var w = max(1, width / 2), h = max(1, height / 2)
        let bright = try Self.texture(device: device, format: .rgba16Float, width: w, height: h, label: "bloom bright")
        var horizontal: [any MTLTexture] = [], vertical: [any MTLTexture] = []
        for level in 0..<PostChain.bloomMips {
            horizontal.append(try Self.texture(device: device, format: .rgba16Float, width: w, height: h, label: "bloom H\(level)"))
            vertical.append(try Self.texture(device: device, format: .rgba16Float, width: w, height: h, label: "bloom V\(level)"))
            w = max(1, w / 2)
            h = max(1, h / 2)
        }
        let chain = BloomChain(bright: bright, horizontal: horizontal, vertical: vertical)
        bloomChain = (width, height, chain)
        return chain
    }

    private static func round(_ size: Int, _ scale: Float) -> Int { max(1, Int((Float(size) * scale).rounded())) }

    private static func maxLevels(_ w: Int, _ h: Int) -> Int { Int(log2(Double(max(w, h)))) + 1 }

    private static func texture(device: any MTLDevice, format: MTLPixelFormat, width: Int, height: Int, label: String,
                                levels: Int = 1) throws -> any MTLTexture {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: width, height: height, mipmapped: false)
        d.mipmapLevelCount = levels
        d.usage = [.renderTarget, .shaderRead]
        d.storageMode = .private
        guard let t = device.makeTexture(descriptor: d) else { throw RenderError.allocation(label) }
        t.label = label
        return t
    }
}
