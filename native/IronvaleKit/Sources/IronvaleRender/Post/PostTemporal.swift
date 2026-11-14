// MetalFX Temporal in place of the web's TRAA (PLAN.md 3.3, 11): the scene is rendered with a
// sub-pixel jittered projection and the scaler resolves it, with camera motion and reverse-Z depth,
// into an HDR texture of the same size, as the web resolves TRAA at the render size (renderScale x
// the dynamic step) and lets the canvas upscale to the display; the output pass then samples it
// bilinearly to the display size.
// One scaler per scene size, kept while dynamic resolution steps between a few sizes, so a step back
// to a size used before neither rebuilds a scaler nor reallocates its inputs. A scaler that was idle
// starts from no history, as TRAA's targets are recreated on a resize. Building a scaler takes from
// 20 ms to most of a second on the reference Mac, so the chain asks for the sizes one dynamic step
// either side of the current one ahead of time (`prepare`), they are built on a background queue, and
// a step waits (at the current size) until its scaler is ready (`isReady`). A built scaler is run
// once on a separate queue (its textures cleared, a reset resolve) so the first frame at its size does
// not pay for first use.
// (A single scaler at the largest size that upscaled the smaller content regions cost 1 - 2 ms more
// per frame below the largest size, and alternated slow and fast frames on the reference Mac.)
// The scaler is given the exposure the output pass tone maps with (a 1x1 texture) instead of
// computing its own (auto exposure), which costs a reduction over the frame.
import Dispatch
import Metal
import MetalFX
import Synchronization

@MainActor
final class PostTemporal {
    /// Jitter sequence length (Halton 2, 3), as TRAA's.
    static let phases = 32

    /// The scaler's inputs at one scene size; the composite pass draws into them.
    struct Inputs {
        let color: any MTLTexture   // rgba16Float
        let motion: any MTLTexture  // rg16Float, uv units
        let depth: any MTLTexture   // depth32Float, reverse-Z
    }

    struct Size: Hashable, Sendable {
        let width: Int, height: Int
    }

    /// Metal objects are safe to hand between threads; the entry is immutable once built.
    private final class Entry: @unchecked Sendable {
        let size: Size
        let scaler: any MTLFXTemporalScaler
        let inputs: Inputs
        let output: any MTLTexture

        init(size: Size, scaler: any MTLFXTemporalScaler, inputs: Inputs, output: any MTLTexture) {
            self.size = size
            self.scaler = scaler
            self.inputs = inputs
            self.output = output
        }
    }

    /// Scene sizes kept: the current one and one dynamic step either side, plus one spare.
    static let keptSizes = 4

    private let device: any MTLDevice
    /// Most recently used first; the head is the current frame's.
    private var entries: [Entry] = []
    /// Sizes being built on `buildQueue`, and the finished ones not yet taken into `entries`.
    private var building: Set<Size> = []
    private final class Built: Sendable {
        let list = Mutex<[(size: Size, entry: Entry?)]>([])
    }
    private let built = Built()
    private let buildQueue = DispatchQueue(label: "MetalFX temporal scalers", qos: .utility)
    private var resetNext = true
    /// Runs the first use of background-built scalers, beside the frames.
    private lazy var warmQueue: (any MTLCommandQueue)? = {
        let queue = device.makeCommandQueue()
        queue?.label = "MetalFX warm-up"
        return queue
    }()
    /// 1x1 r32Float holding the exposure the colour is tone mapped with.
    private let exposure: any MTLTexture

