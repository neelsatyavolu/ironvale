// M3 map renderer (PLAN.md 3.3): static level geometry from the map-export render capture with
// the generic PBR shader (Shaders/MapPBR.metal), image-based light, the sun shadow, punctual and
// hemisphere lights, the engine's fog and the backdrop, rendered into an rgba16Float target with
// reverse-Z depth at a fixed internal size, then tone mapped by PostPass.
// Lighting set-up follows src/render/engine.ts setLighting at commit cbe0add.
import Foundation
import IronvaleMapData
import IronvaleRender
import Metal
import QuartzCore
import ShaderTypes
import os
import simd

@MainActor
public final class MapRenderer {
    public struct Settings: Sendable {
        public var internalWidth: Int
        public var internalHeight: Int
        public var shadowMapSize: Int
        public var fovDegrees: Float

        /// The web's High preset at a 2560x1600 internal size: 4096 shadow map, 2k textures, FOV 78.
        public static let high = Settings(internalWidth: 2560, internalHeight: 1600, shadowMapSize: 4096, fovDegrees: 78)

        public init(internalWidth: Int, internalHeight: Int, shadowMapSize: Int, fovDegrees: Float) {
            self.internalWidth = internalWidth
            self.internalHeight = internalHeight
            self.shadowMapSize = shadowMapSize
            self.fovDegrees = fovDegrees
        }
    }

    /// engine.ts: PerspectiveCamera(75, 1, 0.04, 900).
    public static let near: Float = 0.04
    public static let far: Float = 900
    /// engine.ts BACKDROP_GAIN: a tone-mapped panorama is lifted to survive the second tone map.
    static let backdropGain: Float = 1.5

    private static let logger = Logger(subsystem: "dev.n3el.ironvale", category: "map-render")

    public let settings: Settings
    public let assets: MapAssets
    public let post: PostPass
    public private(set) var skipped: [(path: String, reason: GenericSkipReason)] = []
    public var drawCount: Int { draws.count }
    public private(set) var triangleCount = 0
    /// Drawn inside the shadow and scene passes (M7a: the match's soldiers, IronvaleCharacters SoldierLayer).
    public var layers: [any SceneLayer] = []
    /// M9 post chain (IronvaleRender/Post); when set, the scene pass writes its MRT at the chain's scene
    /// size and the chain replaces PostPass. Layer pipelines must then declare `sceneColorFormats`.
    public let postChain: PostChain?
    /// Colour attachment formats of the scene pass with the post chain (PostTypes.h IV_SCENE_ATTACHMENT_*).
    public static let sceneColorFormats: [MTLPixelFormat] = [.rgba16Float, .rgba8Unorm, .rg8Unorm]
    private var lastFrameTime: Double?

    private let device: any MTLDevice
    private let buffer: any MTLBuffer
    private let identityInstance: any MTLBuffer
    private let environment: EnvironmentMap
    private let panorama: any MTLTexture
    private let hdrTarget: any MTLTexture
    private let depthTarget: any MTLTexture
    private let shadowMap: any MTLTexture
    private let shadow: SunShadow
    private let pipelines: Pipelines
    private let draws: [Draw]
    private var lights: [IVLight]
    private let lighting: Lighting
    /// float4 rows the surface programs read (Shaders/MapSurface.h IV_RY_*); one zero row when unused.
    private let programParams: [SIMD4<Float>]

    private struct Pipelines {
        let scene: [PipelineKey: any MTLRenderPipelineState]
        let shadow: any MTLRenderPipelineState
        /// Depth-only pass over the plain opaque draws, so the surface programs shade each pixel once.
        let depthPrepass: any MTLRenderPipelineState
        let sky: any MTLRenderPipelineState
        let depthStates: [Int: any MTLDepthStencilState]
        let shadowDepth: any MTLDepthStencilState
        let skyDepth: any MTLDepthStencilState
    }

    private struct Lighting {
        var sunDirection: SIMD3<Float>
        var sunColor: SIMD3<Float>
        var hemiSky: SIMD3<Float>
        var hemiGround: SIMD3<Float>
        var environmentIntensity: Float
        var backgroundIntensity: Float
        var rotation: Float
        var fogColor: SIMD3<Float>
        var fogDensity: Float
        var fogSunTint: SIMD3<Float>
        var fogSunTintStrength: Float
        var fogHeightFalloff: Float
        var fogBaseHeight: Float
    }

    private enum Pass: Hashable { case opaque, alphaTest, transparent }

    /// One specialisation of ivMapVertex / ivMapFragment (function constants 0 - 4 of MapPBR.metal).
    private struct PipelineKey: Hashable {
        var pass: Pass
        var program: SurfaceProgram
        var skyVisibility: Bool
        var lampLit: Bool
        var livery: Bool
    }

