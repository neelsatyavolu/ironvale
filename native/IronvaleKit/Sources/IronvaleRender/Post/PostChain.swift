// The M9 post frame graph (PLAN.md 3.3), ported from src/render/pipeline.ts at commit 1aca0b7:
//   scene MRT (colour, packed view normal, metal/rough, depth) -> GTAO -> SSR -> godrays + bilateral
//   blur -> composite (+ camera motion) -> MetalFX Temporal (for TRAA, upscaling to the output) ->
//   bloom -> ACES tone map, vignette, film grain.
// The chain owns the scene targets so it can resize them for the render scale and dynamic
// resolution; the map renderer draws into `frame.targets` and then calls `encode`.
import Metal
import ShaderTypes
import simd

@MainActor
public final class PostChain {
    /// Map lighting values pipeline.ts reads (world/types LightingSetup).
    public struct Lighting: Sendable {
        public var exposure: Float
        /// Linear sun colour (three Color from the sRGB hex), without intensity.
        public var sunColor: SIMD3<Float>
        public var sunIntensity: Float
        public var fogDensity: Float
        public var volumetric: Float
        public var shaftDensity: Float
        public var bloom: Float

        public init(exposure: Float, sunColor: SIMD3<Float>, sunIntensity: Float, fogDensity: Float, volumetric: Float,
                    shaftDensity: Float, bloom: Float) {
            self.exposure = exposure
            self.sunColor = sunColor
            self.sunIntensity = sunIntensity
            self.fogDensity = fogDensity
            self.volumetric = volumetric
            self.shaftDensity = shaftDensity
            self.bloom = bloom
        }
    }

    /// Render targets of the scene pass (src/render/pipeline.ts mrt()).
    public struct SceneTargets {
        public let color: any MTLTexture       // rgba16Float
        public let normal: any MTLTexture      // rgba8Unorm, packed view normal
        public let metalRough: any MTLTexture  // rg8Unorm
        public let depth: any MTLTexture       // depth32Float, reverse-Z
        public var width: Int { color.width }
        public var height: Int { color.height }
    }

    /// What the scene pass needs for one frame.
    public struct Frame {
        public let targets: SceneTargets
        /// Sub-pixel jitter in scene pixels (x right, y down); zero without the temporal pass.
        public let jitterPixels: SIMD2<Float>
        let outputWidth: Int
        let outputHeight: Int

        /// Shifts `projection` by the jitter (a perspective projection: clip.w = -z).
        public func jittered(_ projection: simd_float4x4) -> simd_float4x4 {
            var p = projection
            let ndc = SIMD2(2 * jitterPixels.x / Float(targets.width), -2 * jitterPixels.y / Float(targets.height))
            p.columns.2.x -= ndc.x
            p.columns.2.y -= ndc.y
            return p
        }
    }

    /// Camera data of the frame being encoded.
    public struct Camera {
        public var projection: simd_float4x4  // unjittered
        public var view: simd_float4x4
        public var position: SIMD3<Float>
        public var near: Float
        public var far: Float
        public var shadowViewProjection: simd_float4x4
        public var shadowMap: (any MTLTexture)?
        public var time: Float

        public init(projection: simd_float4x4, view: simd_float4x4, position: SIMD3<Float>, near: Float, far: Float,
                    shadowViewProjection: simd_float4x4, shadowMap: (any MTLTexture)?, time: Float) {
            self.projection = projection
            self.view = view
            self.position = position
            self.near = near
            self.far = far
            self.shadowViewProjection = shadowViewProjection
            self.shadowMap = shadowMap
            self.time = time
        }
    }

    /// pipeline.ts constants.
    static let shaftFadeStart: Float = 110
    static let shaftFadeEnd: Float = 320
    static let bloomMips = 5
    static let bloomKernels = [6, 10, 14, 18, 22]
    static let minRenderScale: Float = 0.5
    /// Length of the sub-pixel jitter cycle of the temporal pass.
    public static let jitterPhases = PostTemporal.phases

