// Draws soldiers (Shaders/Soldier.metal): one instanced, GPU-skinned draw for every body and one
// rigid instanced draw for every carbine, in the sun shadow pass and the scene pass. The CPU
// frustum cull stands in for three's onBeforeRender: it tells each soldier's VisibilityTracker that
// it was seen, which drives the pose level of detail (src/characters/lod.ts, soldier.ts:153-159).
// The scene encoder it is given must already have IVFrameUniforms at IV_BUFFER_FRAME (vertex and
// fragment), the lights at IV_BUFFER_LIGHTS and the environment and shadow map bound, as the map
// pass does, so soldiers can be drawn inside the map's scene pass.
import Foundation
import IronvaleAssets
import IronvaleRender
import Metal
import ShaderTypes
import simd

@MainActor
public final class SoldierRenderer {
    public struct Stats: Sendable {
        public var drawnBodies = 0
        public var shadowBodies = 0
    }

    private struct Mesh {
        let positions: any MTLBuffer
        let normals: any MTLBuffer
        let uvs: any MTLBuffer
        let joints: (any MTLBuffer)?
        let weights: (any MTLBuffer)?
        let indices: any MTLBuffer
        let indexCount: Int
        let indexType: MTLIndexType
        let textures: [any MTLTexture]
        var material: IVSoldierMaterial
    }

    private struct Ring {
        let palette: any MTLBuffer
        let bodies: any MTLBuffer
        let guns: any MTLBuffer
        let shadowBodies: any MTLBuffer
        let shadowGuns: any MTLBuffer
    }

    public let rig: SoldierRig
    public let maxSoldiers: Int
    public private(set) var stats = Stats()
    private let body: Mesh
    private let gun: Mesh
    private let jointCount: Int
    private let ring: [Ring]
    private var ringIndex = 0
    private var visibleCount = 0
    private var shadowCount = 0
    private let scenePipeline: any MTLRenderPipelineState
    private let rigidPipeline: any MTLRenderPipelineState
    private let shadowPipeline: any MTLRenderPipelineState
    private let rigidShadowPipeline: any MTLRenderPipelineState
    private let depthState: any MTLDepthStencilState
    private let shadowDepthState: any MTLDepthStencilState
    private var nodeScratch: [simd_float4x4]
    private var paletteScratch: [simd_float4x4]

