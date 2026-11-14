// The few three.js math operations the first-person rig uses (three r180 Quaternion, Matrix4,
// Vector3, Object3D), in Double so the native rig matches the web's float64 poses. Ported from
// node_modules/three/src/math at the version the web build pins (package.json), at commit a487033.
import simd

public typealias RVec3 = SIMD3<Double>

/// three's Quaternion (x, y, z, w), with its operation order.
public struct RQuat: Sendable, Equatable {
    public var x: Double
    public var y: Double
    public var z: Double
    public var w: Double

    public init(_ x: Double, _ y: Double, _ z: Double, _ w: Double) {
        self.x = x
        self.y = y
        self.z = z
        self.w = w
    }

    public static let identity = RQuat(0, 0, 0, 1)

    /// `setFromEuler(new Euler(x, y, z, 'YXZ'))`.
    public static func eulerYXZ(_ ex: Double, _ ey: Double, _ ez: Double) -> RQuat {
        let c1 = cos(ex / 2), c2 = cos(ey / 2), c3 = cos(ez / 2)
        let s1 = sin(ex / 2), s2 = sin(ey / 2), s3 = sin(ez / 2)
        return RQuat(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
                     c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3)
    }

    /// `setFromEuler(new Euler(x, y, z, 'XYZ'))`, the Object3D default order.
    public static func eulerXYZ(_ ex: Double, _ ey: Double, _ ez: Double) -> RQuat {
        let c1 = cos(ex / 2), c2 = cos(ey / 2), c3 = cos(ez / 2)
        let s1 = sin(ex / 2), s2 = sin(ey / 2), s3 = sin(ez / 2)
        return RQuat(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
                     c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3)
    }

    /// `setFromAxisAngle` (axis unit length).
    public static func axisAngle(_ axis: RVec3, _ angle: Double) -> RQuat {
        let s = sin(angle / 2)
        return RQuat(axis.x * s, axis.y * s, axis.z * s, cos(angle / 2))
    }

    /// `multiplyQuaternions(a, b)`.
    public static func * (a: RQuat, b: RQuat) -> RQuat {
        RQuat(a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
              a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
              a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
              a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z)
    }

    /// three's `invert()` is the conjugate.
    public var inverse: RQuat { RQuat(-x, -y, -z, w) }

    /// `Vector3.applyQuaternion`.
    public func rotate(_ v: RVec3) -> RVec3 {
        let tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x)
        return RVec3(v.x + w * tx + y * tz - z * ty, v.y + w * ty + z * tx - x * tz, v.z + w * tz + x * ty - y * tx)
    }

    /// `slerpQuaternions(self, b, t)`.
    public func slerp(_ qb: RQuat, _ t: Double) -> RQuat {
        if t == 0 { return self }
        if t == 1 { return qb }
        var cosHalf = w * qb.w + x * qb.x + y * qb.y + z * qb.z
        var r = qb
        if cosHalf < 0 {
            r = RQuat(-qb.x, -qb.y, -qb.z, -qb.w)
            cosHalf = -cosHalf
        }
        if cosHalf >= 1 { return self }
        let sqrSin = 1 - cosHalf * cosHalf
        if sqrSin <= Double.ulpOfOne {
            let s = 1 - t
            return RQuat(s * x + t * r.x, s * y + t * r.y, s * z + t * r.z, s * w + t * r.w).normalized
        }
        let sinHalf = sqrSin.squareRoot()
        let half = atan2(sinHalf, cosHalf)
        let a = sin((1 - t) * half) / sinHalf, b = sin(t * half) / sinHalf
        return RQuat(x * a + r.x * b, y * a + r.y * b, z * a + r.z * b, w * a + r.w * b)
    }

    public var normalized: RQuat {
        let l = (x * x + y * y + z * z + w * w).squareRoot()
        return l == 0 ? .identity : RQuat(x / l, y / l, z / l, w / l)
    }

    /// `setFromRotationMatrix` (upper 3x3 a pure rotation).
    public static func fromRotation(_ m: simd_double4x4) -> RQuat {
        let m11 = m[0][0], m12 = m[1][0], m13 = m[2][0]
        let m21 = m[0][1], m22 = m[1][1], m23 = m[2][1]
        let m31 = m[0][2], m32 = m[1][2], m33 = m[2][2]
        let trace = m11 + m22 + m33
        if trace > 0 {
            let s = 0.5 / (trace + 1).squareRoot()
            return RQuat((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s)
        } else if m11 > m22, m11 > m33 {
            let s = 2 * (1 + m11 - m22 - m33).squareRoot()
            return RQuat(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s)
        } else if m22 > m33 {
            let s = 2 * (1 + m22 - m11 - m33).squareRoot()
            return RQuat((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s)
        } else {
            let s = 2 * (1 + m33 - m11 - m22).squareRoot()
            return RQuat((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s)
        }
    }
}

public enum RMat {
    /// `Matrix4.compose`.
    public static func compose(_ p: RVec3, _ q: RQuat, _ s: RVec3) -> simd_double4x4 {
        let x2 = q.x + q.x, y2 = q.y + q.y, z2 = q.z + q.z
        let xx = q.x * x2, xy = q.x * y2, xz = q.x * z2
        let yy = q.y * y2, yz = q.y * z2, zz = q.z * z2
        let wx = q.w * x2, wy = q.w * y2, wz = q.w * z2
        return simd_double4x4(columns: (
            SIMD4((1 - (yy + zz)) * s.x, (xy + wz) * s.x, (xz - wy) * s.x, 0),
            SIMD4((xy - wz) * s.y, (1 - (xx + zz)) * s.y, (yz + wx) * s.y, 0),
            SIMD4((xz + wy) * s.z, (yz - wx) * s.z, (1 - (xx + yy)) * s.z, 0),
            SIMD4(p.x, p.y, p.z, 1)))
    }

    /// `Matrix4.decompose`.
    public static func decompose(_ m: simd_double4x4) -> (position: RVec3, quaternion: RQuat, scale: RVec3) {
        var sx = simd_length(SIMD3(m[0][0], m[0][1], m[0][2]))
        let sy = simd_length(SIMD3(m[1][0], m[1][1], m[1][2]))
        let sz = simd_length(SIMD3(m[2][0], m[2][1], m[2][2]))
        if simd_determinant(m) < 0 { sx = -sx }
        var r = m
        r[0] /= sx
        r[1] /= sy
        r[2] /= sz
        return (RVec3(m[3][0], m[3][1], m[3][2]), RQuat.fromRotation(r), RVec3(sx, sy, sz))
    }

    public static func position(_ m: simd_double4x4) -> RVec3 { RVec3(m[3][0], m[3][1], m[3][2]) }

    /// `Vector3.applyMatrix4` (with the perspective divide three does).
    public static func apply(_ m: simd_double4x4, _ v: RVec3) -> RVec3 {
        let r = m * SIMD4(v, 1)
        return RVec3(r.x, r.y, r.z) / r.w
    }

    /// `Matrix4.makeBasis(x, y, z)`.
    public static func basis(_ x: RVec3, _ y: RVec3, _ z: RVec3) -> simd_double4x4 {
        simd_double4x4(columns: (SIMD4(x, 0), SIMD4(y, 0), SIMD4(z, 0), SIMD4(0, 0, 0, 1)))
    }
}

extension SIMD3 where Scalar == Double {
    /// `normalize()`: a zero vector stays zero.
    var unit: RVec3 {
        let l = simd_length(self)
        return l == 0 ? self : self / l
    }
}
