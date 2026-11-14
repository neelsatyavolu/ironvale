// The two convolution reverb slots of src/audio/graph.ts (ConvolverNode, disableNormalization),
// rendered in MixCore. Stereo in, stereo impulse: left convolves with the left response and right
// with the right, as a ConvolverNode does with a two-channel buffer.
//
// Method: two-stage uniformly partitioned overlap-save in the frequency domain (Accelerate vDSP).
//   stage A: 128-sample blocks (256-point FFTs) for taps [128, 2176)
//   stage B: 2048-sample blocks (4096-point FFTs) for the rest of the response
// The block FIFO adds 128 samples of latency, which costs nothing: every generated impulse is
// exactly zero for at least its first 128 samples (the shortest pre-delay is 4 ms; checked by
// ImpulseParity.everyImpulseStartsWithAtLeastOneSilentBlock), so the taps are shifted by 128 and
// the output is the exact convolution with the full impulse, sample for sample.
//
// Threading: ImpulseBank is built on the main thread and read-only afterwards. Convolver state
// lives on the render thread; `setImpulse` and `process` allocate nothing.

import Accelerate
import Foundation
import Synchronization

/// Frequency-domain partitions of every reverb preset at one sample rate.
public final class ImpulseBank: @unchecked Sendable {
    public let sampleRate: Double
    /// Partition spectra, split complex (re | im, `half` floats each), per preset per channel.
    struct Response {
        let partitionsA: Int
        let partitionsB: Int
        /// partitionsA * 2 * Convolver.halfA floats per channel.
        let a: (UnsafeMutablePointer<Float>, UnsafeMutablePointer<Float>)
        /// partitionsB * 2 * Convolver.halfB floats per channel.
        let b: (UnsafeMutablePointer<Float>, UnsafeMutablePointer<Float>)
    }
    let responses: [Response]
    let maxPartitionsB: Int
    let setup: FFTSetup

    private static let cache = Mutex<[Double: ImpulseBank]>([:])

    /// The bank for `sampleRate`, built once per process and rate.
    public static func shared(sampleRate: Double) -> ImpulseBank {
        cache.withLock { banks in
            if let bank = banks[sampleRate] { return bank }
            let bank = ImpulseBank(sampleRate: sampleRate)
            banks[sampleRate] = bank
            return bank
        }
    }

    public init(sampleRate: Double) {
        self.sampleRate = sampleRate
        let fft = vDSP_create_fftsetup(vDSP_Length(Convolver.log2B), FFTRadix(kFFTRadix2))!
        setup = fft
        var responses: [Response] = []
        for preset in ImpulseGenerator.presets {
            let (left, right) = ImpulseGenerator.generate(preset, sampleRate: sampleRate)
            precondition(left.prefix(Convolver.block).allSatisfy { $0 == 0 } && right.prefix(Convolver.block).allSatisfy { $0 == 0 },
                         "impulse \(preset) is not silent for its first block")
            let taps = left.count - Convolver.block
            let pa = min(Convolver.partitionsA, (taps + Convolver.block - 1) / Convolver.block)
            let pb = max(0, (taps - Convolver.stageBOffset + Convolver.superBlock - 1) / Convolver.superBlock)
            func build(_ data: [Float]) -> (UnsafeMutablePointer<Float>, UnsafeMutablePointer<Float>) {
                let shifted = Array(data.dropFirst(Convolver.block))
                let a = UnsafeMutablePointer<Float>.allocate(capacity: max(1, pa * 2 * Convolver.halfA))
                let b = UnsafeMutablePointer<Float>.allocate(capacity: max(1, pb * 2 * Convolver.halfB))
                for p in 0..<pa {
                    ImpulseBank.spectrum(of: shifted, from: p * Convolver.block, count: Convolver.block, fftSize: 2 * Convolver.block,
                                         into: a + p * 2 * Convolver.halfA, setup: fft)
                }
                for p in 0..<pb {
                    ImpulseBank.spectrum(of: shifted, from: Convolver.stageBOffset + p * Convolver.superBlock, count: Convolver.superBlock,
                                         fftSize: 2 * Convolver.superBlock, into: b + p * 2 * Convolver.halfB, setup: fft)
                }
                return (a, b)
            }
            let l = build(left), r = build(right)
            responses.append(Response(partitionsA: pa, partitionsB: pb, a: (l.0, r.0), b: (l.1, r.1)))
        }
        self.responses = responses
        maxPartitionsB = responses.map(\.partitionsB).max() ?? 0
    }

