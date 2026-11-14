// The M9 first-person view model: the six guns from the gun export and the skinned arms, posed by
// ViewRig (src/weapons/view/rig.ts) and drawn inside the map's sun shadow and scene passes
// (Shaders/ViewModel.metal) the way the web draws its view model in the main scene. Owns the rig,
// one GunView per weapon, the GPU meshes and materials, and the per-frame draw list.
import Foundation
import IronvaleAssets
import IronvaleRender
import Metal
import os
import ShaderTypes
import simd

@MainActor
public final class ViewModelLayer: SceneLayer {
    private static let logger = Logger(subsystem: "dev.n3el.ironvale", category: "view-model")

    private struct Primitive {
        let positions: any MTLBuffer
        let normals: any MTLBuffer
        let uvs: any MTLBuffer
        let joints: (any MTLBuffer)?
        let weights: (any MTLBuffer)?
        let indices: (buffer: any MTLBuffer, count: Int, type: MTLIndexType)?
        let vertexCount: Int
        let material: IVViewModelMaterial
        let textures: [(any MTLTexture)?]
        let blend: Bool
        let doubleSided: Bool
    }

    private struct Model {
        let rig: RigModel
        /// Per IVM mesh, its primitives.
        let meshes: [[Primitive]]
    }

    private struct Draw {
        let primitive: Primitive
        var uniforms: IVViewModelDraw
    }

    public let tables: ViewModelTables
    public let rig: ViewRig
    /// Weapon id -> its GunView.
    public let guns: [String: GunView]
    /// Scene pass MRT (the post chain is on): pipelines declare the normal and metal/rough attachments.
    public var mrt = false
    /// The scene camera this frame (the map renderer's pose); camera space of the rig maps onto it.
    public var cameraPose = CameraPose(eye: .zero, yaw: 0, pitch: 0)
    /// false hides the view model (player dead, scoped in, menus).
    public var visible = true

    private let device: any MTLDevice
    private let models: [String: Model]
    private let arms: Model?
    private let palettes: [any MTLBuffer]
    private var paletteIndex = 0
    private let jointCount: Int
    private let inverseBind: [simd_double4x4]
    private let jointNodes: [RigNode]
    private var opaque: [Draw] = []
    private var transparent: [Draw] = []
    private var shadowDraws: [Draw] = []
    private let pipelines: (opaque: [Bool: any MTLRenderPipelineState], blend: [Bool: any MTLRenderPipelineState], shadow: any MTLRenderPipelineState)
    private let depthStates: (opaque: any MTLDepthStencilState, blend: any MTLDepthStencilState, shadow: any MTLDepthStencilState)
    private let blank: any MTLTexture
    private let flatNormal: any MTLTexture

