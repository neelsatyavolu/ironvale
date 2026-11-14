// Web Audio's BiquadFilterNode low-pass (Audio EQ Cookbook with Q in dB, as the Web Audio spec
// defines it), the panning laws of PannerNode "equalpower" and StereoPannerNode, the master
// limiter and the soft-clip curve of src/audio/graph.ts.

import Foundation

struct Biquad {
    var b0: Float = 1, b1: Float = 0, b2: Float = 0, a1: Float = 0, a2: Float = 0
    var x1L: Float = 0, x2L: Float = 0, y1L: Float = 0, y2L: Float = 0
    var x1R: Float = 0, x2R: Float = 0, y1R: Float = 0, y2R: Float = 0
    var cutoff: Float = -1

    /// Low-pass coefficients for `frequency` Hz with `qDB` resonance, at `sampleRate`.
    mutating func setLowpass(frequency: Float, qDB: Float, sampleRate: Double) {
        cutoff = frequency
        let nyquist = sampleRate / 2
        let normalized = min(1, max(0, Double(frequency) / nyquist))
        if normalized >= 1 {
            (b0, b1, b2, a1, a2) = (1, 0, 0, 0, 0)
            return
        }
        if normalized <= 0 {
            (b0, b1, b2, a1, a2) = (0, 0, 0, 0, 0)
            return
        }
        let w0 = Double.pi * normalized
        let alpha = sin(w0) / (2 * pow(10, Double(qDB) / 20))
        let k = cos(w0)
        let a0 = 1 + alpha
        b0 = Float((1 - k) / 2 / a0)
        b1 = Float((1 - k) / a0)
        b2 = b0
        a1 = Float(-2 * k / a0)
        a2 = Float((1 - alpha) / a0)
    }

    @inline(__always) mutating func left(_ x: Float) -> Float {
        let y = b0 * x + b1 * x1L + b2 * x2L - a1 * y1L - a2 * y2L
        x2L = x1L; x1L = x; y2L = y1L; y1L = y
        return y
    }

    @inline(__always) mutating func right(_ x: Float) -> Float {
        let y = b0 * x + b1 * x1R + b2 * x2R - a1 * y1R - a2 * y2R
        x2R = x1R; x1R = x; y2R = y1R; y1R = y
        return y
    }

    mutating func clearState() {
        (x1L, x2L, y1L, y2L, x1R, x2R, y1R, y2R) = (0, 0, 0, 0, 0, 0, 0, 0)
    }
}

public enum Panning {
    /// PannerNode azimuth in degrees for a source, as the Web Audio spec computes it, folded to
    /// [-90, 90] for equal-power panning. 0 is straight ahead, positive to the right.
    public static func equalPowerAzimuth(listener p: (Double, Double, Double), forward f: (Double, Double, Double),
                                         up u: (Double, Double, Double), source s: (Double, Double, Double)) -> Double {
        let sx = s.0 - p.0, sy = s.1 - p.1, sz = s.2 - p.2
        let sl = jsHypot(sx, sy, sz)
        if sl == 0 { return 0 }
        let src = (sx / sl, sy / sl, sz / sl)
        let fl = jsHypot(f.0, f.1, f.2)
        let fwd = fl == 0 ? (0.0, 0.0, 0.0) : (f.0 / fl, f.1 / fl, f.2 / fl)
        var r = (fwd.1 * u.2 - fwd.2 * u.1, fwd.2 * u.0 - fwd.0 * u.2, fwd.0 * u.1 - fwd.1 * u.0)
        let rl = jsHypot(r.0, r.1, r.2)
        r = rl == 0 ? (0, 0, 0) : (r.0 / rl, r.1 / rl, r.2 / rl)
        let up = (r.1 * fwd.2 - r.2 * fwd.1, r.2 * fwd.0 - r.0 * fwd.2, r.0 * fwd.1 - r.1 * fwd.0)
        let upProjection = src.0 * up.0 + src.1 * up.1 + src.2 * up.2
        var pr = (src.0 - upProjection * up.0, src.1 - upProjection * up.1, src.2 - upProjection * up.2)
        let pl = jsHypot(pr.0, pr.1, pr.2)
        pr = pl == 0 ? (0, 0, 0) : (pr.0 / pl, pr.1 / pl, pr.2 / pl)
        let cosine = max(-1, min(1, pr.0 * r.0 + pr.1 * r.1 + pr.2 * r.2))
        var azimuth = (180 / Double.pi) * acos(cosine)
        if pr.0 * fwd.0 + pr.1 * fwd.1 + pr.2 * fwd.2 < 0 { azimuth = 360 - azimuth }
        azimuth = azimuth >= 0 && azimuth <= 270 ? 90 - azimuth : 450 - azimuth
        if azimuth < -90 { azimuth = -180 - azimuth } else if azimuth > 90 { azimuth = 180 - azimuth }
        return azimuth
    }

