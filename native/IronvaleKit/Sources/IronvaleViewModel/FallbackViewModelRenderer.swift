// Stand-in first-person view model (M4), used when the baked view model (ViewModelLayer) is missing: the stand-in gun posed in camera space and drawn over the scene.
// Behaviour reference: src/weapons/view/rig.ts (hip / ADS blend from the sight anchor, lowered and
// sprint carry, a spring kick per shot, 54 degree view-model field of view). The layered procedural
// pose, arms, IK and gun materials are M9; this keeps the gun readable and gives the sim a muzzle.
import Foundation
import IronvaleRender
import IronvaleSim
import IronvaleWorld
import Metal
import simd

public struct ViewModelState: Sendable {
    public var weaponId: String
    /// `HANDLING[class]`: grip at the hip (x right, y up, z back) and tilt (pitch, yaw, roll).
    public var hip: SIMD3<Float>
    public var hipTilt: SIMD3<Float>
    public var aimBlend: Float
    public var lowered: Float
    public var sprint: Float
    public var hidden: Bool

    public init(weaponId: String, hip: SIMD3<Float>, hipTilt: SIMD3<Float>, aimBlend: Float, lowered: Float, sprint: Float, hidden: Bool) {
        self.weaponId = weaponId
        self.hip = hip
        self.hipTilt = hipTilt
        self.aimBlend = aimBlend
        self.lowered = lowered
        self.sprint = sprint
        self.hidden = hidden
    }
}

private struct Uniforms {
    var viewProjection: simd_float4x4
    var model: simd_float4x4
    var sunDirection: SIMD4<Float>
    var sunColor: SIMD4<Float>
    var skyColor: SIMD4<Float>
    var groundColor: SIMD4<Float>
}

@MainActor
public final class FallbackViewModelRenderer {
    /// rig.ts: the view model is drawn with its own narrower field of view.
    public static let fovDegrees: Float = 54

    private let device: any MTLDevice
    private let pipeline: any MTLRenderPipelineState
    private let depthState: any MTLDepthStencilState
    private var meshes: [String: (buffer: any MTLBuffer, count: Int)] = [:]
    private let guns: [String: FallbackGunData]
    private var depth: (any MTLTexture)?
    private var state: ViewModelState?
    private var gunToCamera = matrix_identity_float4x4
    private var kick: Float = 0
    private var kickVelocity: Float = 0
    /// Sun direction and colours in world space, from the map lighting.
    public var sunDirection = SIMD3<Float>(0.4, 0.8, 0.3)
    public var sunColor = SIMD3<Float>(repeating: 2.5)
    public var skyColor = SIMD3<Float>(0.35, 0.4, 0.45)
    public var groundColor = SIMD3<Float>(0.12, 0.11, 0.1)

    public enum SetupError: Error, CustomStringConvertible {
        case missingFunction(String)
        case noBuffer(String)

        public var description: String {
            switch self {
            case .missingFunction(let name): "Shader function \(name) is missing from default.metallib"
            case .noBuffer(let id): "Could not allocate the view-model buffer for \(id)"
            }
        }
    }

    public init(device: any MTLDevice, library: any MTLLibrary, colorFormat: MTLPixelFormat, guns: [String: FallbackGunData]) throws {
        self.device = device
        self.guns = guns
        guard let vertex = library.makeFunction(name: "ivViewModelFallbackVertex") else { throw SetupError.missingFunction("ivViewModelFallbackVertex") }
        guard let fragment = library.makeFunction(name: "ivViewModelFallbackFragment") else { throw SetupError.missingFunction("ivViewModelFallbackFragment") }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.label = "view model"
        descriptor.vertexFunction = vertex
        descriptor.fragmentFunction = fragment
        descriptor.colorAttachments[0].pixelFormat = colorFormat
        descriptor.colorAttachments[0].isBlendingEnabled = true
        descriptor.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
        descriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        descriptor.depthAttachmentPixelFormat = .depth32Float
        pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        let depthDescriptor = MTLDepthStencilDescriptor()
        depthDescriptor.depthCompareFunction = .greater
        depthDescriptor.isDepthWriteEnabled = true
        depthState = device.makeDepthStencilState(descriptor: depthDescriptor)!
        for (id, gun) in guns {
            var vertices = FallbackGunMesh.vertices(gun)
            guard let buffer = device.makeBuffer(bytes: &vertices, length: MemoryLayout<ViewModelVertex>.stride * vertices.count) else {
                throw SetupError.noBuffer(id)
            }
            buffer.label = "view model \(id)"
            meshes[id] = (buffer, vertices.count)
        }
    }

    /// A shot left the barrel: kick the gun back.
    public func fired(aimBlend: Float) { kickVelocity += 1.6 * (1 - 0.5 * aimBlend) }

