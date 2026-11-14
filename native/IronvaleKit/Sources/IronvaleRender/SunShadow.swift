import simd

/// The sun's shadow camera, ported from src/render/engine.ts (constructor and updateSun): a
/// 110 m square orthographic frustum centred 0.55 x 55 m ahead of the camera on the ground plane,
/// snapped to whole shadow texels along the sun's right and up axes, 160 m back along the sun.
public struct SunShadow: Sendable, Equatable {
    public static let radius: Float = 55
    public static let distance: Float = 160
    public static let near: Float = 1
    public static let bias: Float = -0.0005
    public static let normalBias: Float = 0.04

    public let sunDirection: SIMD3<Float>
    public let mapSize: Int
    public let right: SIMD3<Float>
    public let up: SIMD3<Float>

    public init(sunDirection: SIMD3<Float>, mapSize: Int) {
        let dir = simd_normalize(sunDirection)
        self.sunDirection = dir
        self.mapSize = mapSize
        right = simd_normalize(simd_cross(SIMD3(0, 1, 0), dir))
        up = simd_normalize(simd_cross(dir, right))
    }

    public var texelWorld: Float { Self.radius * 2 / Float(max(1, mapSize)) }

    /// Snapped frustum centre for a camera at `position` looking along `forward`.
    public func center(cameraPosition position: SIMD3<Float>, forward: SIMD3<Float>) -> SIMD3<Float> {
        var flat = SIMD3(forward.x, 0, forward.z)
        if simd_length_squared(flat) > 1e-6 { flat = simd_normalize(flat) }
        let c = position + flat * (Self.radius * 0.55)
        let texel = texelWorld
        let r = jsRound(simd_dot(c, right) / texel) * texel
        let u = jsRound(simd_dot(c, up) / texel) * texel
        let d = simd_dot(c, sunDirection)
        return right * r + up * u + sunDirection * d
    }

    public func viewProjection(cameraPosition: SIMD3<Float>, forward: SIMD3<Float>) -> simd_float4x4 {
        let target = center(cameraPosition: cameraPosition, forward: forward)
        let eye = target + sunDirection * Self.distance
        let view = RenderMath.lookAt(eye: eye, target: target, up: SIMD3(0, 1, 0))
        let projection = RenderMath.orthographic(left: -Self.radius, right: Self.radius, bottom: -Self.radius, top: Self.radius,
                                                 near: Self.near, far: Self.distance * 2)
        return projection * view
    }
}

/// JavaScript's Math.round: halves round toward +infinity.
@inline(__always) func jsRound(_ x: Float) -> Float { (x + 0.5).rounded(.down) }
