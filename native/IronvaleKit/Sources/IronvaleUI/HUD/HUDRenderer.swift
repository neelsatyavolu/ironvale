// The Metal HUD pass (PLAN.md 3.9): the scene grade (CSS saturate() and the dead dim, read in place by
// framebuffer fetch), then every HUD item as an instanced quad over the finished frame. Shaders in
// IronvaleApp/Shaders/Hud.metal.
import Foundation
import Metal
import MetalKit

@MainActor
public final class HUDRenderer {
    public let font: MSDFFont
    public private(set) var layout: MinimapLayout?
    public private(set) var mapId: String?

    private let device: any MTLDevice
    private let resources: URL
    private let pipeline: any MTLRenderPipelineState
    private let grade: any MTLRenderPipelineState
    private let atlas: any MTLTexture
    private var layoutTexture: (any MTLTexture)?
    private let empty: any MTLTexture
    private let sampler: any MTLSamplerState
    private var buffers: [any MTLBuffer] = []
    private var bufferIndex = 0

    public enum HUDError: Error, CustomStringConvertible {
        case missingFunction(String), texture(String)
        public var description: String {
            switch self {
            case let .missingFunction(name): "Hud.metal function \(name) is missing from the library"
            case let .texture(what): "could not create the HUD \(what) texture"
            }
        }
    }

    /// `resources`: the folder holding hud-atlas.{json,png} and minimap-<map>.bin (the app's Resources/HUD).
    public init(device: any MTLDevice, library: any MTLLibrary, colorFormat: MTLPixelFormat, resources: URL) throws {
        self.device = device
        self.resources = resources
        font = try MSDFFont.load(directory: resources)
        func function(_ name: String) throws -> any MTLFunction {
            guard let f = library.makeFunction(name: name) else { throw HUDError.missingFunction(name) }
            return f
        }
        let items = MTLRenderPipelineDescriptor()
        items.label = "HUD"
        items.vertexFunction = try function("hudVertex")
        items.fragmentFunction = try function("hudFragment")
        let attachment = items.colorAttachments[0]!
        attachment.pixelFormat = colorFormat
        attachment.isBlendingEnabled = true
        attachment.sourceRGBBlendFactor = .one
        attachment.sourceAlphaBlendFactor = .one
        attachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
        attachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
        pipeline = try device.makeRenderPipelineState(descriptor: items)
        let gradeDescriptor = MTLRenderPipelineDescriptor()
        gradeDescriptor.label = "HUD grade"
        gradeDescriptor.vertexFunction = try function("hudGradeVertex")
        gradeDescriptor.fragmentFunction = try function("hudGradeFragment")
        gradeDescriptor.colorAttachments[0].pixelFormat = colorFormat
        grade = try device.makeRenderPipelineState(descriptor: gradeDescriptor)

        let loader = MTKTextureLoader(device: device)
        atlas = try loader.newTexture(URL: resources.appending(path: "hud-atlas.png"),
                                      options: [.SRGB: false, .textureUsage: MTLTextureUsage.shaderRead.rawValue,
                                                .textureStorageMode: MTLStorageMode.private.rawValue, .generateMipmaps: false])
        let none = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: 1, height: 1, mipmapped: false)
        guard let blank = device.makeTexture(descriptor: none) else { throw HUDError.texture("placeholder") }
        blank.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: [UInt8](repeating: 0, count: 4), bytesPerRow: 4)
        empty = blank
        let s = MTLSamplerDescriptor()
        s.minFilter = .linear
        s.magFilter = .linear
        s.sAddressMode = .clampToEdge
        s.tAddressMode = .clampToEdge
        guard let state = device.makeSamplerState(descriptor: s) else { throw HUDError.texture("sampler") }
        sampler = state
    }

    /// Loads the minimap layout of `mapId` (nil, or a map without one, shows no minimap).
    public func setMap(_ mapId: String?) {
        guard mapId != self.mapId else { return }
        self.mapId = mapId
        layout = nil
        layoutTexture = nil
        guard let mapId, let loaded = try? MinimapLayout.load(directory: resources, mapId: mapId) else { return }
        let painted = loaded.paint()
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: painted.width, height: painted.height,
                                                                  mipmapped: false)
        descriptor.usage = .shaderRead
        guard let texture = device.makeTexture(descriptor: descriptor) else { return }
        texture.replace(region: MTLRegionMake2D(0, 0, painted.width, painted.height), mipmapLevel: 0, withBytes: painted.pixels,
                        bytesPerRow: painted.width * 4)
        layout = loaded
        layoutTexture = texture
    }

    /// Draws `scene` over `target`, keeping what is there.
    public func encode(commandBuffer: any MTLCommandBuffer, target: any MTLTexture, scene: HUDScene, viewport: (width: Double, height: Double)) {
        let items = scene.canvas.items
        let grading = scene.saturation < 1 || scene.dim > 0.001
        guard !items.isEmpty || grading else { return }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .load
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.label = "HUD"
        if grading {
            var g = SIMD2<Float>(Float(scene.saturation), Float(scene.dim))
            encoder.setRenderPipelineState(grade)
            encoder.setFragmentBytes(&g, length: MemoryLayout<SIMD2<Float>>.stride, index: 0)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        }
        if !items.isEmpty, let buffer = buffer(for: items) {
            var uniforms = (SIMD2<Float>(Float(viewport.width), Float(viewport.height)), Float(scene.canvas.pointScale), Float(0))
            encoder.setRenderPipelineState(pipeline)
            encoder.setVertexBuffer(buffer, offset: 0, index: 0)
            encoder.setFragmentBuffer(buffer, offset: 0, index: 0)
            encoder.setVertexBytes(&uniforms, length: MemoryLayout.size(ofValue: uniforms), index: 1)
            encoder.setFragmentBytes(&uniforms, length: MemoryLayout.size(ofValue: uniforms), index: 1)
            encoder.setFragmentTexture(atlas, index: 0)
            encoder.setFragmentTexture(layoutTexture ?? empty, index: 1)
            encoder.setFragmentSamplerState(sampler, index: 0)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: items.count)
        }
        encoder.endEncoding()
    }

    /// Three buffers in turn, grown as needed, so the CPU never writes one the GPU is still reading.
    private func buffer(for items: [HUDGPUItem]) -> (any MTLBuffer)? {
        let length = items.count * MemoryLayout<HUDGPUItem>.stride
        if buffers.count < 3 { buffers = (0..<3).compactMap { _ in device.makeBuffer(length: max(length, 1 << 16), options: .storageModeShared) } }
        bufferIndex = (bufferIndex + 1) % buffers.count
        if buffers[bufferIndex].length < length {
            guard let grown = device.makeBuffer(length: length * 2, options: .storageModeShared) else { return nil }
            buffers[bufferIndex] = grown
        }
        let buffer = buffers[bufferIndex]
        items.withUnsafeBytes { buffer.contents().copyMemory(from: $0.baseAddress!, byteCount: length) }
        return buffer
    }
}