    public let settings: PostSettings
    public let lighting: Lighting
    public private(set) var dynamicResolution = DynamicResolution()
    private let device: any MTLDevice
    private var pipelines: PostPipelines
    private let temporal: PostTemporal?
    private var targets: PostTargets?
    private var frameIndex = 0
    private var previousViewProjection: simd_float4x4?
    private var resetHistory = true
    private let profiler: PostProfiler?

    public init(device: any MTLDevice, library: any MTLLibrary, settings: PostSettings, lighting: Lighting) throws {
        self.device = device
        self.settings = settings
        self.lighting = lighting
        pipelines = try PostPipelines(device: device, library: library)
        temporal = settings.antiAliasing == .temporal ? try PostTemporal(device: device) : nil
        profiler = PostProfiler(device: device)
    }

    /// Scene size for an output size: the web's floor(css size x devicePixelRatio x renderScale x dynamic).
    public func sceneSize(outputWidth: Int, outputHeight: Int) -> (width: Int, height: Int) {
        let scale = Double(settings.renderScale) * dynamicResolution.scale
        return (max(1, Int((Double(outputWidth) * scale).rounded(.down))), max(1, Int((Double(outputHeight) * scale).rounded(.down))))
    }

    /// Feeds the real frame interval to dynamic resolution (engine.ts adaptResolution).
    public func recordFrameInterval(_ dt: Double) {
        guard settings.dynamicResolution else { return }
        let floor = min(1, Double(Self.minRenderScale / settings.renderScale))
        dynamicResolution.update(dt: dt, budget: 1 / settings.targetFps, floor: floor)
    }

    /// Starts a frame for an output of the given size: (re)allocates the scene targets and picks the jitter.
    public func beginFrame(outputWidth: Int, outputHeight: Int) throws -> Frame {
        let size = sceneSize(outputWidth: outputWidth, outputHeight: outputHeight)
        if targets?.matches(width: size.width, height: size.height) != true {
            targets = try PostTargets(device: device, width: size.width, height: size.height, settings: settings)
            resetHistory = true
        }
        let jitter = temporal == nil ? .zero : PostTemporal.jitter(frame: frameIndex)
        return Frame(targets: targets!.scene, jitterPixels: jitter, outputWidth: outputWidth, outputHeight: outputHeight)
    }