    private struct Draw {
        let path: String
        let pass: Pass
        let key: PipelineKey
        let livery: Int?
        let renderOrder: Int
        let castShadow: Bool
        let position: Int
        let normal: Int
        let uv: Int
        let color: Int?
        let index: (offset: Int, type: MTLIndexType)?
        let elementCount: Int
        let instances: (offset: Int, count: Int)?
        var uniforms: IVDrawUniforms
        var material: IVMaterialUniforms
        let textures: [any MTLTexture]
        let cull: MTLCullMode
        let depthKey: Int
        let depthBias: (units: Float, slope: Float)?
        let center: SIMD3<Float>

        /// Plain opaque draws that write depth without a bias take part in the depth prepass.
        var prepass: Bool { pass == .opaque && depthBias == nil && depthKey == MapRenderer.depthKey(test: true, write: true) }
    }

    public init(assets: MapAssets, device: any MTLDevice, library: any MTLLibrary, settings: Settings = .high,
                post postSettings: PostSettings? = nil) throws {
        self.assets = assets
        self.settings = settings
        self.device = device
        guard let queue = device.makeCommandQueue() else { throw RenderError.allocation("load queue") }
        let renderDir = assets.package.appending(path: "render")
        let bytes = try Data(contentsOf: renderDir.appending(path: "buffers.bin"))
        let scene = try MapRenderScene.load(sceneJSON: Data(contentsOf: renderDir.appending(path: "scene.json")), bufferLength: bytes.count)
        guard let buffer = bytes.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }),
              let identity = device.makeBuffer(length: MemoryLayout<simd_float4x4>.stride, options: .storageModeShared)
        else { throw RenderError.allocation("geometry buffer") }
        buffer.label = "\(scene.mapId) buffers.bin"
        identity.contents().storeBytes(of: matrix_identity_float4x4, as: simd_float4x4.self)
        self.buffer = buffer
        identityInstance = identity

        let setup = assets.meta.lighting
        environment = try EnvironmentMap(hdr: RadianceHDR.load(assets.assetFile(id: setup.hdri, key: "hdr@2k")),
                                         device: device, library: library, queue: queue)
        let textures = TextureLoader(device: device)
        panorama = try textures.load(assets.assetFile(id: setup.hdri, key: "sky"), srgb: true)

        let sun = SIMD3<Float>(setup.sunDirection.map(Float.init))
        shadow = SunShadow(sunDirection: sun, mapSize: settings.shadowMapSize)
        var lighting = Lighting(
            sunDirection: simd_normalize(sun),
            sunColor: RenderMath.linearFromSRGBHex(setup.sunColor) * Float(setup.sunIntensity),
            hemiSky: .zero, hemiGround: .zero,
            environmentIntensity: Float(setup.skyIntensity),
            backgroundIntensity: Float(setup.skyIntensity) * Self.backdropGain,
            rotation: Float(setup.hdriRotation),
            fogColor: RenderMath.linearFromSRGBHex(setup.fog.color),
            fogDensity: Float(setup.fog.density),
            fogSunTint: setup.fog.sunTint.map(RenderMath.linearFromSRGBHex) ?? .zero,
            fogSunTintStrength: setup.fog.sunTint == nil ? 0 : Float(setup.fog.sunTintStrength ?? 0),
            fogHeightFalloff: Float(setup.fog.heightFalloff ?? 0),
            fogBaseHeight: Float(setup.fog.baseHeight ?? 0)
        )
        var lights: [IVLight] = []
        for light in scene.lights {
            let color = RenderMath.linearHex(light.color ?? 0xffffff) * Float(light.intensity)
            let position = SIMD3<Float>(light.position.map(Float.init))
            switch light.type {
            case "HemisphereLight":
                lighting.hemiSky += color
                lighting.hemiGround += RenderMath.linearHex(light.groundColor ?? 0) * Float(light.intensity)
            case "PointLight", "SpotLight":
                guard lights.count < Int(IV_MAX_LIGHTS) else {
                    Self.logger.error("More than \(IV_MAX_LIGHTS) punctual lights; extra ones dropped")
                    continue
                }
                let spot = light.type == "SpotLight"
                let target = SIMD3<Float>((light.target ?? light.position).map(Float.init))
                let angle = Float(light.angle ?? .pi / 3)
                let penumbra = Float(light.penumbra ?? 0)
                lights.append(IVLight(
                    position: position, distance: Float(light.distance ?? 0), color: color, decay: Float(light.decay ?? 2),
                    direction: spot ? simd_normalize(position - target) : .zero,
                    coneCos: cos(angle), kind: spot ? IV_LIGHT_SPOT : IV_LIGHT_POINT,
                    penumbraCos: cos(angle * (1 - penumbra)), _pad0: 0, _pad1: 0))
            default:
                Self.logger.error("Unsupported light type \(light.type, privacy: .public) skipped")
            }
        }
        self.lights = lights
        self.lighting = lighting

        programParams = scene.programParams.map(RailyardProgramParams.pack) ?? [.zero]
        let railyardSky = scene.materials.contains { $0.program.flatMap(SurfaceProgram.init(name:)) == .railyardSky }
        if railyardSky, scene.programParams == nil {
            throw MapRenderScene.LoadError.wrongFormat("scene.json has the railyard sky but no programParams", 1)
        }
        post = try PostPass(device: device, library: library, outputFormat: .bgra8Unorm, exposure: Float(setup.exposure))
        postChain = try postSettings.map {
            try PostChain(device: device, library: library, settings: $0, lighting: PostChain.Lighting(
                exposure: Float(setup.exposure), sunColor: RenderMath.linearFromSRGBHex(setup.sunColor),
                sunIntensity: Float(setup.sunIntensity), fogDensity: Float(setup.fog.density),
                volumetric: Float(setup.volumetric), shaftDensity: Float(setup.shaftDensity ?? 1), bloom: Float(setup.bloom)))
        }
        (hdrTarget, depthTarget, shadowMap) = try Self.makeTargets(device: device, settings: settings)

        var skipped: [(String, GenericSkipReason)] = []
        var triangles = 0
        var draws: [Draw] = []
        let white = try textures.solid(SIMD4(255, 255, 255, 255))
        for mesh in scene.meshes {
            guard case .single(let materialIndex) = mesh.material else {
                Self.logger.error("Multi-material mesh \(mesh.path, privacy: .public) skipped")
                continue
            }
            let material = scene.materials[materialIndex]
            if material.program.flatMap(SurfaceProgram.init(name:)) == .railyardSky { continue }  // the sky pass draws it
            if let reason = material.genericSkipReason {
                skipped.append((mesh.path, reason))
                continue
            }
            let draw = try Self.makeDraw(mesh: mesh, material: material, scene: scene, bytes: bytes, assets: assets,
                                         textures: textures, white: white)
            triangles += draw.elementCount / 3 * (draw.instances?.count ?? 1)
            draws.append(draw)
        }
        pipelines = try Self.makePipelines(device: device, library: library, keys: Set(draws.map(\.key)), railyardSky: railyardSky,
                                           mrt: postSettings != nil)
        // Opaque first in renderOrder, then alpha-tested; transparent ones are sorted per frame.
        self.draws = draws.sorted { ($0.pass == .transparent ? 1 : 0, $0.renderOrder) < ($1.pass == .transparent ? 1 : 0, $1.renderOrder) }
        self.skipped = skipped
        triangleCount = triangles
        Self.logger.info("Map \(scene.mapId, privacy: .public): \(draws.count) draws, \(triangles) triangles, \(skipped.count) skipped, \(lights.count) lights")
    }

    // MARK: - Frame

    /// Encodes one frame for `pose` and tone maps it into `output` (a bgra8Unorm texture).
    public func encode(commandBuffer: any MTLCommandBuffer, pose: CameraPose, time: Double, output: any MTLTexture) {
        if let postChain {
            do {
                try encodeWithPostChain(postChain, commandBuffer: commandBuffer, pose: pose, time: time, output: output)
            } catch {
                Self.logger.error("Post chain frame failed: \(String(describing: error), privacy: .public)")
            }
            return
        }
        let aspect = Float(settings.internalWidth) / Float(settings.internalHeight)
        let projection = RenderMath.perspectiveReverseZ(fovYRadians: settings.fovDegrees * .pi / 180, aspect: aspect,
                                                        near: Self.near, far: Self.far)
        var frame = frameUniforms(pose: pose, time: time, projection: projection)
        for layer in layers { layer.prepare(viewProjection: frame.viewProjection, eye: pose.eye) }
        if settings.shadowMapSize > 0 { encodeShadow(commandBuffer: commandBuffer, frame: &frame) }
        encodeScene(commandBuffer: commandBuffer, frame: &frame, eye: pose.eye,
                    targets: (hdrTarget, nil, nil, depthTarget))
        post.encode(commandBuffer: commandBuffer, source: hdrTarget, target: output)
    }

    /// The M9 frame: scene MRT at the chain's (dynamic) scene size with a jittered projection, then
    /// every post pass of pipeline.ts into `output`.
    private func encodeWithPostChain(_ chain: PostChain, commandBuffer: any MTLCommandBuffer, pose: CameraPose,
                                     time: Double, output: any MTLTexture) throws {
        if let last = lastFrameTime { chain.recordFrameInterval(time - last) }
        lastFrameTime = time
        let post = try chain.beginFrame(outputWidth: output.width, outputHeight: output.height)
        let aspect = Float(output.width) / Float(output.height)
        let projection = RenderMath.perspectiveReverseZ(fovYRadians: settings.fovDegrees * .pi / 180, aspect: aspect,
                                                        near: Self.near, far: Self.far)
        var frame = frameUniforms(pose: pose, time: time, projection: post.jittered(projection))
        for layer in layers { layer.prepare(viewProjection: frame.viewProjection, eye: pose.eye) }
        if settings.shadowMapSize > 0 { encodeShadow(commandBuffer: commandBuffer, frame: &frame) }
        let t = post.targets
        encodeScene(commandBuffer: commandBuffer, frame: &frame, eye: pose.eye, targets: (t.color, t.normal, t.metalRough, t.depth))
        let camera = PostChain.Camera(projection: projection, view: pose.view, position: pose.eye, near: Self.near, far: Self.far,
                                      shadowViewProjection: frame.shadowViewProjection,
                                      shadowMap: settings.shadowMapSize > 0 ? shadowMap : nil, time: Float(time))
        try chain.encode(commandBuffer: commandBuffer, frame: post, camera: camera, output: output)
    }

    private func frameUniforms(pose: CameraPose, time: Double, projection: simd_float4x4) -> IVFrameUniforms {
        let view = pose.view
        let viewProjection = projection * view
        return IVFrameUniforms(
            viewProjection: viewProjection,
            view: view,
            inverseViewProjection: viewProjection.inverse,
            shadowViewProjection: shadow.viewProjection(cameraPosition: pose.eye, forward: pose.forward),
            cameraPosition: pose.eye,
            time: Float(time),
            sunDirection: lighting.sunDirection,
            environmentIntensity: lighting.environmentIntensity,
            sunColor: lighting.sunColor,
            backgroundIntensity: lighting.backgroundIntensity,
            fogColor: lighting.fogColor,
            fogDensity: lighting.fogDensity,
            fogSunTint: lighting.fogSunTint,
            fogSunTintStrength: lighting.fogSunTintStrength,
            hemiSkyColor: lighting.hemiSky,
            fogHeightFalloff: lighting.fogHeightFalloff,
            hemiGroundColor: lighting.hemiGround,
            fogBaseHeight: lighting.fogBaseHeight,
            environmentRotation: lighting.rotation,
            environmentMaxLod: environment.maxLod,
            shadowBias: SunShadow.bias,
            shadowNormalBias: SunShadow.normalBias,
            shadowTexelWorld: shadow.texelWorld,
            shadowEnabled: settings.shadowMapSize > 0 ? 1 : 0,
            lightCount: UInt32(lights.count),
            _pad0: 0
        )
    }

    private func bindGeometry(_ encoder: any MTLRenderCommandEncoder, _ draw: Draw, positionsOnly: Bool) {
        encoder.setVertexBuffer(buffer, offset: draw.position, index: Int(IV_BUFFER_POSITION))
        if !positionsOnly {
            encoder.setVertexBuffer(buffer, offset: draw.normal, index: Int(IV_BUFFER_NORMAL))
            encoder.setVertexBuffer(buffer, offset: draw.uv, index: Int(IV_BUFFER_UV))
            encoder.setVertexBuffer(buffer, offset: draw.color ?? draw.position, index: Int(IV_BUFFER_COLOR))
        }
        if let instances = draw.instances {
            encoder.setVertexBuffer(buffer, offset: instances.offset, index: Int(IV_BUFFER_INSTANCES))
        } else {
            encoder.setVertexBuffer(identityInstance, offset: 0, index: Int(IV_BUFFER_INSTANCES))
        }
        var uniforms = draw.uniforms
        encoder.setVertexBytes(&uniforms, length: MemoryLayout<IVDrawUniforms>.stride, index: Int(IV_BUFFER_DRAW))
    }

    private func issue(_ encoder: any MTLRenderCommandEncoder, _ draw: Draw) {
        let instanceCount = draw.instances?.count ?? 1
        if let index = draw.index {
            encoder.drawIndexedPrimitives(type: .triangle, indexCount: draw.elementCount, indexType: index.type,
                                          indexBuffer: buffer, indexBufferOffset: index.offset, instanceCount: instanceCount)
        } else {
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: draw.elementCount, instanceCount: instanceCount)
        }
    }

    private func encodeShadow(commandBuffer: any MTLCommandBuffer, frame: inout IVFrameUniforms) {
        let pass = MTLRenderPassDescriptor()
        pass.depthAttachment.texture = shadowMap
        pass.depthAttachment.loadAction = .clear
        pass.depthAttachment.clearDepth = 1
        pass.depthAttachment.storeAction = .store
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.label = "sun shadow"
        encoder.setRenderPipelineState(pipelines.shadow)
        encoder.setDepthStencilState(pipelines.shadowDepth)
        encoder.setCullMode(.none)
        encoder.setDepthClipMode(.clamp)
        encoder.setVertexBytes(&frame, length: MemoryLayout<IVFrameUniforms>.stride, index: Int(IV_BUFFER_FRAME))
        for draw in draws where draw.castShadow && draw.pass != .transparent {
            bindGeometry(encoder, draw, positionsOnly: true)
            issue(encoder, draw)
        }
        for layer in layers { layer.encodeShadow(encoder) }
        encoder.endEncoding()
    }

    private func encodeScene(commandBuffer: any MTLCommandBuffer, frame: inout IVFrameUniforms, eye: SIMD3<Float>,
                             targets: (color: any MTLTexture, normal: (any MTLTexture)?, metalRough: (any MTLTexture)?,
                                       depth: any MTLTexture)) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = targets.color
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        pass.colorAttachments[0].storeAction = .store
        for (index, texture) in [(Int(IV_SCENE_ATTACHMENT_NORMAL), targets.normal), (Int(IV_SCENE_ATTACHMENT_METALROUGH), targets.metalRough)] {
            guard let texture else { continue }
            pass.colorAttachments[index].texture = texture
            pass.colorAttachments[index].loadAction = .clear
            pass.colorAttachments[index].clearColor = MTLClearColor(red: 0.5, green: 0.5, blue: 1, alpha: 1)
            pass.colorAttachments[index].storeAction = .store
        }
        pass.depthAttachment.texture = targets.depth
        pass.depthAttachment.loadAction = .clear
        pass.depthAttachment.clearDepth = 0
        // The post chain reads the scene depth.
        pass.depthAttachment.storeAction = targets.normal == nil ? .dontCare : .store
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.label = "scene"
        encoder.setFrontFacing(.counterClockwise)
        encoder.setVertexBytes(&frame, length: MemoryLayout<IVFrameUniforms>.stride, index: Int(IV_BUFFER_FRAME))
        encoder.setFragmentBytes(&frame, length: MemoryLayout<IVFrameUniforms>.stride, index: Int(IV_BUFFER_FRAME))
        var lightData = lights.isEmpty ? [IVLight](repeating: IVLight(), count: 1) : lights
        encoder.setFragmentBytes(&lightData, length: MemoryLayout<IVLight>.stride * lightData.count, index: Int(IV_BUFFER_LIGHTS))
        var params = programParams
        encoder.setFragmentBytes(&params, length: MemoryLayout<SIMD4<Float>>.stride * params.count, index: Self.programParamsIndex)
        encoder.setFragmentTexture(environment.texture, index: Int(IV_TEXTURE_ENVIRONMENT))
        encoder.setFragmentTexture(shadowMap, index: Int(IV_TEXTURE_SHADOW))

        // Depth prepass: the same vertex function, no fragment stage. The colour pass then passes on
        // equal depth (greaterEqual), so only the front surface runs its program.
        encoder.setRenderPipelineState(pipelines.depthPrepass)
        for draw in draws where draw.prepass {
            encoder.setDepthStencilState(pipelines.depthStates[draw.depthKey])
            encoder.setCullMode(draw.cull)
            encoder.setDepthBias(0, slopeScale: 0, clamp: 0)
            bindGeometry(encoder, draw, positionsOnly: false)
            issue(encoder, draw)
        }
        let opaque = draws.filter { $0.pass != .transparent }
        for draw in opaque { encodeDraw(encoder, draw) }
        for layer in layers { layer.encodeScene(encoder) }

        encoder.setRenderPipelineState(pipelines.sky)
        encoder.setDepthStencilState(pipelines.skyDepth)
        encoder.setCullMode(.none)
        encoder.setDepthBias(0, slopeScale: 0, clamp: 0)
        encoder.setFragmentTexture(panorama, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)

        // three sorts transparent objects back to front by depth.
        let transparent = draws.filter { $0.pass == .transparent }
            .sorted { simd_distance_squared($0.center, eye) > simd_distance_squared($1.center, eye) }
        for draw in transparent { encodeDraw(encoder, draw) }
        encoder.endEncoding()
    }

    private func encodeDraw(_ encoder: any MTLRenderCommandEncoder, _ draw: Draw) {
        guard let pipeline = pipelines.scene[draw.key] else { return }
        encoder.setRenderPipelineState(pipeline)
        encoder.setDepthStencilState(pipelines.depthStates[draw.depthKey])
        encoder.setCullMode(draw.cull)
        if let bias = draw.depthBias {
            encoder.setDepthBias(bias.units, slopeScale: bias.slope, clamp: 0)
        } else {
            encoder.setDepthBias(0, slopeScale: 0, clamp: 0)
        }
        bindGeometry(encoder, draw, positionsOnly: false)
        var material = draw.material
        encoder.setFragmentBytes(&material, length: MemoryLayout<IVMaterialUniforms>.stride, index: Int(IV_BUFFER_MATERIAL))
        for (slot, texture) in draw.textures.enumerated() {
            encoder.setFragmentTexture(texture, index: slot < 6 ? slot : Self.programTextureIndex)
        }
        if let livery = draw.livery { encoder.setVertexBuffer(buffer, offset: livery, index: Self.liveryIndex) }
        issue(encoder, draw)
    }

    // MARK: - Set-up

    private static func makeTargets(device: any MTLDevice, settings: Settings) throws -> (any MTLTexture, any MTLTexture, any MTLTexture) {
        func make(_ format: MTLPixelFormat, _ w: Int, _ h: Int, _ label: String) throws -> any MTLTexture {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: w, height: h, mipmapped: false)
            d.usage = [.renderTarget, .shaderRead]
            d.storageMode = .private
            guard let t = device.makeTexture(descriptor: d) else { throw RenderError.allocation(label) }
            t.label = label
            return t
        }
        let size = max(1, settings.shadowMapSize)
        return (try make(.rgba16Float, settings.internalWidth, settings.internalHeight, "scene colour"),
                try make(.depth32Float, settings.internalWidth, settings.internalHeight, "scene depth"),
                try make(.depth32Float, size, size, "sun shadow map"))
    }

    /// Slots beyond ShaderTypes.h, shared with Shaders/MapSurface.h.
    static let liveryIndex = 9
    static let programParamsIndex = 10
    static let programTextureIndex = 8

    private static func makePipelines(device: any MTLDevice, library: any MTLLibrary, keys: Set<PipelineKey>,
                                      railyardSky: Bool, mrt: Bool) throws -> Pipelines {
        /// With the post chain: the MRT formats; `surfaceData` false masks the normal and metal/rough writes.
        func attachments(_ d: MTLRenderPipelineDescriptor, surfaceData: Bool) {
            guard mrt else { return }
            for i in 1..<sceneColorFormats.count {
                d.colorAttachments[i].pixelFormat = sceneColorFormats[i]
                if !surfaceData { d.colorAttachments[i].writeMask = [] }
            }
        }
        func function(_ name: String) throws -> any MTLFunction {
            guard let f = library.makeFunction(name: name) else { throw RenderError.missingFunction(name) }
            return f
        }
        func specialised(_ name: String, _ key: PipelineKey) throws -> any MTLFunction {
            let constants = MTLFunctionConstantValues()
            var alphaTest = key.pass == .alphaTest
            var program = key.program.rawValue
            var skyVisibility = key.skyVisibility
            var lampLit = key.lampLit
            var livery = key.livery
            constants.setConstantValue(&alphaTest, type: .bool, index: 0)
            constants.setConstantValue(&program, type: .uint, index: 1)
            constants.setConstantValue(&skyVisibility, type: .bool, index: 2)
            constants.setConstantValue(&lampLit, type: .bool, index: 3)
            constants.setConstantValue(&livery, type: .bool, index: 4)
            return try library.makeFunction(name: name, constantValues: constants)
        }
        func scene(_ key: PipelineKey) throws -> any MTLRenderPipelineState {
            let d = MTLRenderPipelineDescriptor()
            let blend = key.pass == .transparent
            d.label = "map \(key.pass) program \(key.program)"
            d.vertexFunction = try specialised("ivMapVertex", key)
            d.fragmentFunction = try specialised("ivMapFragment", key)
            d.colorAttachments[0].pixelFormat = .rgba16Float
            d.depthAttachmentPixelFormat = .depth32Float
            attachments(d, surfaceData: true)
            if blend {
                // three NormalBlending, premultipliedAlpha false.
                let a: MTLRenderPipelineColorAttachmentDescriptor = d.colorAttachments[0]
                a.isBlendingEnabled = true
                a.sourceRGBBlendFactor = .sourceAlpha
                a.destinationRGBBlendFactor = .oneMinusSourceAlpha
                a.sourceAlphaBlendFactor = .one
                a.destinationAlphaBlendFactor = .oneMinusSourceAlpha
            }
            return try device.makeRenderPipelineState(descriptor: d)
        }
        let shadowDescriptor = MTLRenderPipelineDescriptor()
        shadowDescriptor.label = "sun shadow"
        shadowDescriptor.vertexFunction = try function("ivShadowVertex")
        shadowDescriptor.depthAttachmentPixelFormat = .depth32Float
        let skyDescriptor = MTLRenderPipelineDescriptor()
        skyDescriptor.label = "sky"
        skyDescriptor.vertexFunction = try function("ivSkyVertex")
        skyDescriptor.fragmentFunction = try function(railyardSky ? "ivSkyRailyardFragment" : "ivSkyFragment")
        skyDescriptor.colorAttachments[0].pixelFormat = .rgba16Float
        skyDescriptor.depthAttachmentPixelFormat = .depth32Float
        attachments(skyDescriptor, surfaceData: false)

        func depth(test: Bool, write: Bool, compare: MTLCompareFunction) throws -> any MTLDepthStencilState {
            let d = MTLDepthStencilDescriptor()
            d.depthCompareFunction = test ? compare : .always
            d.isDepthWriteEnabled = write
            guard let s = device.makeDepthStencilState(descriptor: d) else { throw RenderError.allocation("depth state") }
            return s
        }
        var states: [Int: any MTLDepthStencilState] = [:]
        for test in [false, true] {
            for write in [false, true] {
                states[depthKey(test: test, write: write)] = try depth(test: test, write: write, compare: .greaterEqual)
            }
        }
        var scenePipelines: [PipelineKey: any MTLRenderPipelineState] = [:]
        for key in keys { scenePipelines[key] = try scene(key) }
        return Pipelines(
            scene: scenePipelines,
            shadow: try device.makeRenderPipelineState(descriptor: shadowDescriptor),
            depthPrepass: try {
                let d = MTLRenderPipelineDescriptor()
                d.label = "map depth prepass"
                d.vertexFunction = try specialised("ivMapVertex", PipelineKey(pass: .opaque, program: .none, skyVisibility: false,
                                                                                lampLit: false, livery: false))
                d.colorAttachments[0].pixelFormat = .rgba16Float
                d.colorAttachments[0].writeMask = []
                d.depthAttachmentPixelFormat = .depth32Float
                attachments(d, surfaceData: false)
                return try device.makeRenderPipelineState(descriptor: d)
            }(),
            sky: try device.makeRenderPipelineState(descriptor: skyDescriptor),
            depthStates: states,
            shadowDepth: try depth(test: true, write: true, compare: .lessEqual),
            skyDepth: try depth(test: true, write: false, compare: .greaterEqual)
        )
    }

    nonisolated private static func depthKey(test: Bool, write: Bool) -> Int { (test ? 2 : 0) | (write ? 1 : 0) }

    private static func makeDraw(mesh: MapRenderScene.Mesh, material: MapRenderScene.Material, scene: MapRenderScene,
                                 bytes: Data, assets: MapAssets, textures: TextureLoader, white: any MTLTexture) throws -> Draw {
        let geometry = scene.geometries[mesh.geometry]
        func accessor(_ name: String) -> MapRenderScene.Accessor? { geometry.attributes[name].map { scene.accessors[$0] } }
        guard let position = accessor("position"), let normal = accessor("normal"), let uv = accessor("uv") else {
            throw MapRenderScene.LoadError.wrongFormat("mesh \(mesh.path) lacks position, normal or uv", 1)
        }
        let color = accessor("color").flatMap { $0.itemSize == 3 && $0.type == "f32" ? $0 : nil }
        var elementCount: Int
        var index: (offset: Int, type: MTLIndexType)?
        if let i = geometry.index.map({ scene.accessors[$0] }) {
            index = (i.offset, i.type == "u16" ? .uint16 : .uint32)
            elementCount = i.count
        } else {
            elementCount = position.count
        }
        if geometry.drawRange.count >= 0 { elementCount = min(elementCount, geometry.drawRange.count) }
        if geometry.drawRange.start > 0, let i = index {
            index = (i.offset + geometry.drawRange.start * (i.type == .uint16 ? 2 : 4), i.type)
        }

        let m = mesh.matrixWorld.map(Float.init)
        let model = simd_float4x4(columns: (SIMD4(m[0], m[1], m[2], m[3]), SIMD4(m[4], m[5], m[6], m[7]),
                                            SIMD4(m[8], m[9], m[10], m[11]), SIMD4(m[12], m[13], m[14], m[15])))
        let instances = mesh.instances.map { (scene.accessors[$0.matrices].offset, $0.count) }
        let livery = mesh.instances?.attributes?["livery"].map { scene.accessors[$0] }
        if let livery, livery.type != "f32" || livery.itemSize != 3 || livery.count < (mesh.instances?.count ?? 0) {
            throw MapRenderScene.LoadError.wrongFormat("mesh \(mesh.path) livery is not f32 x3 per instance", 1)
        }
        let program = material.program.flatMap(SurfaceProgram.init(name:)) ?? .none
        let center = Self.center(position: position, bytes: bytes, model: model)

        // Textures, in IV_TEXTURE_* slot order.
        let slots = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"]
        var bound: [any MTLTexture] = []
        var flags: UInt32 = 0
        var flipY = true
        for (i, slot) in slots.enumerated() {
            guard let t = material.maps[slot].map({ scene.textures[$0] }), let uri = t.uri, t.kind == "url" || t.kind == "png" else {
                bound.append(white)
                continue
            }
            let base = t.kind == "url" ? assets.publicRoot : assets.package.appending(path: "render")
            bound.append(try textures.load(base.appending(path: uri), srgb: t.colorSpace == "srgb"))
            flags |= 1 << UInt32(i)
            flipY = t.flipY
            if t.repeatUV != [1, 1] || t.offset != [0, 0] || t.rotation != 0 {
                logger.error("Texture transform on \(uri, privacy: .public) ignored (generic path)")
            }
        }
        if let slot = program.nodeTextureSlot {
            guard let t = material.nodeMaps?[slot].map({ scene.textures[$0] }), let uri = t.uri, t.kind == "url" || t.kind == "png" else {
                throw MapRenderScene.LoadError.wrongFormat("mesh \(mesh.path): program \(program) needs its \(slot) texture", 1)
            }
            let base = t.kind == "url" ? assets.publicRoot : assets.package.appending(path: "render")
            bound.append(try textures.load(base.appending(path: uri), srgb: t.colorSpace == "srgb"))
            flipY = t.flipY
        }
        if material.isUnlit { flags |= IV_MAT_UNLIT }
        if material.vertexColors == true, color != nil { flags |= IV_MAT_VERTEX_COLORS }
        if material.fog ?? true { flags |= IV_MAT_FOG }
        if flipY { flags |= IV_MAT_FLIP_Y }
        if mesh.receiveShadow { flags |= IV_MAT_RECEIVE_SHADOW }
        let side = material.side ?? 0
        if side == 2 { flags |= IV_MAT_DOUBLE_SIDED }
        if side == 1 { flags |= IV_MAT_BACK_SIDE }

        let base = material.hasNodeAlbedo ? MapRenderScene.Material.placeholderAlbedo : RenderMath.linearHex(material.color ?? 0xffffff)
        let emissive = RenderMath.linearHex(material.emissive ?? 0) * Float(material.emissiveIntensity ?? 1)
        let normalScale = material.normalScale ?? [1, 1]
        let uniforms = IVMaterialUniforms(
            baseColor: SIMD4(base, Float(material.opacity ?? 1)),
            emissive: emissive,
            roughness: Float(material.roughness ?? 1),
            normalScale: SIMD2(Float(normalScale[0]), Float(normalScale[1])),
            metalness: Float(material.metalness ?? 0),
            alphaTest: Float(material.alphaTest ?? 0),
            aoMapIntensity: Float(material.aoMapIntensity ?? 1),
            envMapIntensity: Float(material.envMapIntensity ?? 1),
            flags: flags,
            _pad0: 0
        )
        let pass: Pass = material.transparent == true ? .transparent : (material.alphaTest ?? 0) > 0 ? .alphaTest : .opaque
        let key = PipelineKey(pass: pass, program: program, skyVisibility: material.aoProgram == "skyVisibility",
                              lampLit: program.lampLit, livery: livery != nil)
        let bias: (Float, Float)? = material.polygonOffset == true
            // Reverse-Z: toward the camera is larger depth, so three's negative offsets become positive.
            ? (Float(-(material.polygonOffsetUnits ?? 0)), Float(-(material.polygonOffsetFactor ?? 0))) : nil
        return Draw(
            path: mesh.path, pass: pass, key: key, livery: livery?.offset, renderOrder: mesh.renderOrder, castShadow: mesh.castShadow,
            position: position.offset, normal: normal.offset, uv: uv.offset, color: color?.offset,
            index: index, elementCount: elementCount, instances: instances,
            uniforms: IVDrawUniforms(model: model, normalMatrix: RenderMath.normalMatrix(model),
                                     instanced: instances == nil ? 0 : 1, hasColor: color == nil ? 0 : 1, _pad0: 0, _pad1: 0),
            material: uniforms, textures: bound,
            cull: side == 2 ? .none : side == 1 ? .front : .back,
            depthKey: depthKey(test: material.depthTest ?? true, write: material.depthWrite ?? true),
            depthBias: bias, center: center
        )
    }

    /// World-space centre of the mesh's local bounds (instances ignored), for sorting transparent draws.
    private static func center(position: MapRenderScene.Accessor, bytes: Data, model: simd_float4x4) -> SIMD3<Float> {
        guard position.type == "f32", position.itemSize == 3, position.count > 0 else {
            return SIMD3(model.columns.3.x, model.columns.3.y, model.columns.3.z)
        }
        let (lo, hi) = bytes.withUnsafeBytes { raw -> (SIMD3<Float>, SIMD3<Float>) in
            let floats = raw.baseAddress!.advanced(by: position.offset).assumingMemoryBound(to: Float.self)
            var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
            for v in 0..<position.count {
                let p = SIMD3(floats[v * 3], floats[v * 3 + 1], floats[v * 3 + 2])
                lo = simd_min(lo, p)
                hi = simd_max(hi, p)
            }
            return (lo, hi)
        }
        let c = model * SIMD4((lo + hi) * 0.5, 1)
        return SIMD3(c.x, c.y, c.z)
    }
}

/// Drives a MapRenderer from the frame loop: a camera path per frame, tone mapped into the drawable.
@MainActor
public final class MapFrameEncoder: FrameEncoder {
    public let renderer: MapRenderer
    private let poseAt: @MainActor (Double) -> CameraPose

    public init(renderer: MapRenderer, poseAt: @escaping @MainActor (Double) -> CameraPose) {
        self.renderer = renderer
        self.poseAt = poseAt
    }

    public func encode(commandBuffer: any MTLCommandBuffer, drawable: any CAMetalDrawable, time: Double, dt: Double) {
        renderer.encode(commandBuffer: commandBuffer, pose: poseAt(time), time: time, output: drawable.texture)
    }
}
