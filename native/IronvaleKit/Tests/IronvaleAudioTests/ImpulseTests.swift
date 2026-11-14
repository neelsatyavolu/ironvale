import CryptoKit
import Foundation
import IronvaleSim
import Testing
@testable import IronvaleAudio

/// M8b: the native impulse generator reproduces the web's impulses bit for bit
/// (native/Tools/audio-trace/fixtures/impulses.json, written by impulse.gen.ts from src/audio/impulse.ts).
@Suite struct ImpulseParity {
    static func fixture() throws -> (stride: Int, impulses: [[String: Any]]) {
        let json = try Fixtures.json(Fixtures.traces.appending(path: "impulses.json"))
        return (json["probeStride"] as! Int, json["impulses"] as! [[String: Any]])
    }

    static func sha256(_ data: [Float]) -> String {
        data.withUnsafeBytes { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() }
    }

    @Test func impulsesMatchTheWebBitForBit() throws {
        let (stride, impulses) = try Self.fixture()
        #expect(impulses.count == 15)
        for entry in impulses {
            let preset = ReverbPreset(rawValue: entry["preset"] as! String)!
            let rate = (entry["sampleRate"] as! NSNumber).doubleValue
            #expect(UInt32((entry["seed"] as! NSNumber).uint32Value) == ImpulseGenerator.seed(preset))
            let (left, right) = ImpulseGenerator.generate(preset, sampleRate: rate)
            #expect(left.count == entry["length"] as! Int)
            for (name, data) in [("left", left), ("right", right)] {
                let web = entry[name] as! [String: Any]
                let probes = (web["probes"] as! [NSNumber]).map(\.uint32Value)
                var firstBad = -1
                for (k, bits) in probes.enumerated() where k * stride < data.count && data[k * stride].bitPattern != bits {
                    firstBad = k * stride
                    break
                }
                let hash = Self.sha256(data)
                let matched = hash == web["sha256"] as! String
                #expect(matched, "\(preset.rawValue) @\(Int(rate)) \(name): sha256 differs, first differing probe at sample \(firstBad)")
                #expect(firstBad < 0)
                #expect(data.firstIndex { $0 != 0 } == web["firstNonZero"] as? Int)
                if matched { print("M8b impulse \(preset.rawValue) @\(Int(rate)) \(name): \(data.count) samples, sha256 \(hash.prefix(16)) matches") }
            }
            // rt60 is a report, not part of the bit-exact output (log10 is Darwin's here).
            let rt = ImpulseGenerator.measureRt60(left, sampleRate: rate)
            #expect(abs(rt - (entry["rt60"] as! NSNumber).doubleValue) < 1e-9)
        }
    }

    /// Math.pow and Math.log as V8 computes them (fdlibm with clang's FMA contractions), bit for bit.
    @Test func jsMathMatchesNode() throws {
        let data = try Data(contentsOf: Fixtures.traces.appending(path: "jsmath-vectors.bin"))
        let values = data.withUnsafeBytes { Array($0.bindMemory(to: Double.self)) }
        let half = values.count / 6
        #expect(half == 4096)
        var powBad = 0, logBad = 0, darwinPowBad = 0
        for i in 0..<(2 * half) {
            let x = values[3 * i], y = values[3 * i + 1], want = values[3 * i + 2].bitPattern
            if i < half {
                if JSMath.pow(x, y).bitPattern != want { powBad += 1 }
                if Foundation.pow(x, y).bitPattern != want { darwinPowBad += 1 }
            } else if JSMath.log(x).bitPattern != want {
                logBad += 1
            }
        }
        print("M8b jsmath: pow \(half - powBad)/\(half), log \(half - logBad)/\(half) bit-exact (Darwin pow: \(half - darwinPowBad)/\(half))")
        #expect(powBad == 0)
        #expect(logBad == 0)
    }

    /// The convolver relies on every impulse being silent for its first partition.
    @Test func everyImpulseStartsWithAtLeastOneSilentBlock() throws {
        for rate in [44100.0, 48000, 96000] {
            for preset in ImpulseGenerator.presets {
                let (left, right) = ImpulseGenerator.generate(preset, sampleRate: rate)
                #expect(left.prefix(Convolver.block).allSatisfy { $0 == 0 })
                #expect(right.prefix(Convolver.block).allSatisfy { $0 == 0 })
            }
        }
    }
}
