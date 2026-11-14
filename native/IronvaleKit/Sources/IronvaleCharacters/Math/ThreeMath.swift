// Quaternion and vector maths with three.js semantics (node_modules/three/src/math/Quaternion.js,
// Vector3.js and Euler.js, three r187), in Double like JavaScript numbers, so the soldier's pose
// matches the web build's to rounding. Used by src/characters/* at commit f14381f.
import Foundation
import simd

public typealias Vec3 = SIMD3<Double>

/// A rotation quaternion stored x, y, z, w like three's Quaternion.
public struct Quat: Sendable, Equatable {
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

    public static let identity = Quat(0, 0, 0, 1)

    public init(array a: [Double]) { self.init(a[0], a[1], a[2], a[3]) }
    public var array: [Double] { [x, y, z, w] }

    /// three's `setFromEuler` for the 'XYZ' order.
    public static func eulerXYZ(_ ex: Double, _ ey: Double, _ ez: Double) -> Quat {
        let c1 = cos(ex / 2), c2 = cos(ey / 2), c3 = cos(ez / 2)
        let s1 = sin(ex / 2), s2 = sin(ey / 2), s3 = sin(ez / 2)
        return Quat(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
                    c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3)
    }

    /// three's `setFromEuler` for the 'YXZ' order.
    public static func eulerYXZ(_ ex: Double, _ ey: Double, _ ez: Double) -> Quat {
        let c1 = cos(ex / 2), c2 = cos(ey / 2), c3 = cos(ez / 2)
        let s1 = sin(ex / 2), s2 = sin(ey / 2), s3 = sin(ez / 2)
        return Quat(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
                    c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3)
    }

    /// three's `setFromAxisAngle` (axis assumed normalised).
    public static func axisAngle(_ axis: Vec3, _ angle: Double) -> Quat {
        let s = sin(angle / 2)
        return Quat(axis.x * s, axis.y * s, axis.z * s, cos(angle / 2))
    }

    /// three's `setFromRotationMatrix` on the basis columns `cx`, `cy`, `cz`.
    public static func fromBasis(_ cx: Vec3, _ cy: Vec3, _ cz: Vec3) -> Quat {
        let m11 = cx.x, m12 = cy.x, m13 = cz.x
        let m21 = cx.y, m22 = cy.y, m23 = cz.y
        let m31 = cx.z, m32 = cy.z, m33 = cz.z
        let trace = m11 + m22 + m33
        if trace > 0 {
            let s = 0.5 / (trace + 1.0).squareRoot()
            return Quat((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s)
        } else if m11 > m22 && m11 > m33 {
            let s = 2.0 * (1.0 + m11 - m22 - m33).squareRoot()
            return Quat(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s)
        } else if m22 > m33 {
            let s = 2.0 * (1.0 + m22 - m11 - m33).squareRoot()
            return Quat((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s)
        } else {
            let s = 2.0 * (1.0 + m33 - m11 - m22).squareRoot()
            return Quat((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s)
        }
    }

    /// three's `multiplyQuaternions(a, b)`: `a * b`. `a.multiply(b)` is `a * b`; `a.premultiply(b)` is `b * a`.
    public static func * (a: Quat, b: Quat) -> Quat {
        Quat(a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
             a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
             a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
             a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z)
    }

    /// three's `invert` (the conjugate; unit quaternions only).
    public var inverse: Quat { Quat(-x, -y, -z, w) }

    public func dot(_ q: Quat) -> Double { x * q.x + y * q.y + z * q.z + w * q.w }
    public var lengthSquared: Double { x * x + y * y + z * z + w * w }

    public var normalized: Quat {
        var l = lengthSquared.squareRoot()
        if l == 0 { return .identity }
        l = 1 / l
        return Quat(x * l, y * l, z * l, w * l)
    }

    /// three r187 `slerp`: no early outs, lerp-and-normalise above a dot of 0.9995.
    public func slerp(_ qb: Quat, _ t: Double) -> Quat {
        var bx = qb.x, by = qb.y, bz = qb.z, bw = qb.w
        var d = dot(qb)
        if d < 0 {
            bx = -bx; by = -by; bz = -bz; bw = -bw
            d = -d
        }
        var s = 1 - t
        var tt = t
        if d < 0.9995 {
            let theta = acos(d)
            let sn = sin(theta)
            s = sin(s * theta) / sn
            tt = sin(tt * theta) / sn
            return Quat(x * s + bx * tt, y * s + by * tt, z * s + bz * tt, w * s + bw * tt)
        }
        return Quat(x * s + bx * tt, y * s + by * tt, z * s + bz * tt, w * s + bw * tt).normalized
    }

    /// three's `angleTo`.
    public func angle(to q: Quat) -> Double { 2 * acos(abs(min(max(dot(q), -1), 1))) }

    /// three's `Vector3.applyQuaternion`.
    public func rotate(_ v: Vec3) -> Vec3 {
        let tx = 2 * (y * v.z - z * v.y)
        let ty = 2 * (z * v.x - x * v.z)
        let tz = 2 * (x * v.y - y * v.x)
        return Vec3(v.x + w * tx + y * tz - z * ty,
                    v.y + w * ty + z * tx - x * tz,
                    v.z + w * tz + x * ty - y * tx)
    }

    public var float: simd_quatf { simd_quatf(ix: Float(x), iy: Float(y), iz: Float(z), r: Float(w)) }
}

extension SIMD3 where Scalar == Double {
    init(array a: [Double]) { self.init(a[0], a[1], a[2]) }
    var array: [Double] { [x, y, z] }
    var length: Double { (x * x + y * y + z * z).squareRoot() }
    var lengthSquared: Double { x * x + y * y + z * z }
    /// three's `normalize`: divide by the length, or by 1 for a zero vector.
    var normalizedThree: Vec3 {
        let l = length
        return self / (l == 0 ? 1 : l)
    }
    func dot(_ v: Vec3) -> Double { x * v.x + y * v.y + z * v.z }
    /// three's `crossVectors(self, v)`.
    func cross(_ v: Vec3) -> Vec3 { Vec3(y * v.z - z * v.y, z * v.x - x * v.z, x * v.y - y * v.x) }
    /// three's `lerp`: self + (v - self) * alpha.
    func lerp(_ v: Vec3, _ alpha: Double) -> Vec3 {
        Vec3(x + (v.x - x) * alpha, y + (v.y - y) * alpha, z + (v.z - z) * alpha)
    }
    /// three's `distanceTo`.
    func distance(_ v: Vec3) -> Double { (self - v).length }
}

/// Math.sin and friends on JS numbers behave as Foundation's do; this is three's `MathUtils.clamp`.
@inline(__always) func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { max(lo, min(hi, v)) }