    /// Equal-power gains (left, right) for a mono input at a folded azimuth.
    @inline(__always) static func monoGains(azimuth: Double) -> (Float, Float) {
        let x = (azimuth + 90) / 180
        return (Float(cos(x * Double.pi / 2)), Float(sin(x * Double.pi / 2)))
    }

    /// The stereo-input law shared by PannerNode (azimuth / 90) and StereoPannerNode (pan):
    /// returns (x, leftSide) where the moving channel's gains are cos and sin of x * pi / 2.
    @inline(__always) static func stereoLaw(_ pan: Double) -> (cosine: Float, sine: Float, toLeft: Bool) {
        if pan <= 0 {
            let x = pan + 1
            return (Float(cos(x * Double.pi / 2)), Float(sin(x * Double.pi / 2)), true)
        }
        return (Float(cos(pan * Double.pi / 2)), Float(sin(pan * Double.pi / 2)), false)
    }
}

/// Master limiter after the DynamicsCompressorNode settings in graph.ts (threshold -8 dB, knee 4,
/// ratio 20, attack 2 ms, release 140 ms), with the browser's automatic make-up gain, which
/// LIMITER_TRIM then takes back.
struct Limiter {
    static let threshold = -8.0, knee = 4.0, ratio = 20.0, attack = 0.002, release = 0.14
    private var envelopeDB = 0.0
    private let attackCoef: Double
    private let releaseCoef: Double
    let makeup: Float

    init(sampleRate: Double) {
        attackCoef = exp(-1 / (Limiter.attack * sampleRate))
        releaseCoef = exp(-1 / (Limiter.release * sampleRate))
        // Chrome: make-up = (1 / gain at full scale)^0.6.
        let full = Limiter.staticCurve(0)
        makeup = Float(pow(1 / pow(10, full / 20), 0.6))
    }

    /// Gain change in dB for an input level in dB (soft knee).
    static func staticCurve(_ inputDB: Double) -> Double {
        let over = inputDB - threshold
        if 2 * over < -knee { return 0 }
        if 2 * abs(over) <= knee {
            let x = over + knee / 2
            return (1 / ratio - 1) * x * x / (2 * knee)
        }
        return (1 / ratio - 1) * over
    }

    /// Gain to apply for a sample whose larger channel magnitude is `peak`.
    @inline(__always) mutating func gain(peak: Float) -> Float {
        let inputDB = peak > 1e-6 ? 20 * log10(Double(peak)) : -120
        let wanted = Limiter.staticCurve(inputDB)
        let coef = wanted < envelopeDB ? attackCoef : releaseCoef
        envelopeDB = wanted + (envelopeDB - wanted) * coef
        return Float(pow(10, envelopeDB / 20)) * makeup
    }
}

/// graph.ts softClipCurve: linear to 0.85, then eased toward 0.98 and never past it.
struct SoftClip {
    static let size = 2049
    let curve: UnsafeMutablePointer<Float>

    init() {
        curve = .allocate(capacity: SoftClip.size)
        let knee = 0.85
        for i in 0..<SoftClip.size {
            let x = (Double(i) / Double(SoftClip.size - 1)) * 2 - 1
            let magnitude = abs(x)
            let shaped = magnitude <= knee ? magnitude : knee + (0.98 - knee) * tanh((magnitude - knee) / (0.98 - knee))
            curve[i] = Float((x > 0 ? 1 : x < 0 ? -1 : 0) * shaped)
        }
    }

    func free() { curve.deallocate() }

    /// WaveShaperNode lookup with linear interpolation (oversample "none").
    @inline(__always) func apply(_ x: Float) -> Float {
        let v = (x + 1) * 0.5 * Float(SoftClip.size - 1)
        if !(v > 0) { return curve[0] }
        if v >= Float(SoftClip.size - 1) { return curve[SoftClip.size - 1] }
        let k = Int(v)
        let f = v - Float(k)
        return curve[k] + (curve[k + 1] - curve[k]) * f
    }
}
