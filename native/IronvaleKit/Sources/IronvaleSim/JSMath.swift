// `Math.sin`, `Math.cos` and `Math.exp` as V8 computes them: fdlibm 5.3 (Sun Microsystems,
// "Developed at SunPro... Permission to use, copy, modify, and distribute this software is freely
// granted, provided that this notice is preserved"), as ported in V8's src/base/ieee754.cc.
// Darwin's libm differs from these in the last bit for a few percent of inputs, and a last-bit
// difference in the movement code grows into centimetres at a collision edge, so the sim uses these.
// V8 is built by clang with floating-point contraction on (-ffp-contract=on), so on arm64 each
// `a * b + c` inside one C++ expression is a fused multiply-add. The `fma` calls below mirror the
// contractions clang makes; the result matches Node's Math.sin/cos/exp bit for bit on 200,000 inputs.
import Foundation

public enum JSMath {
    @inline(__always) static func high(_ x: Double) -> Int32 { Int32(bitPattern: UInt32(truncatingIfNeeded: x.bitPattern >> 32)) }
    @inline(__always) static func low(_ x: Double) -> UInt32 { UInt32(truncatingIfNeeded: x.bitPattern) }
    @inline(__always) static func make(_ hi: Int32, _ lo: UInt32) -> Double {
        Double(bitPattern: (UInt64(UInt32(bitPattern: hi)) << 32) | UInt64(lo))
    }

    // MARK: sin / cos

    private static let S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03
    private static let S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06
    private static let S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10
    private static let C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03
    private static let C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07
    private static let C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11

    static func kernelSin(_ x: Double, _ y: Double, _ iy: Int) -> Double {
        let ix = high(x) & 0x7fff_ffff
        if ix < 0x3e40_0000, Int(x) == 0 { return x }
        let z = x * x
        let v = z * x
        let r = fma(z, fma(z, fma(z, fma(z, S6, S5), S4), S3), S2)
        if iy == 0 { return fma(v, fma(z, r, S1), x) }
        return x - fma(-v, S1, fma(z, fma(0.5, y, -(v * r)), -y))
    }

    static func kernelCos(_ x: Double, _ y: Double) -> Double {
        let ix = high(x) & 0x7fff_ffff
        if ix < 0x3e40_0000, Int(x) == 0 { return 1 }
        let z = x * x
        let r = z * fma(z, fma(z, fma(z, fma(z, fma(z, C6, C5), C4), C3), C2), C1)
        if ix < 0x3FD3_3333 { return 1 - fma(0.5, z, -fma(z, r, -(x * y))) }
        let qx = ix > 0x3fe9_0000 ? 0.28125 : make(ix - 0x0020_0000, 0)
        let hz = fma(0.5, z, -qx)
        let a = 1 - qx
        return a - (hz - fma(z, r, -(x * y)))
    }

    private static let invpio2 = 6.36619772367581382433e-01
    private static let pio2_1 = 1.57079632673412561417e+00, pio2_1t = 6.07710050650619224932e-11
    private static let pio2_2 = 6.07710050630396597660e-11, pio2_2t = 2.02226624879595063154e-21
    private static let pio2_3 = 2.02226624871116645580e-21, pio2_3t = 8.47842766036889956997e-32

    /// `__ieee754_rem_pio2` for |x| up to about 2^19 * pi/2 (the medium path); larger angles never
    /// occur in the sim and fall back to libm's reduction.
    static func remPio2(_ x: Double) -> (n: Int, y0: Double, y1: Double) {
        let hx = high(x)
        let ix = hx & 0x7fff_ffff
        if ix <= 0x3fe9_21fb { return (0, x, 0) }
        if ix < 0x4002_d97c {
            if hx > 0 {
                var z = x - pio2_1
                if ix != 0x3ff9_21fb {
                    let y0 = z - pio2_1t
                    return (1, y0, (z - y0) - pio2_1t)
                }
                z -= pio2_2
                let y0 = z - pio2_2t
                return (1, y0, (z - y0) - pio2_2t)
            }
            var z = x + pio2_1
            if ix != 0x3ff9_21fb {
                let y0 = z + pio2_1t
                return (-1, y0, (z - y0) + pio2_1t)
            }
            z += pio2_2
            let y0 = z + pio2_2t
            return (-1, y0, (z - y0) + pio2_2t)
        }
        if ix <= 0x4139_21fb {
            var t = abs(x)
            let n = Int(Int32(fma(t, invpio2, 0.5)))
            let fn = Double(n)
            var r = fma(-fn, pio2_1, t)
            var w = fn * pio2_1t
            let j = Int(ix >> 20)
            var y0 = r - w
            var i = j - Int((high(y0) >> 20) & 0x7ff)
            if i > 16 {
                t = r
                w = fn * pio2_2
                r = t - w
                w = fma(fn, pio2_2t, -((t - r) - w))
                y0 = r - w
                i = j - Int((high(y0) >> 20) & 0x7ff)
                if i > 49 {
                    t = r
                    w = fn * pio2_3
                    r = t - w
                    w = fma(fn, pio2_3t, -((t - r) - w))
                    y0 = r - w
                }
            }
            let y1 = (r - y0) - w
            return hx < 0 ? (-n, -y0, -y1) : (n, y0, y1)
        }
        let n = Int((x / (Double.pi / 2)).rounded())
        return (n, Foundation.remainder(x, Double.pi / 2), 0)
    }

