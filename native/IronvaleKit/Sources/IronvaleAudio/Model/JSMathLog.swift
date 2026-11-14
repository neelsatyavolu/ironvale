// `Math.log` and `Math.pow` (`**`) as Node 22's V8 (12.4) computes them: fdlibm 5.3 (Sun
// Microsystems, "Developed at SunSoft... Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice is preserved"), as ported in V8's
// src/base/ieee754.cc (branch-heads/12.4). Darwin's libm differs in the last bit for about 6% of
// log and 9% of pow inputs, and the impulse generator feeds these into recursive filters, so a
// last-bit difference would change the float32 output. As in IronvaleSim's JSMath, every
// `a * b + c` that clang contracts (V8 builds with -ffp-contract=on; clang fuses the left multiply
// of an add or subtract first) is an explicit `fma`. Checked bit for bit against Node 22 on
// 650,000 pow and 200,000 log inputs during the port, and on the committed vectors in
// native/Tools/audio-trace/fixtures/jsmath-vectors.bin by ImpulseParity.jsMathMatchesNode.

import Foundation
import IronvaleSim

extension JSMath {
    @inline(__always) private static func hi(_ x: Double) -> Int32 { Int32(bitPattern: UInt32(truncatingIfNeeded: x.bitPattern >> 32)) }
    @inline(__always) private static func lo(_ x: Double) -> UInt32 { UInt32(truncatingIfNeeded: x.bitPattern) }
    @inline(__always) private static func words(_ h: Int32, _ l: UInt32) -> Double {
        Double(bitPattern: (UInt64(UInt32(bitPattern: h)) << 32) | UInt64(l))
    }
    @inline(__always) private static func withLow(_ x: Double, _ l: UInt32) -> Double { words(hi(x), l) }
    @inline(__always) private static func withHigh(_ x: Double, _ h: Int32) -> Double { words(h, lo(x)) }

    // MARK: log

    public static func log(_ input: Double) -> Double {
        let ln2_hi = 6.93147180369123816490e-01, ln2_lo = 1.90821492927058770002e-10, two54 = 1.80143985094819840000e+16
        let Lg1 = 6.666666666666735130e-01, Lg2 = 3.999999999940941908e-01, Lg3 = 2.857142874366239149e-01
        let Lg4 = 2.222219843214978396e-01, Lg5 = 1.818357216161805012e-01, Lg6 = 1.531383769920937332e-01
        let Lg7 = 1.479819860511658591e-01
        var x = input
        var hx = hi(x)
        let lx = lo(x)
        var k: Int32 = 0
        if hx < 0x0010_0000 {
            if (hx & 0x7fff_ffff) == 0 && lx == 0 { return -.infinity }
            if hx < 0 { return .nan }
            k -= 54
            x *= two54
            hx = hi(x)
        }
        if hx >= 0x7ff0_0000 { return x + x }
        k += (hx >> 20) - 1023
        hx &= 0x000f_ffff
        let i0 = (hx &+ 0x95F64) & 0x10_0000
        x = withHigh(x, hx | (i0 ^ 0x3ff0_0000))
        k += i0 >> 20
        let f = x - 1.0
        if (0x000f_ffff & (2 &+ hx)) < 3 {
            if f == 0 {
                if k == 0 { return 0 }
                let dk = Double(k)
                return fma(dk, ln2_hi, dk * ln2_lo)
            }
            let R = f * f * fma(-0.33333333333333333, f, 0.5)
            if k == 0 { return f - R }
            let dk = Double(k)
            return fma(dk, ln2_hi, -(fma(-dk, ln2_lo, R) - f))
        }
        let s = f / (2.0 + f)
        let dk = Double(k)
        let z = s * s
        var i = hx &- 0x6147A
        let w = z * z
        let j = 0x6B851 &- hx
        let t1 = w * fma(w, fma(w, Lg6, Lg4), Lg2)
        let t2 = z * fma(w, fma(w, fma(w, Lg7, Lg5), Lg3), Lg1)
        i |= j
        let R = t2 + t1
        if i > 0 {
            let hfsq = 0.5 * f * f
            if k == 0 { return f - fma(-s, hfsq + R, hfsq) }
            return fma(dk, ln2_hi, -((hfsq - fma(s, hfsq + R, dk * ln2_lo)) - f))
        }
        if k == 0 { return fma(-s, f - R, f) }
        return fma(dk, ln2_hi, -(fma(s, f - R, -(dk * ln2_lo)) - f))
    }

