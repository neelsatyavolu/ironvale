// The effects' cosmetic randomness. The web draws it from Math.random (src/fx/shared.ts randRange,
// randomInCone and the emitters); here it is one mulberry32 stream (IronvaleCore.SeededRandom), so
// the fixtures (native/Contract/fx, Math.random replaced by the same stream) and the parity captures
// (the web page's effect draws replaced the same way) can hold the port to the web's call order.
import IronvaleCore

public final class FXRandom {
    private var source: SeededRandom
    /// Values drawn so far.
    public private(set) var draws = 0

    public init(seed: UInt32) {
        source = SeededRandom(seed: seed)
    }

    public func reseed(_ seed: UInt32) {
        source = SeededRandom(seed: seed)
        draws = 0
    }

    /// Math.random().
    @inline(__always) public func next() -> Double {
        draws += 1
        return source.next()
    }

    /// shared.ts randRange: uniform in [min, max).
    @inline(__always) public func range(_ min: Double, _ max: Double) -> Double { min + next() * (max - min) }

    /// shared.ts randomInCone: a random unit vector within `spread` of `axis`.
    public func inCone(_ axis: D3, _ spread: Double) -> D3 {
        var x = 0.0, y = 0.0, z = 0.0, lengthSq = 0.0
        repeat {
            x = next() * 2 - 1
            y = next() * 2 - 1
            z = next() * 2 - 1
            lengthSq = x * x + y * y + z * z
        } while lengthSq > 1 || lengthSq < 1e-4
        // three's divideScalar multiplies by the reciprocal.
        var out = D3(x, y, z) * (1 / lengthSq.squareRoot())
        if out.dot(axis) < 0 { out = -out }
        return (out * spread).adding(axis, 1 - spread * 0.5).normalized()
    }
}
