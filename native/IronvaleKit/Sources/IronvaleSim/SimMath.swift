// three.js `MathUtils` and `Vector3` operations the sim uses, in three's float64 evaluation order
// (three r187 src/math/MathUtils.js, Vector3.js), plus V8's `Math.hypot`. Ported at commit 185029e.
import Foundation
import IronvaleCore
import IronvaleWorld

public enum MathUtils {
    /// `MathUtils.lerp`: `(1 - t) * x + t * y`.
    @inline(__always) public static func lerp(_ x: Double, _ y: Double, _ t: Double) -> Double { (1 - t) * x + t * y }

    /// `MathUtils.damp`: frame-rate independent exponential approach.
    @inline(__always) public static func damp(_ x: Double, _ y: Double, _ lambda: Double, _ dt: Double) -> Double {
        lerp(x, y, 1 - JSMath.exp(-lambda * dt))
    }

    /// `MathUtils.clamp`: `Math.max(min, Math.min(max, value))`.
    @inline(__always) public static func clamp(_ value: Double, _ lo: Double, _ hi: Double) -> Double {
        Swift.max(lo, Swift.min(hi, value))
    }

    /// `smooth` in controller.ts and `smoothstep` in the view code: `t * t * (3 - 2 * t)`.
    @inline(__always) public static func smooth(_ t: Double) -> Double { t * t * (3 - 2 * t) }

    @inline(__always) public static func clamp01(_ x: Double) -> Double { Swift.min(1, Swift.max(0, x)) }
}

/// V8's `Math.hypot` (builtins/math.tq): scale by the largest magnitude, Kahan-sum the squares.
public func jsHypot(_ values: Double...) -> Double {
    var maxValue = 0.0
    var oneNaN = false
    for v in values {
        let a = abs(v)
        if a.isNaN { oneNaN = true } else if a > maxValue { maxValue = a }
    }
    if maxValue == .infinity { return .infinity }
    if oneNaN { return .nan }
    if maxValue == 0 { return 0 }
    var sum = 0.0
    var compensation = 0.0
    for v in values {
        let n = abs(v) / maxValue
        let summand = n * n - compensation
        let preliminary = sum + summand
        compensation = (preliminary - sum) - summand
        sum = preliminary
    }
    return sum.squareRoot() * maxValue
}

extension Vec3 {
    @inline(__always) public var negated: Vec3 { Vec3(-x, -y, -z) }

    /// `Vector3.divideScalar(s)`: multiplies by `1 / s`.
    @inline(__always) public func divided(by s: Double) -> Vec3 { scaled(1 / s) }

    /// `Vector3.lerpVectors(a, b, t)`: `a + (b - a) * t` per component.
    @inline(__always) public static func lerp(_ a: Vec3, _ b: Vec3, _ t: Double) -> Vec3 {
        Vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)
    }

    /// `Vector3.angleTo`.
    public func angle(to v: Vec3) -> Double {
        let denominator = (lengthSq * v.lengthSq).squareRoot()
        if denominator == 0 { return .pi / 2 }
        let theta = dot(v) / denominator
        return acos(MathUtils.clamp(theta, -1, 1))
    }

    public init(_ array: [Double]) {
        self.init(array[0], array[1], array[2])
    }

    public var array: [Double] { [x, y, z] }
}

/// A first-person camera: position plus Euler angles in three's 'YXZ' order (x pitch, y yaw, z roll).
/// Yaw 0 looks down -Z and positive yaw turns left.
public struct SimCamera: Sendable, Equatable {
    public var position = Vec3.zero
    public var pitch = 0.0
    public var yaw = 0.0
    public var roll = 0.0
    /// Vertical field of view in degrees, from `engine.setFov`.
    public var fov = 78.0

    public init() {}

    /// Column-major rotation matrix (three `Matrix4.makeRotationFromEuler`, order YXZ): columns 0-2.
    public var basis: (right: Vec3, up: Vec3, back: Vec3) {
        let a = JSMath.cos(pitch), b = JSMath.sin(pitch), c = JSMath.cos(yaw), d = JSMath.sin(yaw), e = JSMath.cos(roll), f = JSMath.sin(roll)
        let ce = c * e, cf = c * f, de = d * e, df = d * f
        return (
            Vec3(ce + df * b, a * f, cf * b - de),
            Vec3(de * b - cf, a * e, df + ce * b),
            Vec3(a * d, -b, a * c)
        )
    }

    /// `Object3D.getWorldDirection` for a camera: the -Z axis of its world matrix, normalised.
    public var direction: Vec3 { basis.back.negated.normalized() }

    /// A camera-space offset rotated into world space (`applyQuaternion(camera.quaternion)`).
    public func rotate(_ v: Vec3) -> Vec3 {
        let m = basis
        return Vec3(
            m.right.x * v.x + m.up.x * v.y + m.back.x * v.z,
            m.right.y * v.x + m.up.y * v.y + m.back.y * v.z,
            m.right.z * v.x + m.up.z * v.y + m.back.z * v.z
        )
    }
}

/// Source of uniform values in [0, 1); `Math.random` on the web. Not part of cross-play (weapons map 4.4).
public protocol RandomSource: AnyObject {
    func next() -> Double
}

public final class SystemRandom: RandomSource {
    private var generator = SystemRandomNumberGenerator()
    public init() {}
    public func next() -> Double { Double.random(in: 0 ..< 1, using: &generator) }
}

/// mulberry32 behind `RandomSource`, for repeatable tests.
public final class SeededRandomSource: RandomSource {
    private var random: SeededRandom
    public init(seed: UInt32) { random = SeededRandom(seed: seed) }
    public func next() -> Double { random.next() }
}