    // MARK: pow

    private static let bp = [1.0, 1.5]
    private static let dp_h = [0.0, 5.84962487220764160156e-01]
    private static let dp_l = [0.0, 1.35003920212974897128e-08]

    public static func pow(_ x: Double, _ y: Double) -> Double {
        let two53 = 9007199254740992.0, huge = 1.0e300, tiny = 1.0e-300
        let L1 = 5.99999999999994648725e-01, L2 = 4.28571428578550184252e-01, L3 = 3.33333329818377432918e-01
        let L4 = 2.72728123808534006489e-01, L5 = 2.30660745775561754067e-01, L6 = 2.06975017800338417784e-01
        let P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05
        let P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08
        let lg2 = 6.93147180559945286227e-01, lg2_h = 6.93147182464599609375e-01, lg2_l = -1.90465429995776804525e-09
        let ovt = 8.0085662595372944372e-0017
        let cp = 9.61796693925975554329e-01, cp_h = 9.61796700954437255859e-01, cp_l = -7.02846165095275826516e-09
        let ivln2 = 1.44269504088896338700e+00, ivln2_h = 1.44269502162933349609e+00, ivln2_l = 1.92596299112661746887e-08

        let hx = hi(x), lx = lo(x), hy = hi(y), ly = lo(y)
        var ix = hx & 0x7fff_ffff
        let iy = hy & 0x7fff_ffff

        if iy == 0 && ly == 0 { return 1 }
        if ix > 0x7ff0_0000 || (ix == 0x7ff0_0000 && lx != 0) || iy > 0x7ff0_0000 || (iy == 0x7ff0_0000 && ly != 0) { return x + y }

        var yisint: Int32 = 0
        if hx < 0 {
            if iy >= 0x4340_0000 {
                yisint = 2
            } else if iy >= 0x3ff0_0000 {
                let k = (iy >> 20) - 0x3ff
                if k > 20 {
                    let j = Int32(bitPattern: ly >> UInt32(52 - k))
                    if (j << (52 - k)) == Int32(bitPattern: ly) { yisint = 2 - (j & 1) }
                } else if ly == 0 {
                    let j = iy >> (20 - k)
                    if (j << (20 - k)) == iy { yisint = 2 - (j & 1) }
                }
            }
        }

        if ly == 0 {
            if iy == 0x7ff0_0000 {
                if (ix &- 0x3ff0_0000) | Int32(bitPattern: lx) == 0 { return y - y }
                if ix >= 0x3ff0_0000 { return hy >= 0 ? y : 0 }
                return hy < 0 ? -y : 0
            }
            if iy == 0x3ff0_0000 { return hy < 0 ? 1 / x : x }
            if hy == 0x4000_0000 { return x * x }
            if hy == 0x3fe0_0000 && hx >= 0 { return x.squareRoot() }
        }

        var ax = abs(x)
        if lx == 0 && (ix == 0x7ff0_0000 || ix == 0 || ix == 0x3ff0_0000) {
            var z = ax
            if hy < 0 { z = 1 / z }
            if hx < 0 {
                if ((ix &- 0x3ff0_0000) | yisint) == 0 {
                    z = .nan
                } else if yisint == 1 {
                    z = -z
                }
            }
            return z
        }

        var n = (hx >> 31) &+ 1
        if (n | yisint) == 0 { return .nan }
        var s = 1.0
        if (n | (yisint - 1)) == 0 { s = -1 }

        var t1: Double, t2: Double
        if iy > 0x41e0_0000 {
            if iy > 0x43f0_0000 {
                if ix <= 0x3fef_ffff { return hy < 0 ? huge * huge : tiny * tiny }
                if ix >= 0x3ff0_0000 { return hy > 0 ? huge * huge : tiny * tiny }
            }
            if ix < 0x3fef_ffff { return hy < 0 ? s * huge * huge : s * tiny * tiny }
            if ix > 0x3ff0_0000 { return hy > 0 ? s * huge * huge : s * tiny * tiny }
            let t = ax - 1
            let w = (t * t) * fma(-t, fma(-t, 0.25, 0.3333333333333333333333), 0.5)
            let u = ivln2_h * t
            let v = fma(t, ivln2_l, -(w * ivln2))
            t1 = withLow(u + v, 0)
            t2 = v - (t1 - u)
        } else {
            n = 0
            if ix < 0x0010_0000 {
                ax *= two53
                n -= 53
                ix = hi(ax)
            }
            n += (ix >> 20) - 0x3ff
            let j = ix & 0x000f_ffff
            ix = j | 0x3ff0_0000
            var k = 0
            if j <= 0x3988E {
                k = 0
            } else if j < 0xBB67A {
                k = 1
            } else {
                k = 0
                n += 1
                ix -= 0x0010_0000
            }
            ax = withHigh(ax, ix)

            var u = ax - bp[k]
            var v = 1 / (ax + bp[k])
            let ss = u * v
            let s_h = withLow(ss, 0)
            var t_h = words(((ix >> 1) | 0x2000_0000) &+ 0x0008_0000 &+ Int32(k << 18), 0)
            var t_l = ax - (t_h - bp[k])
            let s_l = v * fma(-s_h, t_l, fma(-s_h, t_h, u))
            var s2 = ss * ss
            var r = s2 * s2 * fma(s2, fma(s2, fma(s2, fma(s2, fma(s2, L6, L5), L4), L3), L2), L1)
            r = fma(s_l, s_h + ss, r)
            s2 = s_h * s_h
            t_h = withLow(3.0 + s2 + r, 0)
            t_l = r - ((t_h - 3.0) - s2)
            u = s_h * t_h
            v = fma(s_l, t_h, t_l * ss)
            let p_h = withLow(u + v, 0)
            let p_l = v - (p_h - u)
            let z_h = cp_h * p_h
            let z_l = fma(cp_l, p_h, p_l * cp) + dp_l[k]
            let t = Double(n)
            t1 = withLow(((z_h + z_l) + dp_h[k]) + t, 0)
            t2 = z_l - (((t1 - t) - dp_h[k]) - z_h)
        }

        let y1 = withLow(y, 0)
        let p_l = fma(y - y1, t1, y * t2)
        var p_h = y1 * t1
        var z = p_l + p_h
        let j = hi(z)
        let i = lo(z)
        if j >= 0x4090_0000 {
            if (j &- 0x4090_0000) | Int32(bitPattern: i) != 0 { return s * huge * huge }
            if p_l + ovt > z - p_h { return s * huge * huge }
        } else if (j & 0x7fff_ffff) >= 0x4090_cc00 {
            if (j &- Int32(bitPattern: 0xc090_cc00)) | Int32(bitPattern: i) != 0 { return s * tiny * tiny }
            if p_l <= z - p_h { return s * tiny * tiny }
        }
        let ia = j & 0x7fff_ffff
        var k = (ia >> 20) - 0x3ff
        n = 0
        if ia > 0x3fe0_0000 {
            n = j &+ (0x0010_0000 >> (k + 1))
            k = ((n & 0x7fff_ffff) >> 20) - 0x3ff
            let t = words(n & ~(0x000f_ffff >> k), 0)
            n = ((n & 0x000f_ffff) | 0x0010_0000) >> (20 - k)
            if j < 0 { n = -n }
            p_h -= t
        }
        let t = withLow(p_l + p_h, 0)
        let u = t * lg2_h
        let v = fma(p_l - (t - p_h), lg2, t * lg2_l)
        z = u + v
        let w = v - (z - u)
        let tt = z * z
        let tt1 = fma(-tt, fma(tt, fma(tt, fma(tt, fma(tt, P5, P4), P3), P2), P1), z)
        let r = (z * tt1) / ((tt1 - 2) - fma(z, w, w))
        z = 1 - (r - z)
        var jz = hi(z)
        jz = jz &+ Int32(bitPattern: UInt32(bitPattern: n) << 20)
        if (jz >> 20) <= 0 {
            z = scalbn(z, Int(n))
        } else {
            z = withHigh(z, hi(z) &+ Int32(bitPattern: UInt32(bitPattern: n) << 20))
        }
        return s * z
    }
}