    deinit {
        for r in responses { r.a.0.deallocate(); r.a.1.deallocate(); r.b.0.deallocate(); r.b.1.deallocate() }
        vDSP_destroy_fftsetup(setup)
    }

    public static func index(of preset: ReverbPreset) -> Int { ImpulseGenerator.presets.firstIndex(of: preset)! }

    /// Forward FFT of `count` taps from `from`, zero-padded to `fftSize`, scaled so that
    /// inverse(forward(x) * spectrum) is the plain convolution (vDSP scales forward by 2, inverse by n).
    private static func spectrum(of data: [Float], from: Int, count: Int, fftSize: Int, into out: UnsafeMutablePointer<Float>, setup: FFTSetup) {
        var padded = [Float](repeating: 0, count: fftSize)
        let end = min(data.count, from + count)
        if from < end { for i in from..<end { padded[i - from] = data[i] } }
        let half = fftSize / 2
        var split = DSPSplitComplex(realp: out, imagp: out + half)
        padded.withUnsafeBufferPointer { p in
            p.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) { vDSP_ctoz($0, 2, &split, 1, vDSP_Length(half)) }
        }
        vDSP_fft_zrip(setup, &split, 1, vDSP_Length(log2(Double(fftSize))), FFTDirection(kFFTDirection_Forward))
        var scale = Float(1) / Float(4 * fftSize)
        vDSP_vsmul(out, 1, &scale, out, 1, vDSP_Length(fftSize))
    }
}

/// Two crossfading convolver slots. Render thread only, except construction.
final class Convolver {
    static let block = 128
    static let partitionsA = 16
    static let superBlock = block * partitionsA
    /// Shifted-tap offset where stage B takes over.
    static let stageBOffset = superBlock
    static let halfA = block
    static let halfB = superBlock
    static let log2A = 8
    static let log2B = 12

    let bank: ImpulseBank
    private let slots: [Slot]
    /// Split-complex work buffers for one FFT of either size, and its accumulator.
    private let work: UnsafeMutablePointer<Float>
    private let acc: UnsafeMutablePointer<Float>
    private let time: UnsafeMutablePointer<Float>

    final class Slot {
        var response = -1
        /// Samples filled in the current 128-block.
        var fill = 0
        /// Completed 128-blocks since the response was set.
        var blocks = 0
        // Per channel (0 left, 1 right):
        let current: [UnsafeMutablePointer<Float>]     // 128: block being filled
        let previous: [UnsafeMutablePointer<Float>]    // 128: last completed block
        let output: [UnsafeMutablePointer<Float>]      // 128: convolution of the last completed block
        let superPrevious: [UnsafeMutablePointer<Float>] // 2048
        let superCurrent: [UnsafeMutablePointer<Float>]  // 2048
        let tailB: [UnsafeMutablePointer<Float>]       // 2048: stage B output for the current superblock
        let fdlA: [UnsafeMutablePointer<Float>]        // partitionsA spectra (2 * halfA)
        let fdlB: [UnsafeMutablePointer<Float>]        // maxPartitionsB spectra (2 * halfB)

        init(maxPartitionsB: Int) {
            func make(_ n: Int) -> [UnsafeMutablePointer<Float>] {
                (0..<2).map { _ in
                    let p = UnsafeMutablePointer<Float>.allocate(capacity: max(1, n))
                    p.initialize(repeating: 0, count: max(1, n))
                    return p
                }
            }
            current = make(Convolver.block)
            previous = make(Convolver.block)
            output = make(Convolver.block)
            superPrevious = make(Convolver.superBlock)
            superCurrent = make(Convolver.superBlock)
            tailB = make(Convolver.superBlock)
            fdlA = make(Convolver.partitionsA * 2 * Convolver.halfA)
            fdlB = make(maxPartitionsB * 2 * Convolver.halfB)
        }