    /// `colorFormat` and `depthFormat` are the scene pass's attachments (the map uses rgba16Float and
    /// reverse-Z depth32Float); the shadow pass is depth32Float with a less-equal test.
    public init(rig: SoldierRig, bakedDirectory: URL, device: any MTLDevice, library: any MTLLibrary,
                maxSoldiers: Int = 64, framesInFlight: Int = 3,
                colorFormat: MTLPixelFormat = .rgba16Float, depthFormat: MTLPixelFormat = .depth32Float) throws {
        self.rig = rig
        self.maxSoldiers = maxSoldiers
        jointCount = rig.skin.joints.count
        let textures = TextureLoader(device: device)
        let tints = Team.allCases.map { team -> SIMD4<Float> in
            let tint = rig.tables.teamTint[team.rawValue]!
            return SIMD4(RenderMath.linearFromSRGBHex(UInt32(tint.color)) * Float(tint.gain), Float(tint.amount))
        }
        body = try Self.mesh(rig.model, meshIndex: rig.skinnedMesh, skinned: true, teamTint: true, tints: tints,
                             directory: bakedDirectory, device: device, textures: textures)
        gun = try Self.mesh(rig.carbine, meshIndex: 0, skinned: false, teamTint: false, tints: tints,
                            directory: bakedDirectory, device: device, textures: textures)
        ring = try (0..<framesInFlight).map { i in
            func buffer(_ length: Int, _ label: String) throws -> any MTLBuffer {
                guard let b = device.makeBuffer(length: length, options: .storageModeShared) else { throw RenderError.allocation(label) }
                b.label = "\(label) \(i)"
                return b
            }
            let instances = MemoryLayout<IVSoldierInstance>.stride * maxSoldiers
            return Ring(palette: try buffer(MemoryLayout<simd_float4x4>.stride * rig.skin.joints.count * maxSoldiers, "soldier palette"),
                        bodies: try buffer(instances, "soldier bodies"), guns: try buffer(instances, "soldier rifles"),
                        shadowBodies: try buffer(instances, "soldier shadow bodies"), shadowGuns: try buffer(instances, "soldier shadow rifles"))
        }
        nodeScratch = [simd_float4x4](repeating: matrix_identity_float4x4, count: rig.model.nodes.count)
        paletteScratch = [simd_float4x4](repeating: matrix_identity_float4x4, count: rig.skin.joints.count)

        func function(_ name: String) throws -> any MTLFunction {
            guard let f = library.makeFunction(name: name) else { throw RenderError.missingFunction(name) }
            return f
        }
        func pipeline(_ label: String, vertex: String, fragment: String?) throws -> any MTLRenderPipelineState {
            let d = MTLRenderPipelineDescriptor()
            d.label = label
            d.vertexFunction = try function(vertex)
            if let fragment {
                d.fragmentFunction = try function(fragment)
                d.colorAttachments[0].pixelFormat = colorFormat
            }
            d.depthAttachmentPixelFormat = depthFormat
            return try device.makeRenderPipelineState(descriptor: d)
        }
        scenePipeline = try pipeline("soldier", vertex: "ivSoldierVertex", fragment: "ivSoldierFragment")
        rigidPipeline = try pipeline("soldier rifle", vertex: "ivSoldierRigidVertex", fragment: "ivSoldierFragment")
        shadowPipeline = try pipeline("soldier shadow", vertex: "ivSoldierShadowVertex", fragment: nil)
        rigidShadowPipeline = try pipeline("soldier rifle shadow", vertex: "ivSoldierRigidShadowVertex", fragment: nil)
        func depth(_ compare: MTLCompareFunction) throws -> any MTLDepthStencilState {
            let d = MTLDepthStencilDescriptor()
            d.depthCompareFunction = compare
            d.isDepthWriteEnabled = true
            guard let s = device.makeDepthStencilState(descriptor: d) else { throw RenderError.allocation("soldier depth state") }
            return s
        }
        depthState = try depth(.greaterEqual)
        shadowDepthState = try depth(.lessEqual)
    }