    /// Poses the gun for this frame.
    public func update(_ state: ViewModelState, dt: Float) {
        self.state = state
        // Critically damped spring back to rest (rig.ts uses springs sub-stepped at 1/120 s).
        var remaining = dt
        while remaining > 0 {
            let step = min(remaining, 1.0 / 120)
            kickVelocity += (-kick * 900 - kickVelocity * 50) * step
            kick += kickVelocity * step
            remaining -= step
        }
        guard let gun = guns[state.weaponId] else { return }
        let aim = state.aimBlend * state.aimBlend * (3 - 2 * state.aimBlend)
        let sight = SIMD3(gun.sight[0], gun.sight[1], gun.sight[2])
        // Aimed: the sight anchor sits on the eye, the barrel straight ahead.
        let aimedPosition = -sight
        var position = simd_mix(state.hip, aimedPosition, SIMD3(repeating: aim))
        var tilt = state.hipTilt * (1 - aim)
        position += SIMD3(0.04, -0.06, 0.02) * state.sprint
        tilt += SIMD3(-0.35, 0.55, 0.2) * state.sprint
        position.y -= 0.3 * state.lowered
        tilt.x -= 0.9 * state.lowered
        position.z += kick * 0.04
        tilt.x += kick * 0.05
        gunToCamera = RenderMath.translation(position) * RenderMath.rotationY(tilt.y) * RenderMath.rotationX(tilt.x) * rotationZ(tilt.z)
    }

    /// World position of a gun-space point, for a camera.
    private func world(_ point: [Float], camera: SimCamera) -> Vec3 {
        let p = gunToCamera * SIMD4(point[0], point[1], point[2], 1)
        let local = camera.rotate(Vec3(Double(p.x), Double(p.y), Double(p.z)))
        return camera.position + local
    }

    public func muzzleWorld(camera: SimCamera) -> Vec3? {
        guard let state, let gun = guns[state.weaponId] else { return nil }
        return world(gun.muzzle, camera: camera)
    }

    /// The ejection port and the direction brass leaves it (gun +X), in world space.
    public func ejectionWorld(camera: SimCamera) -> (port: Vec3, side: Vec3)? {
        guard let state, let gun = guns[state.weaponId] else { return nil }
        let side = gunToCamera * SIMD4<Float>(1, 0, 0, 0)
        return (world(gun.ejection, camera: camera), camera.rotate(Vec3(Double(side.x), Double(side.y), Double(side.z))).normalized())
    }

    /// Draws the gun over `target` (already holding the tone-mapped scene).
    public func encode(commandBuffer: any MTLCommandBuffer, target: any MTLTexture, camera: SimCamera) {
        guard let state, !state.hidden, let mesh = meshes[state.weaponId] else { return }
        if depth?.width != target.width || depth?.height != target.height {
            let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .depth32Float, width: target.width,
                                                                      height: target.height, mipmapped: false)
            descriptor.usage = [.renderTarget]
            descriptor.storageMode = .private
            depth = device.makeTexture(descriptor: descriptor)
        }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .load
        pass.colorAttachments[0].storeAction = .store
        pass.depthAttachment.texture = depth
        pass.depthAttachment.loadAction = .clear
        pass.depthAttachment.clearDepth = 0
        pass.depthAttachment.storeAction = .dontCare
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.label = "view model"
        let aspect = Float(target.width) / Float(max(1, target.height))
        let projection = RenderMath.perspectiveReverseZ(fovYRadians: Self.fovDegrees * .pi / 180, aspect: aspect, near: 0.01, far: 10)
        // Sun direction into camera space: the inverse camera rotation.
        let basis = camera.basis
        let s = Vec3(Double(sunDirection.x), Double(sunDirection.y), Double(sunDirection.z))
        let sunCamera = SIMD3(Float(s.dot(basis.right)), Float(s.dot(basis.up)), Float(s.dot(basis.back)))
        let up = Vec3(0, 1, 0)
        let upCamera = SIMD3(Float(up.dot(basis.right)), Float(up.dot(basis.up)), Float(up.dot(basis.back)))
        // The shader's hemisphere term uses camera-space n.y; tilt the sky/ground split with the view.
        let skyMix = max(0, upCamera.y)
        var uniforms = Uniforms(
            viewProjection: projection, model: gunToCamera,
            sunDirection: SIMD4(simd_normalize(sunCamera), 0), sunColor: SIMD4(sunColor, 1),
            skyColor: SIMD4(simd_mix(groundColor, skyColor, SIMD3(repeating: 0.5 + 0.5 * skyMix)), 1),
            groundColor: SIMD4(groundColor, 1)
        )
        encoder.setRenderPipelineState(pipeline)
        encoder.setDepthStencilState(depthState)
        encoder.setCullMode(.none)
        encoder.setVertexBuffer(mesh.buffer, offset: 0, index: 0)
        encoder.setVertexBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 1)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 1)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: mesh.count)
        encoder.endEncoding()
    }

    private func rotationZ(_ a: Float) -> simd_float4x4 {
        let c = cos(a), s = sin(a)
        return simd_float4x4(columns: (SIMD4(c, s, 0, 0), SIMD4(-s, c, 0, 0), SIMD4(0, 0, 1, 0), SIMD4(0, 0, 0, 1)))
    }
}
