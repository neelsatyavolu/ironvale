// TRAA, ported from three r187 examples/jsm/tsl/display/TRAANode.js as src/render/pipeline.ts (commit
// 1aca0b7) uses it (PLAN.md 3.3, 11): the scene is rendered with a sub-pixel view offset from a
// 32-entry Halton (2, 3) sequence, and the resolve (Shaders/PostTRAA.metal) blends the HDR composite
// with the reprojected, variance-clipped history at the scene size (renderScale x the dynamic step), as
// the web resolves before bloom and lets the canvas upscale to the display.
// History lives with the scene targets of its size (PostTargets.traa*); a size change, or a step back
// to a kept size whose history is stale, restarts it, as TRAANode restarts when the beauty buffer is
// resized.
import Metal
import ShaderTypes
import simd

@MainActor
final class PostTRAA {
    /// TAAUtils computeHaltonOffsets(32).
    static let phases = 32
    /// TRAANode.useSubpixelCorrection.
    static let useSubpixelCorrection = true

    /// Last frame's camera (view -> world) and inverse projection as rendered (TRAANode updateBefore).
    private var previous: (cameraWorld: simd_float4x4, inverseProjection: simd_float4x4)?
    private var restartNext = true

    /// The view offset of frame `index` in scene pixels (x right, y down): TRAANode.setViewOffset's
    /// halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5 for jitter index i = index mod 32.
    static func jitter(frame index: Int) -> SIMD2<Float> {
        let i = index % phases + 1
        return SIMD2(PostKernels.halton(i, 2) - 0.5, PostKernels.halton(i, 3) - 0.5)
    }

    /// Discards the history at the next resolve (the first frame, or the scene size changed).
    func restart() { restartNext = true }

    /// Resolves `beauty` (the HDR composite at the scene size) into `targets`' next history and returns it.
    func encode(_ commandBuffer: any MTLCommandBuffer, pipeline: any MTLRenderPipelineState, view: inout IVPostView,
                beauty: any MTLTexture, depth: any MTLTexture, targets: PostTargets) -> any MTLTexture {
        let (read, write) = targets.nextTRAAHistory()
        var params = IVTRAAParams(
            previousCameraWorld: previous?.cameraWorld ?? view.cameraWorld,
            previousInverseProjection: previous?.inverseProjection ?? view.inverseProjection,
            restart: restartNext ? 1 : 0, subpixelCorrection: Self.useSubpixelCorrection ? 1 : 0, _pad0: 0, _pad1: 0)
        PostPipelines.draw(commandBuffer, label: "TRAA", pipeline: pipeline, targets: [write.color, write.depth]) { e in
            e.setFragmentBytes(&view, length: MemoryLayout<IVPostView>.stride, index: 0)
            e.setFragmentBytes(&params, length: MemoryLayout<IVTRAAParams>.stride, index: 1)
            e.setFragmentTexture(beauty, index: 0)
            e.setFragmentTexture(depth, index: 1)
            e.setFragmentTexture(read.color, index: 2)
            e.setFragmentTexture(read.depth, index: 3)
        }
        previous = (view.cameraWorld, view.inverseProjection)
        restartNext = false
        return write.color
    }
}