    private static func mesh(_ model: IVMModel, meshIndex: Int, skinned: Bool, teamTint: Bool, tints: [SIMD4<Float>],
                             directory: URL, device: any MTLDevice, textures: TextureLoader) throws -> Mesh {
        guard model.meshes[meshIndex].primitives.count == 1, let p = model.meshes[meshIndex].primitives.first else {
            throw SoldierRig.BuildError.missing("mesh \(meshIndex) must have exactly one primitive")
        }
        guard !p.normals.isEmpty, !p.uvs.isEmpty, !skinned || (!p.joints.isEmpty && !p.weights.isEmpty) else {
            throw SoldierRig.BuildError.missing("mesh \(model.meshes[meshIndex].name) lacks normals, uvs or skin weights")
        }
        func buffer<T>(_ array: [T], _ label: String) throws -> any MTLBuffer {
            guard let b = array.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }) else {
                throw RenderError.allocation(label)
            }
            b.label = label
            return b
        }
        let wide = p.vertexCount > Int(UInt16.max)
        let indices = wide ? try buffer(p.indices, "indices") : try buffer(p.indices.map { UInt16($0) }, "indices")
        guard let materialIndex = p.material else { throw SoldierRig.BuildError.missing("primitive without material") }
        let m = model.materials[materialIndex]
        func texture(_ index: Int?, _ what: String) throws -> any MTLTexture {
            guard let index else { throw SoldierRig.BuildError.missing("material \(m.name) has no \(what) texture") }
            let t = model.textures[index]
            return try textures.load(directory.appending(path: t.uri), srgb: t.srgb)
        }
        let tangents = !p.tangents.isEmpty
        let material = IVSoldierMaterial(
            tint: (tints[0], tints[1]),
            // GLTFLoader negates normalScale.y when a mesh has no tangents (derivative tangents).
            normalScale: SIMD2(m.normalScale, tangents ? m.normalScale : -m.normalScale),
            roughness: m.roughness, metalness: m.metallic, teamTint: teamTint ? 1 : 0, _pad0: 0, _pad1: 0, _pad2: 0)
        return Mesh(
            positions: try buffer(p.positions, "positions"), normals: try buffer(p.normals, "normals"), uvs: try buffer(p.uvs, "uvs"),
            joints: skinned ? try buffer(p.joints, "joints") : nil, weights: skinned ? try buffer(p.weights, "weights") : nil,
            indices: indices, indexCount: p.indices.count, indexType: wide ? .uint32 : .uint16,
            textures: [try texture(m.baseColorTexture, "colour"), try texture(m.normalTexture, "normal"),
                       try texture(m.metallicRoughnessTexture, "packed")],
            material: material)
    }

    // MARK: - Frame

    /// Culls against `viewProjection`, marks seen soldiers for pose LOD, and writes this frame's
    /// palettes and instances. Call once per frame before `encodeShadow` and `encodeScene`.
    public func prepare(soldiers: [Soldier], viewProjection: simd_float4x4, eye: SIMD3<Float>) {
        ringIndex = (ringIndex + 1) % ring.count
        let r = ring[ringIndex]
        let planes = Self.frustumPlanes(viewProjection)
        let palette = r.palette.contents().bindMemory(to: simd_float4x4.self, capacity: jointCount * maxSoldiers)
        let bodies = r.bodies.contents().bindMemory(to: IVSoldierInstance.self, capacity: maxSoldiers)
        let guns = r.guns.contents().bindMemory(to: IVSoldierInstance.self, capacity: maxSoldiers)
        let shadowBodies = r.shadowBodies.contents().bindMemory(to: IVSoldierInstance.self, capacity: maxSoldiers)
        let shadowGuns = r.shadowGuns.contents().bindMemory(to: IVSoldierInstance.self, capacity: maxSoldiers)
        visibleCount = 0
        shadowCount = 0
        for (i, soldier) in soldiers.prefix(maxSoldiers).enumerated() {
            let root = soldier.rootMatrix
            let c4 = root * SIMD4<Float>(SIMD3<Float>(Soldier.boundsCenter), 1)
            let center = SIMD3(c4.x, c4.y, c4.z)
            soldier.jointMatrices(into: &paletteScratch, nodes: &nodeScratch)
            let offset = i * jointCount
            for j in 0..<jointCount { palette[offset + j] = paletteScratch[j] }
            let team: UInt32 = soldier.team == .alpha ? 0 : 1
            let bodyInstance = IVSoldierInstance(model: root, paletteOffset: UInt32(offset), team: team, _pad0: 0, _pad1: 0)
            let gunInstance = IVSoldierInstance(model: root * soldier.gunMatrix, paletteOffset: 0, team: team, _pad0: 0, _pad1: 0)
            // Every soldier casts a shadow; the sun's frustum is wide enough that culling it here gains little.
            shadowBodies[shadowCount] = bodyInstance
            shadowGuns[shadowCount] = gunInstance
            shadowCount += 1
            if Self.sphereVisible(center, Float(Soldier.boundsRadius), planes) {
                soldier.visibility.seen(distance: Double(simd_distance(SIMD3(root.columns.3.x, root.columns.3.y, root.columns.3.z), eye)))
                bodies[visibleCount] = bodyInstance
                guns[visibleCount] = gunInstance
                visibleCount += 1
            }
        }
        stats = Stats(drawnBodies: visibleCount, shadowBodies: shadowCount)
    }

    private func bind(_ encoder: any MTLRenderCommandEncoder, _ mesh: Mesh, instances: any MTLBuffer, palette: any MTLBuffer) {
        encoder.setVertexBuffer(mesh.positions, offset: 0, index: Int(IV_SOLDIER_BUFFER_POSITION))
        encoder.setVertexBuffer(mesh.normals, offset: 0, index: Int(IV_SOLDIER_BUFFER_NORMAL))
        encoder.setVertexBuffer(mesh.uvs, offset: 0, index: Int(IV_SOLDIER_BUFFER_UV))
        if let joints = mesh.joints, let weights = mesh.weights {
            encoder.setVertexBuffer(joints, offset: 0, index: Int(IV_SOLDIER_BUFFER_JOINTS))
            encoder.setVertexBuffer(weights, offset: 0, index: Int(IV_SOLDIER_BUFFER_WEIGHTS))
            encoder.setVertexBuffer(palette, offset: 0, index: Int(IV_SOLDIER_BUFFER_PALETTE))
        }
        encoder.setVertexBuffer(instances, offset: 0, index: Int(IV_SOLDIER_BUFFER_INSTANCES))
    }

    private func draw(_ encoder: any MTLRenderCommandEncoder, _ mesh: Mesh, count: Int) {
        encoder.drawIndexedPrimitives(type: .triangle, indexCount: mesh.indexCount, indexType: mesh.indexType,
                                      indexBuffer: mesh.indices, indexBufferOffset: 0, instanceCount: count)
    }

    /// Draws every soldier into the sun shadow map (the map's shadow encoder, frame uniforms bound).
    public func encodeShadow(_ encoder: any MTLRenderCommandEncoder) {
        guard shadowCount > 0 else { return }
        let r = ring[ringIndex]
        encoder.pushDebugGroup("soldier shadows")
        encoder.setDepthStencilState(shadowDepthState)
        encoder.setCullMode(.none)
        encoder.setRenderPipelineState(shadowPipeline)
        bind(encoder, body, instances: r.shadowBodies, palette: r.palette)
        draw(encoder, body, count: shadowCount)
        encoder.setRenderPipelineState(rigidShadowPipeline)
        bind(encoder, gun, instances: r.shadowGuns, palette: r.palette)
        draw(encoder, gun, count: shadowCount)
        encoder.popDebugGroup()
    }

    /// Draws the visible soldiers into the scene pass (frame uniforms, lights, environment and shadow bound).
    public func encodeScene(_ encoder: any MTLRenderCommandEncoder) {
        guard visibleCount > 0 else { return }
        let r = ring[ringIndex]
        encoder.pushDebugGroup("soldiers")
        encoder.setDepthStencilState(depthState)
        encoder.setFrontFacing(.counterClockwise)
        encoder.setCullMode(.back)
        encoder.setDepthBias(0, slopeScale: 0, clamp: 0)
        for (mesh, pipeline, instances) in [(body, scenePipeline, r.bodies), (gun, rigidPipeline, r.guns)] {
            encoder.setRenderPipelineState(pipeline)
            bind(encoder, mesh, instances: instances, palette: r.palette)
            var material = mesh.material
            encoder.setFragmentBytes(&material, length: MemoryLayout<IVSoldierMaterial>.stride, index: Int(IV_SOLDIER_BUFFER_MATERIAL))
            for (slot, texture) in mesh.textures.enumerated() { encoder.setFragmentTexture(texture, index: slot) }
            draw(encoder, mesh, count: visibleCount)
        }
        encoder.popDebugGroup()
    }

    // MARK: - Culling

    /// Planes (normal, d) with the inside where dot(n, p) + d >= 0, from a reverse-Z, Metal-depth view-projection.
    static func frustumPlanes(_ m: simd_float4x4) -> [SIMD4<Float>] {
        let row0 = SIMD4(m.columns.0.x, m.columns.1.x, m.columns.2.x, m.columns.3.x)
        let row1 = SIMD4(m.columns.0.y, m.columns.1.y, m.columns.2.y, m.columns.3.y)
        let row2 = SIMD4(m.columns.0.z, m.columns.1.z, m.columns.2.z, m.columns.3.z)
        let row3 = SIMD4(m.columns.0.w, m.columns.1.w, m.columns.2.w, m.columns.3.w)
        return [row3 + row0, row3 - row0, row3 + row1, row3 - row1, row2, row3 - row2]
    }

    static func sphereVisible(_ center: SIMD3<Float>, _ radius: Float, _ planes: [SIMD4<Float>]) -> Bool {
        for p in planes {
            let n = SIMD3(p.x, p.y, p.z)
            if simd_dot(n, center) + p.w < -radius * simd_length(n) { return false }
        }
        return true
    }
}
