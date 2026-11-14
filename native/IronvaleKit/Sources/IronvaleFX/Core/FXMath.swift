// The slice of three.js Vector3 / Quaternion / Matrix4 the effects use, in float64 with three's
// evaluation order (three r187 src/math), so CPU-side results track the web to the last bits.
import Darwin
import IronvaleWorld
import simd

public struct D3: Sendable, Equatable {
    public var x: Double, y: Double, z: Double

    @inline(__always) public init(_ x: Double, _ y: Double, _ z: Double) { self.x = x; self.y = y; self.z = z }
    public init(_ v: Vec3) { self.init(v.x, v.y, v.z) }
    public init(_ a: [Double]) { self.init(a[0], a[1], a[2]) }
    public static let zero = D3(0, 0, 0)
    public static let up = D3(0, 1, 0)

    public var vec3: Vec3 { Vec3(x, y, z) }
    public var float3: SIMD3<Float> { SIMD3(Float(x), Float(y), Float(z)) }

    @inline(__always) public static func + (a: D3, b: D3) -> D3 { D3(a.x + b.x, a.y + b.y, a.z + b.z) }
    @inline(__always) public static func - (a: D3, b: D3) -> D3 { D3(a.x - b.x, a.y - b.y, a.z - b.z) }
    @inline(__always) public static prefix func - (a: D3) -> D3 { D3(-a.x, -a.y, -a.z) }
    @inline(__always) public static func * (a: D3, s: Double) -> D3 { D3(a.x * s, a.y * s, a.z * s) }
    /// addScaledVector.
    @inline(__always) public func adding(_ v: D3, _ s: Double) -> D3 { D3(x + v.x * s, y + v.y * s, z + v.z * s) }
    @inline(__always) public func dot(_ v: D3) -> Double { x * v.x + y * v.y + z * v.z }
    @inline(__always) public var lengthSq: Double { x * x + y * y + z * z }
    @inline(__always) public var length: Double { (x * x + y * y + z * z).squareRoot() }
    /// crossVectors(this, v).
    @inline(__always) public func cross(_ v: D3) -> D3 { D3(y * v.z - z * v.y, z * v.x - x * v.z, x * v.y - y * v.x) }
    /// normalize(): divideScalar(length || 1).
    @inline(__always) public func normalized() -> D3 {
        let l = length
        return self * (1 / (l == 0 ? 1 : l))
    }
    @inline(__always) public func distanceSq(_ v: D3) -> Double {
        let dx = x - v.x, dy = y - v.y, dz = z - v.z
        return dx * dx + dy * dy + dz * dz
    }
    @inline(__always) public func distance(_ v: D3) -> Double { distanceSq(v).squareRoot() }
    /// lerp(v, t).
    @inline(__always) public func lerp(_ v: D3, _ t: Double) -> D3 { D3(x + (v.x - x) * t, y + (v.y - y) * t, z + (v.z - z) * t) }

    /// applyQuaternion (three r187).
    @inline(__always) public func applying(_ q: Quat) -> D3 {
        let tx = 2 * (q.y * z - q.z * y)
        let ty = 2 * (q.z * x - q.x * z)
        let tz = 2 * (q.x * y - q.y * x)
        return D3(x + q.w * tx + q.y * tz - q.z * ty,
                  y + q.w * ty + q.z * tx - q.x * tz,
                  z + q.w * tz + q.x * ty - q.y * tx)
    }
}

public struct Quat: Sendable, Equatable {
    public var x: Double, y: Double, z: Double, w: Double

    @inline(__always) public init(_ x: Double, _ y: Double, _ z: Double, _ w: Double) { self.x = x; self.y = y; self.z = z; self.w = w }
    public static let identity = Quat(0, 0, 0, 1)

    /// setFromAxisAngle (axis unit length).
    public static func axisAngle(_ axis: D3, _ angle: Double) -> Quat {
        let half = angle / 2, s = sin(half)
        return Quat(axis.x * s, axis.y * s, axis.z * s, cos(half))
    }