    /// `exposure`: the factor the output pass scales HDR colour by before its tone curve.
    init(device: any MTLDevice, exposure: Float) throws {
        guard MTLFXTemporalScalerDescriptor.supportsDevice(device) else {
            throw RenderError.allocation("MetalFX temporal scaler is not supported on \(device.name)")
        }
        self.device = device
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r32Float, width: 1, height: 1, mipmapped: false)
        d.usage = [.shaderRead]
        d.storageMode = .shared
        guard let texture = device.makeTexture(descriptor: d) else { throw RenderError.allocation("MetalFX exposure") }
        var value = exposure
        texture.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: &value, bytesPerRow: 4)
        texture.label = "MetalFX exposure"
        self.exposure = texture
    }

    /// Sub-pixel offset of frame `index` in scene pixels, each component in [-0.5, 0.5).
    static func jitter(frame index: Int) -> SIMD2<Float> {
        let i = index % phases + 1
        return SIMD2(PostKernels.halton(i, 2) - 0.5, PostKernels.halton(i, 3) - 0.5)
    }

    /// The size of the current frame's scaler, nil before the first frame.
    var currentSize: Size? { entries.first?.size }

    /// Whether a scaler for `size` is built (taking in the ones finished in the background).
    func isReady(_ size: Size) -> Bool {
        collectBuilt()
        return entries.contains { $0.size == size }
    }

    /// Starts building a scaler for `size` in the background unless it exists or is being built.
    func prepare(_ size: Size) {
        collectBuilt()
        guard !building.contains(size), !entries.contains(where: { $0.size == size }) else { return }
        building.insert(size)
        let device = device
        let built = built
        buildQueue.async {
            // A failed build is dropped; the next `prepare` of the size tries again.
            let entry = try? Self.makeEntry(device: device, size: size)
            built.list.withLock { $0.append((size, entry)) }
        }
    }

    /// The inputs for a `width` x `height` scene, switching to that size's scaler (built here if it is
    /// not ready: the first frame, or an output resize). A switch discards that scaler's history.
    func inputs(width: Int, height: Int) throws -> Inputs {
        let size = Size(width: width, height: height)
        if let head = entries.first, head.size == size { return head.inputs }
        collectBuilt()
        resetNext = true
        if let i = entries.firstIndex(where: { $0.size == size }) {
            let entry = entries.remove(at: i)
            entries.insert(entry, at: 0)
            return entry.inputs
        }
        let entry = try Self.makeEntry(device: device, size: size)
        entries.insert(entry, at: 0)
        trim()
        return entry.inputs
    }

    private func collectBuilt() {
        let finished = built.list.withLock { list -> [(size: Size, entry: Entry?)] in
            defer { list.removeAll() }
            return list
        }
        guard !finished.isEmpty else { return }
        for (size, entry) in finished {
            building.remove(size)
            guard let entry, !entries.contains(where: { $0.size == size }) else { continue }
            // After the current one: a built size is not in use until the chain switches to it.
            entries.insert(entry, at: min(1, entries.count))
            warm(entry)

        }
        trim()
    }

    private func warm(_ entry: Entry) {
        guard let commandBuffer = warmQueue?.makeCommandBuffer() else { return }
        commandBuffer.label = "MetalFX warm-up"
        PostTargets.touch([entry.inputs.color, entry.inputs.motion, entry.inputs.depth], commandBuffer: commandBuffer)
        let scaler = entry.scaler
        scaler.colorTexture = entry.inputs.color
        scaler.depthTexture = entry.inputs.depth
        scaler.motionTexture = entry.inputs.motion
        scaler.outputTexture = entry.output
        scaler.exposureTexture = exposure
        scaler.isDepthReversed = true
        scaler.reset = true
        scaler.encode(commandBuffer: commandBuffer)
        commandBuffer.commit()
    }

    private func trim() {
        if entries.count > Self.keptSizes { entries.removeLast(entries.count - Self.keptSizes) }
    }

    private nonisolated static func makeEntry(device: any MTLDevice, size: Size) throws -> Entry {
        let width = size.width, height = size.height
        let d = MTLFXTemporalScalerDescriptor()
        d.colorTextureFormat = .rgba16Float
        d.depthTextureFormat = .depth32Float
        d.motionTextureFormat = .rg16Float
        d.outputTextureFormat = .rgba16Float
        d.inputWidth = width
        d.inputHeight = height
        d.outputWidth = width
        d.outputHeight = height
        d.isAutoExposureEnabled = false
        // Finish compiling before returning: a background-built scaler is then ready when the chain
        // switches to it, instead of compiling (and stalling frames) on its first encodes.
        d.requiresSynchronousInitialization = true
        guard let scaler = d.makeTemporalScaler(device: device) else {
            throw RenderError.allocation("MetalFX temporal scaler \(width)x\(height)")
        }
        func make(_ format: MTLPixelFormat, _ usage: MTLTextureUsage, _ label: String) throws -> any MTLTexture {
            let t = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: width, height: height, mipmapped: false)
            t.usage = usage
            t.storageMode = .private
            guard let texture = device.makeTexture(descriptor: t) else { throw RenderError.allocation(label) }
            texture.label = label
            return texture
        }
        let inputs = Inputs(
            color: try make(.rgba16Float, scaler.colorTextureUsage.union([.renderTarget, .shaderRead]), "post composite"),
            motion: try make(.rg16Float, scaler.motionTextureUsage.union(.renderTarget), "camera motion"),
            depth: try make(.depth32Float, scaler.depthTextureUsage.union(.renderTarget), "temporal depth"))
        let output = try make(.rgba16Float, scaler.outputTextureUsage.union(.shaderRead), "post temporal output")
        return Entry(size: size, scaler: scaler, inputs: inputs, output: output)
    }

    /// Discards the history at the next resolve (a cut, or the first frame).
    func reset() { resetNext = true }

    /// Resolves the current size's inputs into its HDR output and returns it. `inputs(width:height:)`
    /// must have been called for this frame's size.
    func resolve(commandBuffer: any MTLCommandBuffer, jitterPixels: SIMD2<Float>) -> any MTLTexture {
        guard let c = entries.first else { preconditionFailure("PostTemporal.resolve before inputs") }
        let scaler = c.scaler
        scaler.colorTexture = c.inputs.color
        scaler.depthTexture = c.inputs.depth
        scaler.motionTexture = c.inputs.motion
        scaler.outputTexture = c.output
        scaler.exposureTexture = exposure
        // The projection is shifted by +jitter pixels (x right, y down); MetalFX wants the offset of
        // the sample from the pixel centre in the same convention.
        // (Checked on Railyard: the opposite sign converges visibly softer.)
        scaler.jitterOffsetX = jitterPixels.x
        scaler.jitterOffsetY = jitterPixels.y
        // Motion is in uv units.
        scaler.motionVectorScaleX = Float(c.size.width)
        scaler.motionVectorScaleY = Float(c.size.height)
        scaler.isDepthReversed = true
        scaler.reset = resetNext
        resetNext = false
        scaler.encode(commandBuffer: commandBuffer)
        return c.output
    }
}
