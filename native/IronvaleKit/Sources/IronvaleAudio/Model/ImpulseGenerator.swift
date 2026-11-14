// Ported from src/audio/impulse.ts at commit cbe0add.
// Procedural impulse responses for the convolution reverbs, generated once at startup. Each preset
// is decaying noise whose tone darkens over time, plus discrete early reflections.
//
// The output must equal the web's bit for bit (native/Tools/audio-trace/fixtures/impulses.json):
// the arithmetic is done in Double exactly in the TypeScript order, every store into a channel is
// rounded to Float32 as a Float32Array store is, and Math.exp / Math.pow / Math.log are V8's
// fdlibm versions (JSMath), never Darwin libm.

import Foundation
import IronvaleCore
import IronvaleSim
import IronvaleWorld

public struct ImpulseSpec: Sendable {
    public let rt60: Double
    public let length: Double
    public let brightStart: Double
    public let brightEnd: Double
    public let lowCut: Double
    public let preDelay: Double
    public let tailLevel: Double
    public let taps: [(Double, Double)]
    public let scatter: Int
    public let scatterSpan: Double
    public let ring: Double
    public let level: Double
}

public enum ImpulseGenerator {
    /// The order graph.ts builds them in.
    public static let presets: [ReverbPreset] = [.openField, .forest, .street, .industrial, .interior]

    public static func spec(_ preset: ReverbPreset) -> ImpulseSpec {
        switch preset {
        case .openField:
            ImpulseSpec(rt60: 2.1, length: 2.6, brightStart: 6000, brightEnd: 1200, lowCut: 320, preDelay: 0.09, tailLevel: 0.32,
                        taps: [(0.12, 0.5), (0.21, 0.34), (0.37, 0.26), (0.58, 0.16)], scatter: 5, scatterSpan: 0.7, ring: 0, level: 0.75)
        case .forest:
            ImpulseSpec(rt60: 1.15, length: 1.6, brightStart: 3600, brightEnd: 700, lowCut: 180, preDelay: 0.025, tailLevel: 0.8,
                        taps: [], scatter: 46, scatterSpan: 0.28, ring: 0, level: 0.85)
        case .street:
            ImpulseSpec(rt60: 0.95, length: 1.4, brightStart: 8000, brightEnd: 1800, lowCut: 200, preDelay: 0.02, tailLevel: 0.45,
                        taps: [(0.055, 0.8), (0.11, 0.55), (0.165, 0.36), (0.22, 0.22), (0.275, 0.13)], scatter: 8, scatterSpan: 0.2, ring: 0, level: 0.85)
        case .industrial:
            ImpulseSpec(rt60: 2.6, length: 3.0, brightStart: 9000, brightEnd: 2200, lowCut: 150, preDelay: 0.03, tailLevel: 0.7,
                        taps: [(0.07, 0.45), (0.13, 0.3)], scatter: 16, scatterSpan: 0.4, ring: 0.0093, level: 0.8)
        case .interior:
            ImpulseSpec(rt60: 0.5, length: 0.75, brightStart: 7000, brightEnd: 2500, lowCut: 120, preDelay: 0.004, tailLevel: 1,
                        taps: [(0.009, 0.7), (0.017, 0.55), (0.026, 0.4)], scatter: 30, scatterSpan: 0.06, ring: 0, level: 1)
        }
    }

    /// The web's seed for a preset: FNV-1a of its id (graph.ts).
    public static func seed(_ preset: ReverbPreset) -> UInt32 { hashString(preset.rawValue) }

    /// The impulse graph.ts builds for `preset` at `sampleRate`.
    public static func generate(_ preset: ReverbPreset, sampleRate: Double) -> (left: [Float], right: [Float]) {
        var random = SeededRandom(seed: seed(preset))
        return generate(preset, sampleRate: sampleRate) { random.next() }
    }

