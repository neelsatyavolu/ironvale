// Ported from three.js r187 `src/math/Vector3.js` and `Box3.js` (the subset collision uses), as
// imported by src/world/collision.ts at commit 185029e.
//
// Every operation keeps three's float64 evaluation order so results are bit-identical to the web.
// Do not replace these with simd helpers: simd_dot and friends may reassociate or fuse.

public struct Vec3: Sendable, Equatable, CustomStringConvertible {
    public var x: Double
    public var y: Double
    public var z: Double

    public init(_ x: Double, _ y: Double, _ z: Double) {
        self.x = x
        self.y = y
        self.z = z
    }

    public static let zero = Vec3(0, 0, 0)

    public var description: String { "(\(x), \(y), \(z))" }

    @inline(__always) public static func - (a: Vec3, b: Vec3) -> Vec3 { Vec3(a.x - b.x, a.y - b.y, a.z - b.z) }
    @inline(__always) public static func + (a: Vec3, b: Vec3) -> Vec3 { Vec3(a.x + b.x, a.y + b.y, a.z + b.z) }

    /// `Vector3.multiplyScalar`.
    @inline(__always) public func scaled(_ s: Double) -> Vec3 { Vec3(x * s, y * s, z * s) }

    /// `Vector3.addScaledVector(v, s)`: `x += v.x * s`.
    @inline(__always) public func adding(_ v: Vec3, scaledBy s: Double) -> Vec3 {
        Vec3(x + v.x * s, y + v.y * s, z + v.z * s)
    }

    @inline(__always) public func dot(_ v: Vec3) -> Double { x * v.x + y * v.y + z * v.z }

    @inline(__always) public var lengthSq: Double { x * x + y * y + z * z }

    @inline(__always) public var length: Double { (x * x + y * y + z * z).squareRoot() }

    /// `Vector3.crossVectors(this, v)`.
    @inline(__always) public func cross(_ v: Vec3) -> Vec3 {
        Vec3(y * v.z - z * v.y, z * v.x - x * v.z, x * v.y - y * v.x)
    }

    /// `Vector3.normalize`: `divideScalar(length || 1)`, which multiplies by the reciprocal.
    @inline(__always) public func normalized() -> Vec3 {
        let len = length
        return scaled(1 / (len == 0 || len.isNaN ? 1 : len))
    }

    @inline(__always) public func distanceToSquared(_ v: Vec3) -> Double {
        let dx = x - v.x, dy = y - v.y, dz = z - v.z
        return dx * dx + dy * dy + dz * dz
    }

    @inline(__always) public func distance(to v: Vec3) -> Double { distanceToSquared(v).squareRoot() }

    @inline(__always) public subscript(axis: Int) -> Double {
        switch axis {
        case 0: return x
        case 1: return y
        default: return z
        }
    }
}

/// Axis-aligned box with three's `Box3` semantics (empty = +inf min, -inf max).
public struct Box3: Sendable, Equatable {
    public var min: Vec3
    public var max: Vec3

    public init(min: Vec3, max: Vec3) {
        self.min = min
        self.max = max
    }

    public static let empty = Box3(
        min: Vec3(.infinity, .infinity, .infinity),
        max: Vec3(-.infinity, -.infinity, -.infinity)
    )

    /// `Box3.expandByPoint` (`Math.min`/`Math.max` per component).
    public func expanded(by p: Vec3) -> Box3 {
        Box3(
            min: Vec3(jsMin(min.x, p.x), jsMin(min.y, p.y), jsMin(min.z, p.z)),
            max: Vec3(jsMax(max.x, p.x), jsMax(max.y, p.y), jsMax(max.z, p.z))
        )
    }

    /// `Box3.expandByScalar`: `addScalar(-s)` on min, `addScalar(s)` on max.
    public func expanded(byScalar s: Double) -> Box3 {
        Box3(min: Vec3(min.x + -s, min.y + -s, min.z + -s), max: Vec3(max.x + s, max.y + s, max.z + s))
    }

    /// `Box3.intersectsBox`.
    @inline(__always) public func intersects(_ b: Box3) -> Bool {
        b.max.x >= min.x && b.min.x <= max.x && b.max.y >= min.y && b.min.y <= max.y && b.max.z >= min.z && b.min.z <= max.z
    }
}

/// `Math.min` for two numbers: NaN wins, and -0 is below +0.
@inline(__always) func jsMin(_ a: Double, _ b: Double) -> Double {
    if a.isNaN || b.isNaN { return .nan }
    if a == b { return a.sign == .minus ? a : b }
    return a < b ? a : b
}

/// `Math.max` for two numbers: NaN wins, and +0 is above -0.
@inline(__always) func jsMax(_ a: Double, _ b: Double) -> Double {
    if a.isNaN || b.isNaN { return .nan }
    if a == b { return a.sign == .minus ? b : a }
    return a > b ? a : b
}
