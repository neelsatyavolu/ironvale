import simd

/// Matrix helpers for the renderer. Column-major, right-handed, camera looking down -Z (three's
/// convention), Metal clip depth 0...1.
public enum RenderMath {
    /// Reverse-Z perspective: the near plane maps to depth 1 and the far plane to depth 0.
    public static func perspectiveReverseZ(fovYRadians: Float, aspect: Float, near: Float, far: Float) -> simd_float4x4 {
        let y = 1 / tan(fovYRadians * 0.5)
        let x = y / aspect
        let a = near / (far - near)
        let b = near * far / (far - near)
        return simd_float4x4(columns: (
            SIMD4(x, 0, 0, 0),
            SIMD4(0, y, 0, 0),
            SIMD4(0, 0, a, -1),
            SIMD4(0, 0, b, 0)
        ))
    }

    /// Orthographic projection with depth 0 at `near` and 1 at `far` (in front of the camera).
    public static func orthographic(left: Float, right: Float, bottom: Float, top: Float, near: Float, far: Float) -> simd_float4x4 {
        let sx = 2 / (right - left)
        let sy = 2 / (top - bottom)
        let sz = -1 / (far - near)
        return simd_float4x4(columns: (
            SIMD4(sx, 0, 0, 0),
            SIMD4(0, sy, 0, 0),
            SIMD4(0, 0, sz, 0),
            SIMD4(-(right + left) / (right - left), -(top + bottom) / (top - bottom), -near / (far - near), 1)
        ))
    }

    /// View matrix of a camera at `eye` looking at `target` (three's Object3D.lookAt for cameras).
    public static func lookAt(eye: SIMD3<Float>, target: SIMD3<Float>, up: SIMD3<Float>) -> simd_float4x4 {
        let z = simd_normalize(eye - target)
        let x = simd_normalize(simd_cross(up, z))
        let y = simd_cross(z, x)
        let world = simd_float4x4(columns: (
            SIMD4(x, 0), SIMD4(y, 0), SIMD4(z, 0), SIMD4(eye, 1)
        ))
        return world.inverse
    }

    public static func translation(_ t: SIMD3<Float>) -> simd_float4x4 {
        var m = matrix_identity_float4x4
        m.columns.3 = SIMD4(t, 1)
        return m
    }

    public static func rotationY(_ a: Float) -> simd_float4x4 {
        let c = cos(a), s = sin(a)
        return simd_float4x4(columns: (SIMD4(c, 0, -s, 0), SIMD4(0, 1, 0, 0), SIMD4(s, 0, c, 0), SIMD4(0, 0, 0, 1)))
    }

    public static func rotationX(_ a: Float) -> simd_float4x4 {
        let c = cos(a), s = sin(a)
        return simd_float4x4(columns: (SIMD4(1, 0, 0, 0), SIMD4(0, c, s, 0), SIMD4(0, -s, c, 0), SIMD4(0, 0, 0, 1)))
    }

    public static func rotationZ(_ a: Float) -> simd_float4x4 {
        let c = cos(a), s = sin(a)
        return simd_float4x4(columns: (SIMD4(c, s, 0, 0), SIMD4(-s, c, 0, 0), SIMD4(0, 0, 1, 0), SIMD4(0, 0, 0, 1)))
    }

    /// Inverse-transpose of the upper 3x3, stored in a 4x4 for the shader.
    public static func normalMatrix(_ m: simd_float4x4) -> simd_float4x4 {
        let m3 = simd_float3x3(SIMD3(m.columns.0.x, m.columns.0.y, m.columns.0.z),
                               SIMD3(m.columns.1.x, m.columns.1.y, m.columns.1.z),
                               SIMD3(m.columns.2.x, m.columns.2.y, m.columns.2.z))
        let n = m3.inverse.transpose
        return simd_float4x4(columns: (SIMD4(n.columns.0, 0), SIMD4(n.columns.1, 0), SIMD4(n.columns.2, 0), SIMD4(0, 0, 0, 1)))
    }

    /// three's Color.setHex on an sRGB hex value, converted to linear (ColorManagement on).
    public static func linearFromSRGBHex(_ hex: UInt32) -> SIMD3<Float> {
        func channel(_ v: UInt32) -> Float {
            let c = Float(v & 0xff) / 255
            return c < 0.04045 ? c * 0.0773993808 : pow(c * 0.9478672986 + 0.0521327014, 2.4)
        }
        return SIMD3(channel(hex >> 16), channel(hex >> 8), channel(hex))
    }

    /// A hex already in linear sRGB (map-export writes Color.getHex(LinearSRGBColorSpace)).
    public static func linearHex(_ hex: UInt32) -> SIMD3<Float> {
        SIMD3(Float((hex >> 16) & 0xff), Float((hex >> 8) & 0xff), Float(hex & 0xff)) / 255
    }
}

/// A first-person camera pose as the web's `?pose=x,y,z,yawDeg,pitchDeg` (src/main.ts) and
/// `PlayerController.applyCamera` (src/player/controller.ts): feet position, eye 1.64 m above,
/// rotation order YXZ, looking down -Z at yaw 0.
public struct CameraPose: Sendable, Equatable {
    public static let standEye: Float = 1.64

    public var eye: SIMD3<Float>
    public var yaw: Float
    public var pitch: Float
    /// Rotation about the view axis, after yaw and pitch (three's YXZ Euler z; the M9 blast shake).
    public var roll: Float = 0

    public init(eye: SIMD3<Float>, yaw: Float, pitch: Float) {
        self.eye = eye
        self.yaw = yaw
        self.pitch = pitch
    }

    /// Parses `x,y,z,yawDeg,pitchDeg` (feet position) into an eye-height pose.
    public init?(webPose text: String) {
        let parts = text.split(separator: ",").compactMap { Float($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 5, parts.allSatisfy(\.isFinite) else { return nil }
        let deg = Float.pi / 180
        self.init(eye: SIMD3(parts[0], parts[1] + Self.standEye, parts[2]), yaw: parts[3] * deg, pitch: parts[4] * deg)
    }

    public var world: simd_float4x4 {
        roll == 0 ? RenderMath.translation(eye) * RenderMath.rotationY(yaw) * RenderMath.rotationX(pitch)
            : RenderMath.translation(eye) * RenderMath.rotationY(yaw) * RenderMath.rotationX(pitch) * RenderMath.rotationZ(roll)
    }

    public var view: simd_float4x4 { world.inverse }

    public var forward: SIMD3<Float> {
        let f = world * SIMD4<Float>(0, 0, -1, 0)
        return SIMD3(f.x, f.y, f.z)
    }
}