    /// `bakedDirectory`: native/BakedAssets/viewmodel; `gunsMeta`: native/MapPackages/guns.
    public init(device: any MTLDevice, library: any MTLLibrary, tables: ViewModelTables, bakedDirectory: URL, gunsMeta: URL,
                framesInFlight: Int = 3) throws {
        self.device = device
        self.tables = tables
        let manifest = try ViewModelAssets.manifest(bakedDirectory)
        let loader = TextureLoader(device: device)
        blank = try loader.solid(SIMD4(255, 255, 255, 255))
        flatNormal = try loader.solid(SIMD4(128, 128, 255, 255))

        let armsRig = try ViewModelAssets.model("arms", directory: bakedDirectory, manifest: manifest)
        let armsModel = try Self.upload(armsRig, gun: nil, tables: tables, directory: bakedDirectory, device: device, loader: loader)
        let firstPerson = try FirstPersonArms(scene: armsRig.scene, tables: tables.arms)
        arms = armsModel
        rig = ViewRig(tables: tables, arms: firstPerson)
        guard let skin = armsRig.ivm.skins.first else { throw ViewModelAssets.LoadError.missing("arms skin") }
        jointCount = skin.joints.count
        jointNodes = skin.joints.map { armsRig.nodes[$0] }
        inverseBind = (0..<skin.joints.count).map { j in
            let f = Array(skin.inverseBindMatrices[(j * 16)..<(j * 16 + 16)]).map(Double.init)
            return simd_double4x4(columns: (SIMD4(f[0], f[1], f[2], f[3]), SIMD4(f[4], f[5], f[6], f[7]),
                                            SIMD4(f[8], f[9], f[10], f[11]), SIMD4(f[12], f[13], f[14], f[15])))
        }
        palettes = try (0..<framesInFlight).map { i in
            guard let b = device.makeBuffer(length: MemoryLayout<simd_float4x4>.stride * max(1, skin.joints.count), options: .storageModeShared) else {
                throw RenderError.allocation("view model palette")
            }
            b.label = "view model palette \(i)"
            return b
        }

        var models: [String: Model] = [:]
        var guns: [String: GunView] = [:]
        for (id, def) in tables.weapons {
            let rigModel = try ViewModelAssets.model(id, directory: bakedDirectory, manifest: manifest)
            models[id] = try Self.upload(rigModel, gun: id, tables: tables, directory: bakedDirectory, device: device, loader: loader)
            guns[id] = GunView(model: try ViewModelAssets.gun(rigModel, metaDirectory: gunsMeta), def: def, tables: tables)
        }
        self.models = models
        self.guns = guns

        func function(_ name: String) throws -> any MTLFunction {
            guard let f = library.makeFunction(name: name) else { throw RenderError.missingFunction(name) }
            return f
        }
        let vertex = try function("ivViewModelVertex"), fragment = try function("ivViewModelFragment")
        func scene(mrt: Bool, blend: Bool) throws -> any MTLRenderPipelineState {
            let d = MTLRenderPipelineDescriptor()
            d.label = "view model\(blend ? " blend" : "")\(mrt ? " mrt" : "")"
            d.vertexFunction = vertex
            d.fragmentFunction = fragment
            d.colorAttachments[0].pixelFormat = .rgba16Float
            if blend {
                d.colorAttachments[0].isBlendingEnabled = true
                d.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
                d.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
                d.colorAttachments[0].sourceAlphaBlendFactor = .one
                d.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
            }
            if mrt {
                d.colorAttachments[Int(IV_SCENE_ATTACHMENT_NORMAL)].pixelFormat = .rgba8Unorm
                d.colorAttachments[Int(IV_SCENE_ATTACHMENT_METALROUGH)].pixelFormat = .rg8Unorm
                if blend {
                    d.colorAttachments[Int(IV_SCENE_ATTACHMENT_NORMAL)].writeMask = []
                    d.colorAttachments[Int(IV_SCENE_ATTACHMENT_METALROUGH)].writeMask = []
                }
            }
            d.depthAttachmentPixelFormat = .depth32Float
            return try device.makeRenderPipelineState(descriptor: d)
        }
        let shadow = MTLRenderPipelineDescriptor()
        shadow.label = "view model shadow"
        shadow.vertexFunction = try function("ivViewModelShadowVertex")
        shadow.depthAttachmentPixelFormat = .depth32Float
        pipelines = (opaque: [false: try scene(mrt: false, blend: false), true: try scene(mrt: true, blend: false)],
                     blend: [false: try scene(mrt: false, blend: true), true: try scene(mrt: true, blend: true)],
                     shadow: try device.makeRenderPipelineState(descriptor: shadow))
        func depth(_ compare: MTLCompareFunction, write: Bool) throws -> any MTLDepthStencilState {
            let d = MTLDepthStencilDescriptor()
            d.depthCompareFunction = compare
            d.isDepthWriteEnabled = write
            guard let s = device.makeDepthStencilState(descriptor: d) else { throw RenderError.allocation("view model depth state") }
            return s
        }
        depthStates = (opaque: try depth(.greaterEqual, write: true), blend: try depth(.greaterEqual, write: false),
                       shadow: try depth(.lessEqual, write: true))
        Self.logger.info("View model ready: \(guns.count) guns, arms with \(skin.joints.count) joints")
    }

    // MARK: - Loading