    /// setFromEuler(x, y, 0, 'YXZ'): the player's camera (pitch about X after yaw about Y).
    public static func eulerYXZ(_ ex: Double, _ ey: Double, _ ez: Double) -> Quat {
        let c1 = cos(ex / 2), c2 = cos(ey / 2), c3 = cos(ez / 2)
        let s1 = sin(ex / 2), s2 = sin(ey / 2), s3 = sin(ez / 2)
        return Quat(s1 * c2 * c3 + c1 * s2 * s3,
                    c1 * s2 * c3 - s1 * c2 * s3,
                    c1 * c2 * s3 - s1 * s2 * c3,
                    c1 * c2 * c3 + s1 * s2 * s3)
    }

    /// setFromUnitVectors (three r187).
    public static func fromUnitVectors(_ from: D3, _ to: D3) -> Quat {
        var r = from.dot(to) + 1
        var q: Quat
        if r < 1e-8 {
            r = 0
            if abs(from.x) > abs(from.z) { q = Quat(-from.y, from.x, 0, r) } else { q = Quat(0, -from.z, from.y, r) }
        } else {
            q = Quat(from.y * to.z - from.z * to.y, from.z * to.x - from.x * to.z, from.x * to.y - from.y * to.x, r)
        }
        return q.normalized()
    }

    public func normalized() -> Quat {
        var l = (x * x + y * y + z * z + w * w).squareRoot()
        if l == 0 { return Quat(0, 0, 0, 1) }
        l = 1 / l
        return Quat(x * l, y * l, z * l, w * l)
    }

    /// invert() (conjugate; unit quaternions).
    public var inverse: Quat { Quat(-x, -y, -z, w) }

    /// multiplyQuaternions(a, b): a * b.
    public static func * (a: Quat, b: Quat) -> Quat {
        Quat(a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
             a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
             a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
             a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z)
    }
}

/// Column-major 4x4 writers into float32 instance buffers (three's Matrix4 elements order).
public enum M4 {
    /// compose(position, quaternion, scale).
    @inline(__always)
    public static func compose(_ p: D3, _ q: Quat, _ s: D3, into e: UnsafeMutablePointer<Float>) {
        let x2 = q.x + q.x, y2 = q.y + q.y, z2 = q.z + q.z
        let xx = q.x * x2, xy = q.x * y2, xz = q.x * z2
        let yy = q.y * y2, yz = q.y * z2, zz = q.z * z2
        let wx = q.w * x2, wy = q.w * y2, wz = q.w * z2
        e[0] = Float((1 - (yy + zz)) * s.x); e[1] = Float((xy + wz) * s.x); e[2] = Float((xz - wy) * s.x); e[3] = 0
        e[4] = Float((xy - wz) * s.y); e[5] = Float((1 - (xx + zz)) * s.y); e[6] = Float((yz + wx) * s.y); e[7] = 0
        e[8] = Float((xz + wy) * s.z); e[9] = Float((yz - wx) * s.z); e[10] = Float((1 - (xx + yy)) * s.z); e[11] = 0
        e[12] = Float(p.x); e[13] = Float(p.y); e[14] = Float(p.z); e[15] = 1
    }

    /// makeBasis(a, b, c).scale(s) with position p.
    @inline(__always)
    public static func basis(_ a: D3, _ b: D3, _ c: D3, scale s: D3, position p: D3, into e: UnsafeMutablePointer<Float>) {
        e[0] = Float(a.x * s.x); e[1] = Float(a.y * s.x); e[2] = Float(a.z * s.x); e[3] = 0
        e[4] = Float(b.x * s.y); e[5] = Float(b.y * s.y); e[6] = Float(b.z * s.y); e[7] = 0
        e[8] = Float(c.x * s.z); e[9] = Float(c.y * s.z); e[10] = Float(c.z * s.z); e[11] = 0
        e[12] = Float(p.x); e[13] = Float(p.y); e[14] = Float(p.z); e[15] = 1
    }

    /// makeScale(0, 0, 0): a hidden instance.
    @inline(__always)
    public static func hidden(into e: UnsafeMutablePointer<Float>) {
        for i in 0..<15 { e[i] = 0 }
        e[15] = 1
    }
}

/// three's Color.setHex: an sRGB hex colour converted to linear (ColorManagement on).
public func linearFromHex(_ hex: UInt32) -> D3 {
    func channel(_ v: UInt32) -> Double {
        let c = Double(v & 0xff) / 255
        return c < 0.04045 ? c * 0.0773993808 : pow(c * 0.9478672986 + 0.0521327014, 2.4)
    }
    return D3(channel(hex >> 16), channel(hex >> 8), channel(hex))
}