    /// Encodes every post pass of `frame` and writes display colour into `output`.
    public func encode(commandBuffer: any MTLCommandBuffer, frame: Frame, camera: Camera, output: any MTLTexture) throws {
        guard let t = targets else { return }
        PostPipelines.profiler = profiler
        defer {
            PostPipelines.profiler = nil
            profiler?.endFrame(commandBuffer)
        }
        let scene = t.scene
        let jittered = frame.jittered(camera.projection)
        let viewProjection = camera.projection * camera.view
        var view = IVPostView(
            projection: jittered,
            inverseProjection: jittered.inverse,
            cameraWorld: camera.view.inverse,
            view: camera.view,
            viewProjectionNoJitter: viewProjection,
            previousViewProjectionNoJitter: previousViewProjection ?? viewProjection,
            shadowViewProjection: camera.shadowViewProjection,
            cameraPosition: camera.position,
            near: camera.near,
            sceneSize: SIMD2(Float(scene.width), Float(scene.height)),
            far: camera.far,
            time: camera.time,
            jitterUV: frame.jitterPixels / SIMD2(Float(scene.width), Float(scene.height)),
            frameIndex: UInt32(frameIndex),
            _pad0: 0)
        previousViewProjection = viewProjection
        let viewLength = MemoryLayout<IVPostView>.stride

        var flags: UInt32 = 0
        // First, so that the profiler charges the end of the scene pass to this small pass, not to GTAO.
        if let bounds = t.ssrDepthBounds {
            PostPipelines.draw(commandBuffer, label: "SSR depth bounds", pipeline: pipelines.ssrDepthBounds, targets: [bounds]) { e in
                e.setFragmentTexture(scene.depth, index: 0)
            }
        }
        if let ao = t.ao {
            flags |= IV_POST_AO
            var params = IVGTAOParams(
                resolution: SIMD2(Float(ao.width), Float(ao.height)), radius: 0.6, thickness: 1.2,
                temporalDirection: temporal != nil ? PostKernels.temporalRotations[frameIndex % 6] / 360 : 0,
                temporalOffset: temporal != nil ? PostKernels.spatialOffsets[frameIndex % 4] : 1,
                scale: 1, halfResolution: ao.width < scene.width ? 1 : 0, samples: settings.aoSamples,
                _pad0: 0, _pad1: 0, _pad2: 0)
            PostPipelines.draw(commandBuffer, label: "GTAO", pipeline: pipelines.gtao, targets: [ao],
                               clear: MTLClearColor(red: 1, green: 1, blue: 1, alpha: 1)) { e in
                e.setFragmentBytes(&view, length: viewLength, index: 0)
                e.setFragmentBytes(&params, length: MemoryLayout<IVGTAOParams>.stride, index: 1)
                e.setFragmentTexture(scene.depth, index: 0)
                e.setFragmentTexture(scene.normal, index: 1)
            }
        }
        if let ssr = t.ssr, let blur = t.ssrBlur, let bounds = t.ssrDepthBounds {
            flags |= IV_POST_SSR
            encodeSSR(commandBuffer, view: &view, scene: scene, ssr: ssr, blur: blur, bounds: bounds)
        }
        if let rays = t.godrays, let blurH = t.shaftsH, let blurV = t.shaftsV, let shadowMap = camera.shadowMap,
           settings.shadowMapSize > 0, lighting.volumetric > 0 {
            flags |= IV_POST_GODRAYS
            encodeGodrays(commandBuffer, view: &view, camera: camera, scene: scene, shadowMap: shadowMap,
                          rays: rays, blurH: blurH, blurV: blurV)
        }

        // Composite at the scene size, with camera motion for the temporal pass.
        let shaft = lighting.sunColor * (lighting.sunIntensity * 0.22)
        var composite = IVPostCompositeParams(shaftColor: shaft, volumetric: lighting.volumetric,
                                              shaftFadeStart: Self.shaftFadeStart, shaftFadeEnd: Self.shaftFadeEnd,
                                              ssrMips: Float((t.ssrBlur?.mipmapLevelCount ?? 1) - 1), flags: flags)
        PostPipelines.draw(commandBuffer, label: "post composite", pipeline: pipelines.composite,
                           targets: [t.composite, t.motion]) { e in
            e.setFragmentBytes(&view, length: viewLength, index: 0)
            e.setFragmentBytes(&composite, length: MemoryLayout<IVPostCompositeParams>.stride, index: 1)
            e.setFragmentTexture(scene.color, index: 0)
            e.setFragmentTexture(scene.depth, index: 1)
            e.setFragmentTexture(scene.metalRough, index: 2)
            e.setFragmentTexture(t.ao ?? t.composite, index: 3)
            e.setFragmentTexture(t.ssrBlur ?? t.composite, index: 4)
            e.setFragmentTexture(t.shaftsV ?? t.composite, index: 5)
        }

        var hdr: any MTLTexture = t.composite
        if let temporal {
            hdr = try temporal.resolve(commandBuffer: commandBuffer, color: t.composite, depth: scene.depth, motion: t.motion,
                                       outputWidth: frame.outputWidth, outputHeight: frame.outputHeight,
                                       jitterPixels: frame.jitterPixels, reset: resetHistory)
        }
        resetHistory = false

        var bloomTexture: (any MTLTexture)?
        if settings.bloom {
            bloomTexture = try encodeBloom(commandBuffer, input: hdr, sceneWidth: scene.width, sceneHeight: scene.height)
        }

        var out = IVPostOutputParams(exposure: lighting.exposure, vignetteInner: 0.35, vignetteOuter: 0.85, vignetteStrength: 0.78,
                                     grainIntensity: settings.filmGrain ? 0.055 : 0, time: camera.time,
                                     flags: bloomTexture == nil ? 0 : IV_POST_BLOOM, _pad0: 0)
        let outputPipeline = try pipelines.output(format: output.pixelFormat)
        PostPipelines.draw(commandBuffer, label: "post output", pipeline: outputPipeline, targets: [output]) { e in
            e.setFragmentBytes(&out, length: MemoryLayout<IVPostOutputParams>.stride, index: 0)
            e.setFragmentTexture(hdr, index: 0)
            e.setFragmentTexture(bloomTexture ?? hdr, index: 1)
        }
        frameIndex += 1
    }

