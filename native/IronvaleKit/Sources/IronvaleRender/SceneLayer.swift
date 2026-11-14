// Extra geometry a scene renderer draws inside its own passes, with its frame uniforms, lights,
// environment and shadow map already bound (M7a: soldiers inside the map's sun shadow and scene
// passes). IronvaleMapRender cannot import IronvaleCharacters, so the soldiers come in through this.
import Metal
import simd

@MainActor
public protocol SceneLayer: AnyObject {
    /// Once per frame, before either pass: cull against the camera and write per-frame buffers.
    func prepare(viewProjection: simd_float4x4, eye: SIMD3<Float>)
    /// Inside the sun shadow pass (depth only).
    func encodeShadow(_ encoder: any MTLRenderCommandEncoder)
    /// Inside the scene pass, after the opaque geometry.
    func encodeScene(_ encoder: any MTLRenderCommandEncoder)
    /// Inside the scene pass, after the sky and the map's transparent draws (M9 effects: decals,
    /// particles, rain, tracers, flashes). Default: nothing.
    func encodeTransparent(_ encoder: any MTLRenderCommandEncoder)
}

public extension SceneLayer {
    func encodeTransparent(_ encoder: any MTLRenderCommandEncoder) {}
}
