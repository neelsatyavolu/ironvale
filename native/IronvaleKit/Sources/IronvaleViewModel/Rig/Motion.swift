// Ported from src/weapons/view/motion.ts at commit a487033: numeric helpers for procedural
// view-model motion. MAX_SPRING_STEP comes from Contract/viewmodel.json.
import Foundation

public enum Motion {
    public static func clamp01(_ value: Double) -> Double { value < 0 ? 0 : value > 1 ? 1 : value }

    public static func smoothstep(_ t: Double) -> Double {
        let x = clamp01(t)
        return x * x * (3 - 2 * x)
    }

    /// 0 before `from`, 1 after `to`, eased in between.
    public static func ramp(_ from: Double, _ to: Double, _ time: Double) -> Double {
        if to <= from { return time >= to ? 1 : 0 }
        return smoothstep((time - from) / (to - from))
    }

    /// Frame-rate independent exponential approach.
    public static func damp(_ current: Double, _ target: Double, _ rate: Double, _ dt: Double) -> Double {
        current + (target - current) * (1 - exp(-rate * dt))
    }

    public static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { max(lo, min(hi, v)) }
}

/// Damped spring toward zero (or a target), driven by impulses; sub-stepped at `maxStep`.
public struct Spring: Sendable {
    public var value = 0.0
    public var velocity = 0.0
    let stiffness: Double
    let damping: Double
    let maxStep: Double

    public init(_ constants: [Double]?, maxStep: Double) {
        stiffness = constants?[0] ?? 0
        damping = constants?[1] ?? 0
        self.maxStep = maxStep
    }

    public mutating func kick(_ impulse: Double) { velocity += impulse }

    @discardableResult
    public mutating func step(_ dt: Double, target: Double = 0) -> Double {
        var remaining = dt
        while remaining > 1e-6 {
            let h = min(remaining, maxStep)
            velocity += ((target - value) * stiffness - velocity * damping) * h
            value += velocity * h
            remaining -= h
        }
        return value
    }

    public mutating func reset() {
        value = 0
        velocity = 0
    }
}