        deinit {
            for list in [current, previous, output, superPrevious, superCurrent, tailB, fdlA, fdlB] { for p in list { p.deallocate() } }
        }
    }

    init(bank: ImpulseBank) {
        self.bank = bank
        slots = [Slot(maxPartitionsB: bank.maxPartitionsB), Slot(maxPartitionsB: bank.maxPartitionsB)]
        work = .allocate(capacity: 2 * Convolver.halfB)
        acc = .allocate(capacity: 2 * Convolver.halfB)
        time = .allocate(capacity: 2 * Convolver.superBlock)
        work.initialize(repeating: 0, count: 2 * Convolver.halfB)
        acc.initialize(repeating: 0, count: 2 * Convolver.halfB)
        time.initialize(repeating: 0, count: 2 * Convolver.superBlock)
    }

    deinit {
        work.deallocate()
        acc.deallocate()
        time.deallocate()
    }

    func isActive(_ slot: Int) -> Bool { slots[slot].response >= 0 }

    /// Give `slot` a preset's response (index into the bank), or none (-1). Like assigning a
    /// ConvolverNode's buffer, the slot starts from silence: no history from before.
    func setImpulse(slot index: Int, response: Int) {
        let slot = slots[index]
        slot.response = response
        slot.fill = 0
        slot.blocks = 0
        for c in 0..<2 {
            slot.previous[c].update(repeating: 0, count: Convolver.block)
            slot.output[c].update(repeating: 0, count: Convolver.block)
            slot.superPrevious[c].update(repeating: 0, count: Convolver.superBlock)
            slot.tailB[c].update(repeating: 0, count: Convolver.superBlock)
        }
    }

    /// Convolve `frames` of stereo input through `slot` and add the result times `gain[i]` into out.
    func process(slot index: Int, frames: Int, inL: UnsafePointer<Float>, inR: UnsafePointer<Float>,
                 gain: UnsafePointer<Float>, outL: UnsafeMutablePointer<Float>, outR: UnsafeMutablePointer<Float>) {
        let slot = slots[index]
        if slot.response < 0 { return }
        var done = 0
        while done < frames {
            let n = min(frames - done, Convolver.block - slot.fill)
            (slot.current[0] + slot.fill).update(from: inL + done, count: n)
            (slot.current[1] + slot.fill).update(from: inR + done, count: n)
            let zl = slot.output[0] + slot.fill, zr = slot.output[1] + slot.fill
            for i in 0..<n {
                let g = gain[done + i]
                outL[done + i] += zl[i] * g
                outR[done + i] += zr[i] * g
            }
            slot.fill += n
            done += n
            if slot.fill == Convolver.block {
                completeBlock(slot)
                slot.fill = 0
            }
        }
    }