    // MARK: - Passes

    private func encodeSSR(_ commandBuffer: any MTLCommandBuffer, view: inout IVPostView, scene: SceneTargets,
                           ssr: any MTLTexture, blur: any MTLTexture, bounds: any MTLTexture) {
        var params = IVSSRParams(resolution: SIMD2(Float(ssr.width), Float(ssr.height)), maxDistance: 14, thickness: 0.35,
                                 intensity: 0.8, maxLuminance: 10, quality: 0.5, _pad0: 0)
        PostPipelines.draw(commandBuffer, label: "SSR", pipeline: pipelines.ssr, targets: [ssr],
                           clear: MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)) { e in
            e.setFragmentBytes(&view, length: MemoryLayout<IVPostView>.stride, index: 0)
            e.setFragmentBytes(&params, length: MemoryLayout<IVSSRParams>.stride, index: 1)
            e.setFragmentTexture(scene.color, index: 0)
            e.setFragmentTexture(scene.depth, index: 1)
            e.setFragmentTexture(scene.normal, index: 2)
            e.setFragmentTexture(scene.metalRough, index: 3)
            e.setFragmentTexture(bounds, index: 4)
        }
        // Mip 0 is a copy; mip i a box blur of the SSR target with taps i texels apart.
        for level in 0..<blur.mipmapLevelCount {
            var box = IVBoxBlurParams(separation: Float(level), size: 2, _pad0: 0, _pad1: 0)
            PostPipelines.draw(commandBuffer, label: "SSR blur \(level)", pipeline: level == 0 ? pipelines.copy : pipelines.boxBlur,
                               targets: [blur], level: level) { e in
                e.setFragmentBytes(&box, length: MemoryLayout<IVBoxBlurParams>.stride, index: 0)
                e.setFragmentTexture(ssr, index: 0)
            }
        }
    }

    private func encodeGodrays(_ commandBuffer: any MTLCommandBuffer, view: inout IVPostView, camera: Camera,
                               scene: SceneTargets, shadowMap: any MTLTexture, rays: any MTLTexture,
                               blurH: any MTLTexture, blurV: any MTLTexture) {
        let planes = Self.outsidePlanes(camera.shadowViewProjection)
        // pipeline.ts: (0.012 + fog density x 1.6) x shaft boost; GodraysNode divides by 100.
        let density = (0.012 + lighting.fogDensity * 1.6) * lighting.shaftDensity / 100
        var params = IVGodraysParams(
            planes: (planes[0], planes[1], planes[2], planes[3], planes[4], planes[5]),
            density: density, maxDensity: 0.25 + 0.5 * lighting.volumetric, distanceAttenuation: 1.5,
            shadowNear: SunShadow.near, shadowFar: SunShadow.distance * 2, raymarchSteps: settings.godraySteps,
            resolution: SIMD2(Float(rays.width), Float(rays.height)))
        PostPipelines.draw(commandBuffer, label: "godrays", pipeline: pipelines.godrays, targets: [rays],
                           clear: MTLClearColor(red: 1, green: 1, blue: 1, alpha: 1)) { e in
            e.setFragmentBytes(&view, length: MemoryLayout<IVPostView>.stride, index: 0)
            e.setFragmentBytes(&params, length: MemoryLayout<IVGodraysParams>.stride, index: 1)
            e.setFragmentTexture(scene.depth, index: 0)
            e.setFragmentTexture(shadowMap, index: 1)
        }
        // bilateralBlur(rays, sigma 3, sigma colour 0.1) at rays.resolutionScale of the rays target.
        let coefficients = PostKernels.gaussian(radius: 3 * 2 + 3)
        for (source, target, direction) in [(rays, blurH, SIMD2<Float>(1, 0)), (blurH, blurV, SIMD2<Float>(0, 1))] {
            var p = IVBilateralParams(invSize: SIMD2(1 / Float(target.width), 1 / Float(target.height)), direction: direction,
                                      sigmaColorFactor: -0.5 / (0.1 * 0.1), kernelSize: UInt32(coefficients.count),
                                      _pad0: 0, _pad1: 0, coefficients: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
            withUnsafeMutableBytes(of: &p.coefficients) { raw in
                let f = raw.bindMemory(to: Float.self)
                for (i, c) in coefficients.enumerated() { f[i] = c }
            }
            PostPipelines.draw(commandBuffer, label: direction.x > 0 ? "shaft blur H" : "shaft blur V", pipeline: pipelines.bilateral, targets: [target]) { e in
                e.setFragmentBytes(&p, length: MemoryLayout<IVBilateralParams>.stride, index: 0)
                e.setFragmentTexture(source, index: 0)
            }
        }
    }

    /// The web blooms the TRAA output at the scene size, so the mip chain is sized from the scene, not
    /// from the upscaled `input`.
    private func encodeBloom(_ commandBuffer: any MTLCommandBuffer, input: any MTLTexture, sceneWidth: Int,
                             sceneHeight: Int) throws -> any MTLTexture {
        let chain = try targets!.bloom(device: device, width: sceneWidth, height: sceneHeight)
        var high = IVBloomParams()
        high.threshold = 1
        high.smoothWidth = 0.01
        PostPipelines.draw(commandBuffer, label: "bloom high pass", pipeline: pipelines.bloomHighPass, targets: [chain.bright]) { e in
            e.setFragmentBytes(&high, length: MemoryLayout<IVBloomParams>.stride, index: 0)
            e.setFragmentTexture(input, index: 0)
        }
        var source = chain.bright
        for level in 0..<Self.bloomMips {
            let (center, taps) = PostKernels.bloomTaps(radius: Self.bloomKernels[level])
            var p = IVBloomParams()
            p.invSize = SIMD2(1 / Float(chain.horizontal[level].width), 1 / Float(chain.horizontal[level].height))
            p.centerWeight = center
            p.kernelTaps = UInt32(taps.count)
            withUnsafeMutableBytes(of: &p.offsetsWeights) { raw in
                let f = raw.bindMemory(to: Float.self)
                for (i, tap) in taps.enumerated() {
                    f[i * 2] = tap.x
                    f[i * 2 + 1] = tap.y
                }
            }
            for (input, target, direction) in [(source, chain.horizontal[level], SIMD2<Float>(1, 0)),
                                               (chain.horizontal[level], chain.vertical[level], SIMD2<Float>(0, 1))] {
                p.direction = direction
                PostPipelines.draw(commandBuffer, label: "bloom blur \(level)", pipeline: pipelines.bloomBlur, targets: [target]) { e in
                    e.setFragmentBytes(&p, length: MemoryLayout<IVBloomParams>.stride, index: 0)
                    e.setFragmentTexture(input, index: 0)
                }
            }
            source = chain.vertical[level]
        }
        var composite = IVBloomParams()
        composite.strength = 0.22 * lighting.bloom
        composite.radius = 0.6
        PostPipelines.draw(commandBuffer, label: "bloom composite", pipeline: pipelines.bloomComposite,
                           targets: [chain.horizontal[0]]) { e in
            e.setFragmentBytes(&composite, length: MemoryLayout<IVBloomParams>.stride, index: 0)
            for i in 0..<Self.bloomMips { e.setFragmentTexture(chain.vertical[i], index: i) }
        }
        return chain.horizontal[0]
    }

    /// GodraysNode._updateLightParams for a directional light: the shadow camera's frustum planes with
    /// their normals flipped, so dot(p, n) + w > 0 outside. Clip space x, y in [-1, 1], z in [0, 1].
    static func outsidePlanes(_ m: simd_float4x4) -> [SIMD4<Float>] {
        let t = m.transpose
        let r0 = t.columns.0, r1 = t.columns.1, r2 = t.columns.2, r3 = t.columns.3
        let inside = [r3 + r0, r3 - r0, r3 + r1, r3 - r1, r2, r3 - r2]
        return inside.map { p in
            let n = simd_length(SIMD3(p.x, p.y, p.z))
            return -p / n
        }
    }
}
