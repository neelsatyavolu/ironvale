// Draws Effects inside the map's scene pass (IronvaleRender SceneLayer): casings and grenade bodies
// with the opaque geometry (and the bodies in the sun shadow), then, after the sky and the map's
// own transparent draws, every see-through effect in shared.ts RENDER_ORDER: decals, rings, mist,
// lit particles, rain, glow particles and motes, tracers, flashes. One pipeline per web material
// (Shaders/FX*.metal, Weather*.metal). Instance data is read straight from the modules' FloatStores
// (no per-frame copies). Transparent effects leave the scene's normal and metal/rough targets alone
// (writeMask = [], PLAN.md 3.3) as the web's leaveSurfaceDataAlone does.
import Foundation
import IronvaleRender
import Metal
import ShaderTypes
import simd

/// Mirrors FXUniforms in Shaders/FXCommon.h.
struct FXUniforms {
    var clock: SIMD4<Float> = .zero
    var wind: SIMD4<Float> = .zero
    var sunDirection: SIMD4<Float> = .zero
    var sunLight: SIMD4<Float> = .zero
    var ambientLight: SIMD4<Float> = .zero
    var a: SIMD4<Float> = .zero
    var b: SIMD4<Float> = .zero
    var c: SIMD4<Float> = .zero
}

@MainActor
public final class FXLayer: SceneLayer {
    enum Slot {
        static let uniforms = 16, instances = 17, extra = 18, geometry = 19
        static let atlas = 24, mask = 25
    }

    public let effects: Effects
    /// Draw nothing (benchmark A/B frames); the effects still update.
    public var hidden = false
    private let device: any MTLDevice
    private let sprites: any MTLTexture
    private let decalAtlas: any MTLTexture
    private let flashAtlas: any MTLTexture
    private let mask: any MTLTexture
    private var maskVersion = -1
    private var maskScratch: [UInt16]
    private var buffers: [ObjectIdentifier: any MTLBuffer] = [:]
    private let cylinder: (buffer: any MTLBuffer, count: Int)
    private let sphere: (buffer: any MTLBuffer, count: Int)
    private let pipelines: [String: any MTLRenderPipelineState]
    private let shadowPipeline: any MTLRenderPipelineState
    private let testOnly: any MTLDepthStencilState
    private let testWrite: any MTLDepthStencilState
    private let shadowDepth: any MTLDepthStencilState
    private let noDepth: any MTLDepthStencilState
    private let grenadeColor: SIMD3<Float>

    /// `colorFormats`: the scene pass's colour attachments (MapRenderer.sceneColorFormats with the
    /// post chain, else [.rgba16Float]); `atlasDirectory`: native/BakedAssets/fx.
    public init(effects: Effects, device: any MTLDevice, library: any MTLLibrary, atlasDirectory: URL,
                colorFormats: [MTLPixelFormat], depthFormat: MTLPixelFormat = .depth32Float) throws {
        self.effects = effects
        self.device = device
        let loader = TextureLoader(device: device)
        func atlas(_ name: String, srgb: Bool) throws -> any MTLTexture {
            let url = atlasDirectory.appending(path: "\(name).png")
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw RenderError.allocation("FX atlas \(url.path) missing; run node native/Tools/fx-parity/bake-atlases.mjs")
            }
            return try loader.load(url, srgb: srgb)
        }
        // textures.ts and flash-sheet.ts are NoColorSpace; decal-sheet.ts is sRGB.
        sprites = try atlas("sprites", srgb: false)
        decalAtlas = try atlas("decals", srgb: true)
        flashAtlas = try atlas("flash", srgb: false)