    private static func upload(_ model: RigModel, gun: String?, tables: ViewModelTables, directory: URL, device: any MTLDevice,
                               loader: TextureLoader) throws -> Model {
        var textureCache: [Int: any MTLTexture] = [:]
        func texture(_ index: Int?) throws -> (any MTLTexture)? {
            guard let index else { return nil }
            if let cached = textureCache[index] { return cached }
            let t = model.ivm.textures[index]
            let loaded = try loader.load(directory.appending(path: t.uri), srgb: t.srgb)
            textureCache[index] = loaded
            return loaded
        }
        func buffer<T>(_ array: [T], _ label: String) throws -> any MTLBuffer {
            let bytes = max(1, array.count * MemoryLayout<T>.stride)
            let made: (any MTLBuffer)? = array.isEmpty ? device.makeBuffer(length: bytes, options: .storageModeShared)
                : array.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }
            guard let made else { throw RenderError.allocation(label) }
            made.label = label
            return made
        }
        // Mesh nodes drawn with the reticle program (guns-c-optic.ts names its pane holo_reticle).
        let reticleMeshes = Set(model.nodes.filter { $0.name == "holo_reticle" }.compactMap { $0.source.flatMap { model.ivm.nodes[$0].mesh } })
        var meshes: [[Primitive]] = []
        for (meshIndex, mesh) in model.ivm.meshes.enumerated() {
            var primitives: [Primitive] = []
            for p in mesh.primitives {
                let m = p.material.map { model.ivm.materials[$0] }
                let extras = p.material.flatMap { $0 < model.extras.count ? model.extras[$0] : nil }
                var material = Self.material(m, extras: extras, gun: gun, tables: tables, reticle: reticleMeshes.contains(meshIndex))
                let color = try texture(m?.baseColorTexture)
                let normal = try texture(m?.normalTexture)
                let metalRough = try texture(m?.metallicRoughnessTexture)
                let ao = try texture(m?.occlusionTexture)
                if color != nil { material.flags |= IV_VM_COLOR_MAP }
                if normal != nil { material.flags |= IV_VM_NORMAL_MAP }
                if metalRough != nil { material.flags |= IV_VM_METALROUGH_MAP }
                if ao != nil { material.flags |= IV_VM_AO_MAP }
                let normals = p.normals.isEmpty ? [Float](repeating: 0, count: p.vertexCount * 3) : p.normals
                let uvs = p.uvs.isEmpty ? [Float](repeating: 0, count: p.vertexCount * 2) : p.uvs
                let skinned = !p.joints.isEmpty && !p.weights.isEmpty
                let wide = p.vertexCount > Int(UInt16.max)
                let indices: (any MTLBuffer, Int, MTLIndexType)? = p.indices.isEmpty ? nil
                    : (wide ? try buffer(p.indices, "vm indices") : try buffer(p.indices.map { UInt16($0) }, "vm indices"),
                       p.indices.count, wide ? .uint32 : .uint16)
                primitives.append(Primitive(
                    positions: try buffer(p.positions, "vm positions"), normals: try buffer(normals, "vm normals"),
                    uvs: try buffer(uvs, "vm uvs"), joints: skinned ? try buffer(p.joints, "vm joints") : nil,
                    weights: skinned ? try buffer(p.weights, "vm weights") : nil,
                    indices: indices.map { (buffer: $0.0, count: $0.1, type: $0.2) }, vertexCount: p.vertexCount,
                    material: material, textures: [color, normal, metalRough, ao],
                    blend: m?.alphaMode == .blend || material.finish == IV_VM_FINISH_RETICLE, doubleSided: m?.doubleSided ?? false))
            }
            meshes.append(primitives)
        }
        return Model(rig: model, meshes: meshes)
    }

    private static func material(_ m: IVMModel.Material?, extras: BakedMaterialExtras?, gun: String?, tables: ViewModelTables,
                                 reticle: Bool) -> IVViewModelMaterial {
        let base = m?.baseColor ?? SIMD4(1, 1, 1, 1)
        var out = IVViewModelMaterial()
        out.baseColor = base
        let scale = abs(m?.normalScale ?? 1)
        // Derivative tangent frames (no tangent stream): GLTFLoader's normalScale.y negation.
        out.normalScale = SIMD2(scale, -scale)
        out.roughness = m?.roughness ?? 1
        out.metalness = m?.metallic ?? 0
        out.aoIntensity = 1
        out.finish = IV_VM_FINISH_STANDARD
        if extras?.unlit == true { out.flags |= IV_VM_UNLIT }
        // Every gun finish keeps itself out of screen-space reflections (keepOutOfReflections); the arms do not.
        if gun != nil { out.flags |= IV_VM_KEEP_OUT_OF_REFLECTIONS }
        let name = m?.name ?? ""
        if reticle {
            out.finish = IV_VM_FINISH_RETICLE
            let r = tables.reticle
            out.tint = SIMD4(RenderMath.linearFromSRGBHex(UInt32(r.color)), 1)
            out.reticle = SIMD4(Float(r.dot), Float(r.ring), Float(r.ringWidth), Float(r.gain))
        } else if let gun, let t = tables.finishes.tuned[gun]?[name] {
            out.finish = IV_VM_FINISH_TUNED
            out.tint = SIMD4(RenderMath.linearFromSRGBHex(UInt32(t.tint)), 1)
            out.lift = SIMD4(Float(t.metalLift), Float(t.polymerLift), Float(t.roughness), Float(t.roughnessBias))
            out.rough = SIMD4(Float(t.scratchGloss), Float(t.minRoughness), Float(t.maxRoughness), Float(t.metalness))
            out.noise = SIMD4(Float(t.wear), Float(t.noiseScale), Float(t.rub), 0)
            out.normalScale = SIMD2(Float(t.normalScale), -Float(t.normalScale))
        } else if gun == "m7", let f = tables.finishes.m7[name] {
            out.finish = IV_VM_FINISH_M7
            out.tint = SIMD4(RenderMath.linearFromSRGBHex(UInt32(f.tint)), 1)
            out.roughness = Float(f.roughness)
            out.metalness = Float(f.metalness)
            out.noise = SIMD4(Float(f.wear), Float(f.noiseScale), Float(f.rub), Float(f.mottle))
        }
        return out
    }

    // MARK: - Frame

    /// Shows the gun of `weaponId` (no-op when it is already in the hands).
    public func show(weaponId: String) {
        if let gun = guns[weaponId] { rig.show(gun) }
    }

    /// The rig's camera-space point in world space, for the current camera pose.
    public func world(_ cameraSpace: RVec3) -> SIMD3<Double> {
        let w = cameraPose.world
        let p = w * SIMD4(Float(cameraSpace.x), Float(cameraSpace.y), Float(cameraSpace.z), 1)
        return SIMD3(Double(p.x), Double(p.y), Double(p.z))
    }

    public func prepare(viewProjection _: simd_float4x4, eye _: SIMD3<Float>) {
        opaque.removeAll(keepingCapacity: true)
        transparent.removeAll(keepingCapacity: true)
        shadowDraws.removeAll(keepingCapacity: true)
        guard visible, rig.root.visible, let gun = rig.gun, let model = models[gun.model.id] else { return }
        rig.camera.updateMatrixWorld()
        let depth = Float(rig.depthScale)
        let unscale = simd_double4x4(diagonal: SIMD4(1, 1, 1 / rig.depthScale, 1))
        let cameraToWorld = cameraPose.world

        func collect(_ node: RigNode, _ model: Model) {
            guard node.visible else { return }
            if let source = node.source, node === model.rig.nodes[source], let meshIndex = model.rig.ivm.nodes[source].mesh {
                let relative = Self.float(unscale * node.matrixWorld)
                let uniforms = IVViewModelDraw(model: relative, normalMatrix: RenderMath.normalMatrix(relative), cameraToWorld: cameraToWorld,
                                               depthScale: depth, skinned: 0, _pad0: 0, _pad1: 0)
                for primitive in model.meshes[meshIndex] {
                    let draw = Draw(primitive: primitive, uniforms: uniforms)
                    if primitive.blend { transparent.append(draw) } else { opaque.append(draw); shadowDraws.append(draw) }
                }
            }
            for child in node.children { collect(child, model) }
        }
        collect(gun.model.root, model)

        if let arms, let skinnedMesh = arms.rig.ivm.nodes.firstIndex(where: { $0.skin != nil }),
           let meshIndex = arms.rig.ivm.nodes[skinnedMesh].mesh {
            paletteIndex = (paletteIndex + 1) % palettes.count
            let palette = palettes[paletteIndex].contents().bindMemory(to: simd_float4x4.self, capacity: jointCount)
            for j in 0..<jointCount { palette[j] = Self.float(unscale * jointNodes[j].matrixWorld * inverseBind[j]) }
            let uniforms = IVViewModelDraw(model: matrix_identity_float4x4, normalMatrix: matrix_identity_float4x4,
                                           cameraToWorld: cameraToWorld, depthScale: depth, skinned: 1, _pad0: 0, _pad1: 0)
            for primitive in arms.meshes[meshIndex] {
                let draw = Draw(primitive: primitive, uniforms: uniforms)
                opaque.append(draw)
                shadowDraws.append(draw)
            }
        }
    }

    private static func float(_ m: simd_double4x4) -> simd_float4x4 {
        simd_float4x4(columns: (SIMD4<Float>(m[0]), SIMD4<Float>(m[1]), SIMD4<Float>(m[2]), SIMD4<Float>(m[3])))
    }

    private func bind(_ encoder: any MTLRenderCommandEncoder, _ draw: Draw) {
        let p = draw.primitive
        encoder.setVertexBuffer(p.positions, offset: 0, index: Int(IV_VM_BUFFER_POSITION))
        encoder.setVertexBuffer(p.normals, offset: 0, index: Int(IV_VM_BUFFER_NORMAL))
        encoder.setVertexBuffer(p.uvs, offset: 0, index: Int(IV_VM_BUFFER_UV))
        encoder.setVertexBuffer(p.joints ?? p.positions, offset: 0, index: Int(IV_VM_BUFFER_JOINTS))
        encoder.setVertexBuffer(p.weights ?? p.positions, offset: 0, index: Int(IV_VM_BUFFER_WEIGHTS))
        encoder.setVertexBuffer(palettes[paletteIndex], offset: 0, index: Int(IV_VM_BUFFER_PALETTE))
        var uniforms = draw.uniforms
        encoder.setVertexBytes(&uniforms, length: MemoryLayout<IVViewModelDraw>.stride, index: Int(IV_VM_BUFFER_DRAW))
    }

    private func issue(_ encoder: any MTLRenderCommandEncoder, _ p: Primitive) {
        if let indices = p.indices {
            encoder.drawIndexedPrimitives(type: .triangle, indexCount: indices.count, indexType: indices.type,
                                          indexBuffer: indices.buffer, indexBufferOffset: 0)
        } else {
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: p.vertexCount)
        }
    }

    public func encodeShadow(_ encoder: any MTLRenderCommandEncoder) {
        guard !shadowDraws.isEmpty else { return }
        encoder.pushDebugGroup("view model shadow")
        encoder.setRenderPipelineState(pipelines.shadow)
        encoder.setDepthStencilState(depthStates.shadow)
        encoder.setCullMode(.none)
        for draw in shadowDraws {
            bind(encoder, draw)
            issue(encoder, draw.primitive)
        }
        encoder.popDebugGroup()
    }

    /// Opaque gun parts and the arms, after the map's opaque geometry.
    public func encodeScene(_ encoder: any MTLRenderCommandEncoder) {
        encode(encoder, opaque, pipeline: pipelines.opaque[mrt]!, depth: depthStates.opaque, label: "view model")
    }

    /// Lenses and the holo reticle, after the sky and the map's transparent draws (three sorts the
    /// view model's transparent meshes with the rest; they are the nearest, so they come last).
    public func encodeTransparent(_ encoder: any MTLRenderCommandEncoder) {
        encode(encoder, transparent, pipeline: pipelines.blend[mrt]!, depth: depthStates.blend, label: "view model glass")
    }

    private func encode(_ encoder: any MTLRenderCommandEncoder, _ draws: [Draw], pipeline: any MTLRenderPipelineState,
                        depth: any MTLDepthStencilState, label: String) {
        guard !draws.isEmpty else { return }
        encoder.pushDebugGroup(label)
        encoder.setFrontFacing(.counterClockwise)
        encoder.setDepthBias(0, slopeScale: 0, clamp: 0)
        encoder.setRenderPipelineState(pipeline)
        encoder.setDepthStencilState(depth)
        for draw in draws {
            let p = draw.primitive
            encoder.setCullMode(p.doubleSided ? .none : .back)
            bind(encoder, draw)
            var material = p.material
            encoder.setFragmentBytes(&material, length: MemoryLayout<IVViewModelMaterial>.stride, index: Int(IV_VM_BUFFER_MATERIAL))
            encoder.setFragmentTexture(p.textures[0] ?? blank, index: Int(IV_VM_TEXTURE_COLOR))
            encoder.setFragmentTexture(p.textures[1] ?? flatNormal, index: Int(IV_VM_TEXTURE_NORMAL))
            encoder.setFragmentTexture(p.textures[2] ?? blank, index: Int(IV_VM_TEXTURE_METALROUGH))
            encoder.setFragmentTexture(p.textures[3] ?? blank, index: Int(IV_VM_TEXTURE_AO))
            issue(encoder, p)
        }
        encoder.popDebugGroup()
    }

    /// Triangles drawn this frame (scene pass), for reports.
    public var triangleCount: Int {
        (opaque + transparent).reduce(0) { $0 + ($1.primitive.indices?.count ?? $1.primitive.vertexCount) / 3 }
    }
}