    /// `generateImpulse(preset, sampleRate, random)`.
    public static func generate(_ preset: ReverbPreset, sampleRate: Double, random: () -> Double) -> (left: [Float], right: [Float]) {
        let spec = spec(preset)
        let length = Int((spec.length * sampleRate).rounded(.down))
        var channels: [[Float]] = [[Float](repeating: 0, count: length), [Float](repeating: 0, count: length)]
        let decayPerSample = JSMath.log(0.001) / (spec.rt60 * sampleRate)
        let preDelay = Int((spec.preDelay * sampleRate).rounded(.down))
        let highpass = JSMath.exp((-2 * Double.pi * spec.lowCut) / sampleRate)

        for c in 0..<2 {
            channels[c].withUnsafeMutableBufferPointer { data in
                var low = 0.0, hpState = 0.0, previous = 0.0
                if preDelay < length {
                    for i in preDelay..<length {
                        let t = Double(i - preDelay) / Double(length - preDelay)
                        let cutoff = spec.brightStart * JSMath.pow(spec.brightEnd / spec.brightStart, t)
                        let a = 1 - JSMath.exp((-2 * Double.pi * cutoff) / sampleRate)
                        low += a * (random() * 2 - 1 - low)
                        hpState = highpass * (hpState + low - previous)
                        previous = low
                        let swell = Swift.min(1, Double(i - preDelay) / (0.006 * sampleRate))
                        data[i] = Float(hpState * JSMath.exp(decayPerSample * Double(i - preDelay)) * swell)
                    }
                }
                var tailPeak = peak(data)
                if tailPeak == 0 { tailPeak = 1 }
                for i in 0..<length { data[i] = Float(Double(data[i]) / tailPeak * 0.5 * spec.tailLevel) }

                for (time, level) in spec.taps {
                    addTap(data, jsFloor((time + (random() - 0.5) * 0.0015) * sampleRate), level)
                }
                for _ in 0..<spec.scatter {
                    let time = spec.preDelay + JSMath.pow(random(), 1.5) * spec.scatterSpan
                    let index = jsFloor(time * sampleRate)
                    let magnitude = (0.2 + 0.5 * random()) * JSMath.exp(decayPerSample * time * sampleRate)
                    addTap(data, index, magnitude * (random() < 0.5 ? -1 : 1))
                }

                if spec.ring > 0 {
                    let delay = jsFloor(spec.ring * sampleRate * (0.97 + 0.06 * random()))
                    if delay < length {
                        for i in delay..<length { data[i] = Float(Double(data[i]) + Double(data[i - delay]) * 0.55) }
                    }
                }
            }
        }

        let energy = (energyOf(channels[0]) + energyOf(channels[1])).squareRoot()
        let scale = energy > 0 ? spec.level / energy : 0
        for c in 0..<2 {
            channels[c].withUnsafeMutableBufferPointer { data in
                for i in 0..<length { data[i] = Float(Double(data[i]) * scale) }
            }
        }
        return (channels[0], channels[1])
    }

    /// Sum of squares in Double, in index order (impulse.ts energyOf).
    public static func energyOf(_ data: [Float]) -> Double {
        var sum = 0.0
        for v in data { sum += Double(v) * Double(v) }
        return sum
    }

    /// Seconds for the backward-integrated energy to fall from -5 dB to -25 dB, scaled to 60 dB (T20).
    public static func measureRt60(_ data: [Float], sampleRate: Double) -> Double {
        let total = energyOf(data)
        if total == 0 { return 0 }
        var remaining = total
        var at5 = -1, at25 = -1
        for i in data.indices {
            remaining -= Double(data[i]) * Double(data[i])
            let level = 10 * log10(Swift.max(remaining, 1e-30) / total)
            if at5 < 0 && level <= -5 { at5 = i }
            if level <= -25 {
                at25 = i
                break
            }
        }
        return at5 < 0 || at25 < 0 ? 0 : (Double(at25 - at5) / sampleRate) * 3
    }

    private static func peak(_ data: UnsafeMutableBufferPointer<Float>) -> Double {
        var maximum = 0.0
        for v in data { maximum = Swift.max(maximum, abs(Double(v))) }
        return maximum
    }

    /// `Math.floor` to an index; values here are always finite and small.
    private static func jsFloor(_ x: Double) -> Int { Int(x.rounded(.down)) }

    /// Three samples wide so a tap is a soft click, not a single-sample spike.
    private static func addTap(_ data: UnsafeMutableBufferPointer<Float>, _ index: Int, _ level: Double) {
        if index < 1 || index + 1 >= data.count { return }
        data[index - 1] = Float(Double(data[index - 1]) + level * 0.4)
        data[index] = Float(Double(data[index]) + level)
        data[index + 1] = Float(Double(data[index + 1]) + level * 0.4)
    }
}