    public static func sin(_ x: Double) -> Double {
        let ix = high(x) & 0x7fff_ffff
        if ix <= 0x3fe9_21fb { return kernelSin(x, 0, 0) }
        if ix >= 0x7ff0_0000 { return .nan }
        let (n, y0, y1) = remPio2(x)
        switch n & 3 {
        case 0: return kernelSin(y0, y1, 1)
        case 1: return kernelCos(y0, y1)
        case 2: return -kernelSin(y0, y1, 1)
        default: return -kernelCos(y0, y1)
        }
    }

    public static func cos(_ x: Double) -> Double {
        let ix = high(x) & 0x7fff_ffff
        if ix <= 0x3fe9_21fb { return kernelCos(x, 0) }
        if ix >= 0x7ff0_0000 { return .nan }
        let (n, y0, y1) = remPio2(x)
        switch n & 3 {
        case 0: return kernelCos(y0, y1)
        case 1: return -kernelSin(y0, y1, 1)
        case 2: return -kernelCos(y0, y1)
        default: return kernelSin(y0, y1, 1)
        }
    }

    // MARK: exp

    private static let ln2HI = [6.93147180369123816490e-01, -6.93147180369123816490e-01]
    private static let ln2LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10]
    private static let halF = [0.5, -0.5]
    private static let invln2 = 1.44269504088896338700e+00
    private static let P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03
    private static let P3 = 6.61375632143793436117e-05, P4 = -1.65339022054652515390e-06
    private static let P5 = 4.13813679705723846039e-08
    private static let twom1000 = 9.33263618503218878990e-302
    private static let two1023 = 8.988465674311579539e307

    public static func exp(_ input: Double) -> Double {
        var x = input
        var hx = high(x)
        let xsb = Int((hx >> 31) & 1)
        hx &= 0x7fff_ffff
        if hx >= 0x4086_2E42 {
            if hx >= 0x7ff0_0000 {
                if ((hx & 0xfffff) | Int32(bitPattern: low(x))) != 0 { return x + x }
                return xsb == 0 ? x : 0
            }
            if x > 7.09782712893383973096e+02 { return .infinity }
            if x < -7.45133219101941108420e+02 { return 0 }
        }
        var hi = 0.0, lo = 0.0
        var k = 0
        if hx > 0x3fd6_2e42 {
            if hx < 0x3FF0_A2B2 {
                // V8 returns e exactly for 1.
                if x == 1 { return 2.718281828459045 }
                hi = x - ln2HI[xsb]
                lo = ln2LO[xsb]
                k = 1 - xsb - xsb
            } else {
                k = Int(Int32(fma(invln2, x, halF[xsb])))
                let t = Double(k)
                hi = fma(-t, ln2HI[0], x)
                lo = t * ln2LO[0]
            }
            x = hi - lo
        } else if hx < 0x3e30_0000 {
            if 1.0e300 + x > 1 { return 1 + x }
        } else {
            k = 0
        }
        let t = x * x
        let twopk = k >= -1021 ? make(Int32(0x3ff0_0000 + (k << 20)), 0) : make(Int32(0x3ff0_0000 + ((k + 1000) << 20)), 0)
        let c = fma(-t, fma(t, fma(t, fma(t, fma(t, P5, P4), P3), P2), P1), x)
        if k == 0 { return 1 - ((x * c) / (c - 2.0) - x) }
        let y = 1 - ((lo - (x * c) / (2.0 - c)) - hi)
        if k >= -1021 {
            if k == 1024 { return y * 2.0 * two1023 }
            return y * twopk
        }
        return y * twopk * twom1000
    }
}