    private func completeBlock(_ slot: Slot) {
        let response = bank.responses[slot.response]
        let j = slot.blocks
        let inSuper = j % Convolver.partitionsA
        for c in 0..<2 {
            // Stage A: [previous | current] -> spectrum into the delay line; sum over partitions.
            time.update(from: slot.previous[c], count: Convolver.block)
            (time + Convolver.block).update(from: slot.current[c], count: Convolver.block)
            let fdl = slot.fdlA[c]
            let stride = 2 * Convolver.halfA
            let head = fdl + (j % Convolver.partitionsA) * stride
            forward(time, count: 2 * Convolver.block, log2n: Convolver.log2A, into: head)
            let count = min(j + 1, response.partitionsA)
            let spectra = c == 0 ? response.a.0 : response.a.1
            accumulate(count: count, half: Convolver.halfA) { p in
                (fdl + ((j - p) % Convolver.partitionsA) * stride, spectra + p * stride)
            }
            inverse(half: Convolver.halfA, log2n: Convolver.log2A)
            let z = slot.output[c]
            z.update(from: time + Convolver.block, count: Convolver.block)
            // Stage B output for this block, computed when the previous superblock completed.
            vDSP_vadd(z, 1, slot.tailB[c] + inSuper * Convolver.block, 1, z, 1, vDSP_Length(Convolver.block))
            (slot.superCurrent[c] + inSuper * Convolver.block).update(from: slot.current[c], count: Convolver.block)
            slot.previous[c].update(from: slot.current[c], count: Convolver.block)

            if inSuper == Convolver.partitionsA - 1 && response.partitionsB > 0 {
                let k = j / Convolver.partitionsA
                time.update(from: slot.superPrevious[c], count: Convolver.superBlock)
                (time + Convolver.superBlock).update(from: slot.superCurrent[c], count: Convolver.superBlock)
                let fdlB = slot.fdlB[c]
                let strideB = 2 * Convolver.halfB
                let ring = response.partitionsB
                forward(time, count: 2 * Convolver.superBlock, log2n: Convolver.log2B, into: fdlB + (k % ring) * strideB)
                let spectraB = c == 0 ? response.b.0 : response.b.1
                accumulate(count: min(k + 1, ring), half: Convolver.halfB) { p in
                    (fdlB + ((k - p) % ring) * strideB, spectraB + p * strideB)
                }
                inverse(half: Convolver.halfB, log2n: Convolver.log2B)
                slot.tailB[c].update(from: time + Convolver.superBlock, count: Convolver.superBlock)
                slot.superPrevious[c].update(from: slot.superCurrent[c], count: Convolver.superBlock)
            }
        }
        slot.blocks = j + 1
    }

    /// Real FFT of `count` samples at `input` into split-complex `out` (re | im).
    private func forward(_ input: UnsafeMutablePointer<Float>, count: Int, log2n: Int, into out: UnsafeMutablePointer<Float>) {
        let half = count / 2
        var split = DSPSplitComplex(realp: out, imagp: out + half)
        input.withMemoryRebound(to: DSPComplex.self, capacity: half) { vDSP_ctoz($0, 2, &split, 1, vDSP_Length(half)) }
        vDSP_fft_zrip(bank.setup, &split, 1, vDSP_Length(log2n), FFTDirection(kFFTDirection_Forward))
    }

    /// acc = sum over p of X_p * H_p, with vDSP's packed DC (re[0]) and Nyquist (im[0]) bins.
    @inline(__always)
    private func accumulate(count: Int, half: Int, _ pair: (Int) -> (UnsafeMutablePointer<Float>, UnsafeMutablePointer<Float>)) {
        acc.update(repeating: 0, count: 2 * half)
        var dc: Float = 0, nyquist: Float = 0
        var sum = DSPSplitComplex(realp: acc + 1, imagp: acc + half + 1)
        for p in 0..<count {
            let (x, h) = pair(p)
            dc += x[0] * h[0]
            nyquist += x[half] * h[half]
            var xs = DSPSplitComplex(realp: x + 1, imagp: x + half + 1)
            var hs = DSPSplitComplex(realp: h + 1, imagp: h + half + 1)
            vDSP_zvma(&xs, 1, &hs, 1, &sum, 1, &sum, 1, vDSP_Length(half - 1))
        }
        acc[0] = dc
        acc[half] = nyquist
    }

    /// Inverse FFT of `acc` into `time` (2 * half real samples).
    private func inverse(half: Int, log2n: Int) {
        var split = DSPSplitComplex(realp: acc, imagp: acc + half)
        vDSP_fft_zrip(bank.setup, &split, 1, vDSP_Length(log2n), FFTDirection(kFFTDirection_Inverse))
        time.withMemoryRebound(to: DSPComplex.self, capacity: half) { vDSP_ztoc(&split, 1, $0, 2, vDSP_Length(half)) }
    }
}