        let size = WeatherFx.maskCells
        let maskDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r16Float, width: size, height: size, mipmapped: false)
        maskDescriptor.usage = .shaderRead
        maskDescriptor.storageMode = .shared
        guard let mask = device.makeTexture(descriptor: maskDescriptor) else { throw RenderError.allocation("FX roof mask") }
        self.mask = mask
        maskScratch = [UInt16](repeating: HalfFloat.bits(Float(RoofMask.staleHeight)), count: size * size)

        func geometry(_ floats: [Float], _ label: String) throws -> (any MTLBuffer, Int) {
            guard let b = floats.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
            else { throw RenderError.allocation(label) }
            b.label = label
            return (b, floats.count / 6)
        }
        cylinder = try geometry(FXGeometry.cylinder(), "FX casing cylinder")
        sphere = try geometry(FXGeometry.sphere(radius: effects.grenade.bodyRadius), "FX grenade sphere")
        let g = linearFromHex(0x343d27)
        grenadeColor = SIMD3(Float(g.x), Float(g.y), Float(g.z))

        enum Blend { case opaque, normal, additive }
        func pipeline(_ label: String, _ vertex: String, _ fragment: String, _ blend: Blend) throws -> any MTLRenderPipelineState {
            let d = MTLRenderPipelineDescriptor()
            d.label = "fx \(label)"
            guard let v = library.makeFunction(name: vertex), let f = library.makeFunction(name: fragment) else {
                throw RenderError.missingFunction("\(vertex)/\(fragment)")
            }
            d.vertexFunction = v
            d.fragmentFunction = f
            for (i, format) in colorFormats.enumerated() {
                let a = d.colorAttachments[i]!
                a.pixelFormat = format
                guard i == 0 else {
                    if blend != .opaque { a.writeMask = [] }
                    continue
                }
                switch blend {
                case .opaque: break
                case .normal:
                    a.isBlendingEnabled = true
                    a.sourceRGBBlendFactor = .sourceAlpha
                    a.destinationRGBBlendFactor = .oneMinusSourceAlpha
                    a.sourceAlphaBlendFactor = .one
                    a.destinationAlphaBlendFactor = .oneMinusSourceAlpha
                case .additive:
                    a.isBlendingEnabled = true
                    a.sourceRGBBlendFactor = .sourceAlpha
                    a.destinationRGBBlendFactor = .one
                    a.sourceAlphaBlendFactor = .zero
                    a.destinationAlphaBlendFactor = .one
                }
            }
            d.depthAttachmentPixelFormat = depthFormat
            return try device.makeRenderPipelineState(descriptor: d)
        }
        pipelines = [
            "casing": try pipeline("casings", "fxCasingVertex", "fxCasingFragment", .opaque),
            "decal": try pipeline("decals", "fxDecalVertex", "fxDecalFragment", .normal),
            "ring": try pipeline("rings", "fxRingVertex", "fxRingFragment", .normal),
            "bank": try pipeline("mist banks", "fxBankVertex", "fxBankFragment", .normal),
            "lit": try pipeline("lit particles", "fxParticleVertex", "fxParticleFragment", .normal),
            "glow": try pipeline("glow particles", "fxParticleVertex", "fxParticleFragment", .additive),
            "rain": try pipeline("rain", "fxRainVertex", "fxRainFragment", .normal),
            "mote": try pipeline("motes", "fxMoteVertex", "fxMoteFragment", .additive),
            "tracer": try pipeline("tracers", "fxTracerVertex", "fxTracerFragment", .additive),
            "flash": try pipeline("muzzle flashes", "fxMuzzleVertex", "fxMuzzleFragment", .additive),
            "ribbon": try pipeline("grenade arc", "fxArcRibbonVertex", "fxArcFragment", .normal),
            "marker": try pipeline("grenade arc marker", "fxArcMarkerVertex", "fxArcFragment", .normal),
        ]
        let shadow = MTLRenderPipelineDescriptor()
        shadow.label = "fx grenade shadow"
        shadow.vertexFunction = library.makeFunction(name: "fxSolidShadowVertex")
        shadow.depthAttachmentPixelFormat = depthFormat
        shadowPipeline = try device.makeRenderPipelineState(descriptor: shadow)

        func depth(_ compare: MTLCompareFunction, write: Bool) throws -> any MTLDepthStencilState {
            let d = MTLDepthStencilDescriptor()
            d.depthCompareFunction = compare
            d.isDepthWriteEnabled = write
            guard let s = device.makeDepthStencilState(descriptor: d) else { throw RenderError.allocation("FX depth state") }
            return s
        }
        testOnly = try depth(.greaterEqual, write: false)
        testWrite = try depth(.greaterEqual, write: true)
        shadowDepth = try depth(.lessEqual, write: true)
        noDepth = try depth(.always, write: false)
        for store in [effects.lit.data, effects.glow.data, effects.rings.data, effects.tracers.data, effects.decals.matrices,
                      effects.decals.info, effects.muzzle.matrices, effects.muzzle.info, effects.casings.matrices, effects.casings.hull,
                      effects.grenade.matrices, effects.grenade.arc.positions, effects.weather.rainSeeds, effects.weather.bankSeeds, effects.weather.moteSeeds] {
            guard let b = device.makeBuffer(bytesNoCopy: store.pointer, length: store.byteLength, options: .storageModeShared, deallocator: nil)
            else { throw RenderError.allocation("FX instance buffer") }
            buffers[ObjectIdentifier(store)] = b
        }
    }

    private func buffer(_ store: FloatStore) -> any MTLBuffer { buffers[ObjectIdentifier(store)]! }

    /// The muzzle-flash lights as scene lights (three PointLight(0xffb26b, intensity, 10, 2)), written into `out`.
    public func flashLights(into out: inout [IVLight]) {
        out.removeAll(keepingCapacity: true)
        for light in effects.muzzle.lights where light.intensity > 0 {
            let c = Muzzle.lightColor * light.intensity
            out.append(IVLight(position: light.position.float3, distance: Float(Muzzle.lightRange), color: SIMD3(Float(c.x), Float(c.y), Float(c.z)),
                               decay: 2, direction: .zero, coneCos: 0, kind: IV_LIGHT_POINT, penumbraCos: 0, _pad0: 0, _pad1: 0))
        }
    }

    private var uniforms = FXUniforms()

    public func prepare(viewProjection: simd_float4x4, eye: SIMD3<Float>) {
        let env = effects.env
        uniforms.clock = SIMD4(Float(env.now), 0, 0, 0)
        uniforms.wind = SIMD4(env.wind.float3, 0)
        uniforms.sunDirection = SIMD4(env.sunDirection.float3, 0)
        uniforms.sunLight = SIMD4(env.sunLight.float3, 0)
        uniforms.ambientLight = SIMD4(env.ambientLight.float3, 0)
        uniforms.c = SIMD4(Float(Double(WeatherFx.maskCells) * WeatherFx.maskCellMetres), 0, 0, 0)
        let roof = effects.weather.mask
        if roof.version != maskVersion {
            maskVersion = roof.version
            for i in 0..<maskScratch.count { maskScratch[i] = HalfFloat.bits(roof.heights[i]) }
            maskScratch.withUnsafeBytes {
                mask.replace(region: MTLRegionMake2D(0, 0, roof.size, roof.size), mipmapLevel: 0, withBytes: $0.baseAddress!,
                             bytesPerRow: roof.size * MemoryLayout<UInt16>.stride)
            }
        }
    }

    private func draw(_ encoder: any MTLRenderCommandEncoder, _ name: String, instances store: FloatStore, extra: FloatStore? = nil,
                      count: Int, vertices: Int = 6, atlas: (any MTLTexture)? = nil, clock: SIMD4<Float>? = nil,
                      a: SIMD4<Float> = .zero, b: SIMD4<Float> = .zero) {
        guard count > 0, let pipeline = pipelines[name] else { return }
        encoder.setRenderPipelineState(pipeline)
        var u = uniforms
        if let clock { u.clock = clock }
        u.a = a
        u.b = b
        encoder.setVertexBytes(&u, length: MemoryLayout<FXUniforms>.stride, index: Slot.uniforms)
        encoder.setFragmentBytes(&u, length: MemoryLayout<FXUniforms>.stride, index: Slot.uniforms)
        encoder.setVertexBuffer(buffer(store), offset: 0, index: Slot.instances)
        if let extra { encoder.setVertexBuffer(buffer(extra), offset: 0, index: Slot.extra) }
        if let atlas { encoder.setFragmentTexture(atlas, index: Slot.atlas) }
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: vertices, instanceCount: count)
    }

    private func encodeSolids(_ encoder: any MTLRenderCommandEncoder) {
        guard let pipeline = pipelines["casing"] else { return }
        encoder.setRenderPipelineState(pipeline)
        encoder.setDepthStencilState(testWrite)
        encoder.setCullMode(.back)
        encoder.setDepthBias(0, slopeScale: 0, clamp: 0)
        var casing = SIMD4<Float>(0, 0, 0, -1)
        encoder.setFragmentBytes(&casing, length: MemoryLayout<SIMD4<Float>>.stride, index: Slot.uniforms)
        encoder.setVertexBuffer(cylinder.buffer, offset: 0, index: Slot.geometry)
        encoder.setVertexBuffer(buffer(effects.casings.matrices), offset: 0, index: Slot.instances)
        encoder.setVertexBuffer(buffer(effects.casings.hull), offset: 0, index: Slot.extra)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: cylinder.count, instanceCount: Casings.capacity)
        var body = SIMD4<Float>(grenadeColor, 0.62)
        encoder.setFragmentBytes(&body, length: MemoryLayout<SIMD4<Float>>.stride, index: Slot.uniforms)
        encoder.setVertexBuffer(sphere.buffer, offset: 0, index: Slot.geometry)
        encoder.setVertexBuffer(buffer(effects.grenade.matrices), offset: 0, index: Slot.instances)
        encoder.setVertexBuffer(buffer(effects.casings.hull), offset: 0, index: Slot.extra)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: sphere.count, instanceCount: GrenadeFx.bodyCount)
    }

    public func encodeShadow(_ encoder: any MTLRenderCommandEncoder) {
        guard !hidden else { return }
        encoder.setRenderPipelineState(shadowPipeline)
        encoder.setDepthStencilState(shadowDepth)
        encoder.setVertexBuffer(sphere.buffer, offset: 0, index: Slot.geometry)
        encoder.setVertexBuffer(buffer(effects.grenade.matrices), offset: 0, index: Slot.instances)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: sphere.count, instanceCount: GrenadeFx.bodyCount)
    }

    public func encodeScene(_ encoder: any MTLRenderCommandEncoder) {
        guard !hidden else { return }
        encodeSolids(encoder)
    }

    public func encodeTransparent(_ encoder: any MTLRenderCommandEncoder) {
        guard !hidden else { return }
        let fx = effects
        let w = fx.weather.state
        encoder.setDepthStencilState(testOnly)
        encoder.setCullMode(.none)
        encoder.setDepthBias(0, slopeScale: 0, clamp: 0)
        encoder.setVertexTexture(mask, index: Slot.mask)

        // RENDER_ORDER.decals: front faces only, three's polygonOffset(-2, -4) (reverse-Z flips the sign).
        encoder.setCullMode(.back)
        encoder.setDepthBias(4, slopeScale: 2, clamp: 0)
        draw(encoder, "decal", instances: fx.decals.matrices, extra: fx.decals.info, count: Decals.capacity, atlas: decalAtlas)
        encoder.setCullMode(.none)
        encoder.setDepthBias(0, slopeScale: 0, clamp: 0)
        // RENDER_ORDER.rings, mist, particles, rain, glow (glow pool and motes), tracers, flash.
        draw(encoder, "ring", instances: fx.rings.data, count: Rings.capacity)
        if w.banksVisible {
            draw(encoder, "bank", instances: fx.weather.bankSeeds, count: w.banksCount, atlas: sprites,
                 a: SIMD4(w.banksCentre.float3, Float(w.banksIndoors)))
        }
        draw(encoder, "lit", instances: fx.lit.data, count: fx.lit.capacity, atlas: sprites,
             clock: SIMD4(uniforms.clock.x, fx.lit.fadePower, 0.004, 0))
        if w.rainVisible {
            draw(encoder, "rain", instances: fx.weather.rainSeeds, count: w.rainCount,
                 a: SIMD4(w.rainCentre.float3, Float(w.rainIndoors)), b: SIMD4(w.rainFall.float3, 0))
        }
        draw(encoder, "glow", instances: fx.glow.data, count: fx.glow.capacity, atlas: sprites,
             clock: SIMD4(uniforms.clock.x, fx.glow.fadePower, 0.004, 1))
        if w.motesVisible {
            draw(encoder, "mote", instances: fx.weather.moteSeeds, count: w.motesCount, atlas: sprites, a: SIMD4(w.motesCentre.float3, 0))
        }
        draw(encoder, "tracer", instances: fx.tracers.data, count: Tracers.capacity)
        // The grenade arc shares RENDER_ORDER.tracers; its marker is drawn over everything (depthTest false).
        let arc = fx.grenade.arc
        if arc.ribbonVisible, arc.drawCount > 0 {
            let c = GrenadeArc.arcColor
            draw(encoder, "ribbon", instances: arc.positions, count: 1, vertices: arc.drawCount,
                 b: SIMD4(Float(c.x), Float(c.y), Float(c.z), Float(GrenadeArc.arcOpacity)))
        }
        if arc.markerVisible {
            let c = GrenadeArc.markerColor
            encoder.setDepthStencilState(noDepth)
            draw(encoder, "marker", instances: arc.positions, count: 1, vertices: 48 * 6,
                 a: SIMD4(arc.marker.float3, Float(arc.markerScale)), b: SIMD4(Float(c.x), Float(c.y), Float(c.z), Float(GrenadeArc.markerOpacity)))
            encoder.setDepthStencilState(testOnly)
        }
        draw(encoder, "flash", instances: fx.muzzle.matrices, extra: fx.muzzle.info, count: Muzzle.maxFlashes * Muzzle.quads, atlas: flashAtlas)
    }
}
