import Foundation
import IronvaleCore
import IronvaleWorld
import Testing
@testable import IronvaleAudio

/// M8b: convolution reverb with crossfading slots, HRTF lanes, and the CPU budget.
@Suite(.serialized) struct RoomsAndHRTF {
    static let rate = 48000.0

    // ---------------------------------------------------------------- convolver

    /// The partitioned FFT convolver equals direct convolution with the full impulse (including its
    /// silent first block), whatever sizes the input arrives in.
    @Test(arguments: [ReverbPreset.interior, .industrial, .openField])
    func convolverMatchesDirectConvolution(_ preset: ReverbPreset) {
        let bank = ImpulseBank.shared(sampleRate: Self.rate)
        let convolver = Convolver(bank: bank)
        convolver.setImpulse(slot: 1, response: ImpulseBank.index(of: preset))
        let (irL, irR) = ImpulseGenerator.generate(preset, sampleRate: Self.rate)
        // Long enough for stage B to run many superblocks past the end of the impulse.
        let total = irL.count + 30_000
        var random = SeededRandom(seed: 9)
        var inL = [Float](repeating: 0, count: total), inR = inL
        for i in 0..<total where (i / 4000) % 3 != 2 {
            inL[i] = Float(random.next() * 2 - 1)
            inR[i] = Float(random.next() * 2 - 1)
        }
        var outL = [Float](repeating: 0, count: total), outR = outL
        let ones = [Float](repeating: 1, count: 4096)
        let chunks = [128, 37, 800, 1, 4096, 255, 513]
        var done = 0, k = 0
        while done < total {
            let n = min(chunks[k % chunks.count], total - done)
            inL.withUnsafeBufferPointer { l in inR.withUnsafeBufferPointer { r in
                outL.withUnsafeMutableBufferPointer { ol in outR.withUnsafeMutableBufferPointer { or in
                    convolver.process(slot: 1, frames: n, inL: l.baseAddress! + done, inR: r.baseAddress! + done, gain: ones,
                                      outL: ol.baseAddress! + done, outR: or.baseAddress! + done)
                } }
            } }
            done += n
            k += 1
        }
        var worst = 0.0, scale = 0.0
        var probe = SeededRandom(seed: 4)
        for _ in 0..<160 {
            let n = Int(probe.next() * Double(total))
            var yl = 0.0, yr = 0.0
            for m in 0..<min(n + 1, irL.count) {
                yl += Double(irL[m]) * Double(inL[n - m])
                yr += Double(irR[m]) * Double(inR[n - m])
            }
            worst = max(worst, abs(yl - Double(outL[n])), abs(yr - Double(outR[n])))
            scale = max(scale, abs(yl), abs(yr))
        }
        print("M8b convolver \(preset.rawValue): worst error \(worst) against peak \(scale)")
        #expect(scale > 0.01)
        #expect(worst / scale < 1e-4)
    }

    /// A slot that loses its impulse goes silent; a new impulse starts from no history.
    @Test func convolverSlotsResetAndIdle() {
        let convolver = Convolver(bank: ImpulseBank.shared(sampleRate: Self.rate))
        let n = 4096
        let impulse = [Float](repeating: 0, count: n).enumerated().map { $0.offset == 0 ? Float(1) : 0 }
        let silence = [Float](repeating: 0, count: n), ones = [Float](repeating: 1, count: n)
        var out = [Float](repeating: 0, count: n), outR = out
        convolver.setImpulse(slot: 0, response: ImpulseBank.index(of: .interior))
        convolver.process(slot: 0, frames: n, inL: impulse, inR: impulse, gain: ones, outL: &out, outR: &outR)
        #expect(out.contains { $0 != 0 })
        convolver.setImpulse(slot: 0, response: ImpulseBank.index(of: .street))
        out = silence
        outR = silence
        convolver.process(slot: 0, frames: n, inL: silence, inR: silence, gain: ones, outL: &out, outR: &outR)
        #expect(out.allSatisfy { $0 == 0 }, "history leaked across an impulse change")
        convolver.setImpulse(slot: 0, response: -1)
        #expect(!convolver.isActive(0))
        convolver.process(slot: 0, frames: n, inL: impulse, inR: impulse, gain: ones, outL: &out, outR: &outR)
        #expect(out.allSatisfy { $0 == 0 })
    }

    // ---------------------------------------------------------------- whole engine

    /// One click through MixCore with a reverb send: the reverb tail follows it; the crossfade to
    /// another preset hands over between slots without a step, and an emptied slot stops costing.
    @Test func mixCoreReverbTailAndCrossfade() {
        let core = MixCore(sampleRate: Self.rate)
        var click = [Float](repeating: 0, count: 480)
        click[0] = 1
        let sound = core.registerSound(samples: click, frames: click.count, channels: 1, sampleRate: Self.rate)
        func set(_ id: ParamID, _ value: Double, at time: Double = 0) { core.send(.param(id, Automation(.set, time: time, value: value))) }
        set(.bus(.master), 1)
        set(.bus(.reverb0), 1)
        core.send(.reverbImpulse(slot: 0, .industrial))
        core.send(.route(slot: 0, bus: .effects, positional: false))
        core.send(.stereoPan(slot: 0, 0))
        set(.voice(slot: 0, .gain), 0.5)
        set(.voice(slot: 0, .send), 1)
        core.send(.startVoice(slot: 0, SourceStart(sound: sound, start: 0.01, offset: 0, rate: 1, loop: false, loopStart: 0, loopEnd: 0, generation: 1)))
        let frames = 128
        var left = [Float](repeating: 0, count: frames), right = [Float](repeating: 0, count: frames)
        func energy(seconds: Double) -> (Double, Float) {
            var e = 0.0
            var largestStep: Float = 0
            var last = left[frames - 1]
            for _ in 0..<Int(seconds * Self.rate / Double(frames)) {
                core.render(frames: frames, left: &left, right: &right)
                for i in 0..<frames {
                    e += Double(left[i] * left[i] + right[i] * right[i])
                    largestStep = max(largestStep, abs(left[i] - last))
                    last = left[i]
                }
            }
            return (e, largestStep)
        }
        _ = energy(seconds: 0.2)
        let (tail, _) = energy(seconds: 0.6)
        #expect(tail > 1e-6, "no reverb tail after the click")
        // Crossfade to the interior response over 0.7 s, as graph.ts setReverb does.
        core.send(.reverbImpulse(slot: 1, .interior))
        let now = core.currentTime
        core.send(.param(.bus(.reverb1), Automation(.lin, time: now + 0.7, value: 1)))
        core.send(.param(.bus(.reverb0), Automation(.set, time: now, value: 1)))
        core.send(.param(.bus(.reverb0), Automation(.lin, time: now + 0.7, value: 0)))
        let (_, step) = energy(seconds: 0.8)
        #expect(step < 0.05, "crossfade stepped by \(step)")
        core.send(.reverbImpulse(slot: 0, nil))
        _ = energy(seconds: 0.1)
        #expect(!core.convolver.isActive(0))
        #expect(core.convolver.isActive(1))
    }

    /// An HRTF voice is rendered by the spatial mixer: a source on the right is louder in the right
    /// ear and vice versa, at a level close to the equal-power panner's, and the lane is freed when
    /// the voice ends.
    @Test func hrtfLanesSpatialise() throws {
        func render(x: Double, hrtf: Bool) throws -> (left: Double, right: Double, lanes: Int) {
            let core = MixCore(sampleRate: Self.rate)
            try #require(core.lanes.available, "the spatial mixer could not be created")
            var random = SeededRandom(seed: 2)
            let noise = (0..<48000).map { _ in Float(random.next() * 2 - 1) * 0.3 }
            let sound = core.registerSound(samples: noise, frames: noise.count, channels: 1, sampleRate: Self.rate)
            core.send(.param(.bus(.master), Automation(.set, time: 0, value: 1)))
            core.send(.listener(ListenerPose(position: .zero, forward: Vec3(0, 0, -1), up: Vec3(0, 1, 0))))
            core.send(.route(slot: 3, bus: .effects, positional: true))
            core.send(.position(slot: 3, x: x, y: 0, z: -1))
            core.send(.param(.voice(slot: 3, .gain), Automation(.set, time: 0, value: 0.5)))
            core.send(.startVoice(slot: 3, SourceStart(sound: sound, start: 0, offset: 0, rate: 1, loop: false, loopStart: 0, loopEnd: 0, generation: 1)))
            core.send(.panningModel(slot: 3, hrtf: false))
            if hrtf { core.send(.panningModel(slot: 3, hrtf: true)) }
            var l = [Float](repeating: 0, count: 128), r = [Float](repeating: 0, count: 128)
            var el = 0.0, er = 0.0
            var lanes = 0
            for block in 0..<300 {
                core.render(frames: 128, left: &l, right: &r)
                if block == 10 { lanes = (0..<SpatialLanes.count).filter { core.lanes.laneMixer[$0] >= 0 }.count }
                if block < 20 { continue }
                for i in 0..<128 {
                    el += Double(l[i] * l[i])
                    er += Double(r[i] * r[i])
                }
            }
            return (el, er, lanes)
        }
        let right = try render(x: 4, hrtf: true)
        let left = try render(x: -4, hrtf: true)
        let ahead = try render(x: 0, hrtf: true)
        let aheadEqualPower = try render(x: 0, hrtf: false)
        #expect(right.lanes == 1 && left.lanes == 1 && aheadEqualPower.lanes == 0)
        #expect(right.right > right.left * 2, "right source: L \(right.left) R \(right.right)")
        #expect(left.left > left.right * 2, "left source: L \(left.left) R \(left.right)")
        let levelDB = 10 * log10((ahead.left + ahead.right) / (aheadEqualPower.left + aheadEqualPower.right))
        print("M8b HRTF: right source L/R \(right.left / right.right), ahead level vs equal-power \(levelDB) dB")
        #expect(abs(levelDB) < 6)
    }

    // ---------------------------------------------------------------- 16-bot firefight

    static func threadCPUNanos() -> UInt64 { clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) }

    /// The M8b budget: under 5% of one core for the whole audio engine (main-thread engine work
    /// plus MixCore with both reverb slots and HRTF lanes) during the scripted 16-bot firefight,
    /// rendered in 128-frame calls at 48 kHz. Measured as thread CPU time, so other processes on
    /// the machine do not inflate it. Optimized builds only.
    @Test(.enabled(if: MixCoreTests.optimized, "CPU budget runs on optimized builds (native/ci/check-m8b.sh)"))
    func firefightUnderFivePercentOfACore() throws {
        let host = StubFirefight(seed: 21)
        let session = try AudioSession(repo: Fixtures.repo, host: host, sampleRate: Self.rate)
        session.engine.enterMap(StubFirefight.map)
        session.engine.unlock()
        try #require(session.library.failures.isEmpty, "\(session.library.failures)")
        try #require(session.core.lanes.available)
        let frames = 128
        var left = [Float](repeating: 0, count: frames), right = [Float](repeating: 0, count: frames)
        let seconds = Double(ProcessInfo.processInfo.environment["IRONVALE_M8B_CPU_SECONDS"] ?? "") ?? 120
        let gameFrames = Int(seconds * 60)
        var renderCPU: UInt64 = 0, mainCPU: UInt64 = 0
        var owed = 0.0, renders = 0
        var maxLanes = 0, laneFrames = 0, bothSlots = 0, maxVoices = 0
        var crossfades = 0
        var lastSlots = (false, false)
        for _ in 0..<gameFrames {
            let m0 = Self.threadCPUNanos()
            session.frame(dt: 1.0 / 60, events: host.step(1.0 / 60))
            mainCPU += Self.threadCPUNanos() - m0
            owed += Self.rate / 60
            while owed >= Double(frames) {
                let r0 = Self.threadCPUNanos()
                session.core.render(frames: frames, left: &left, right: &right)
                renderCPU += Self.threadCPUNanos() - r0
                owed -= Double(frames)
                renders += 1
            }
            let lanes = (0..<SpatialLanes.count).filter { session.core.lanes.laneMixer[$0] >= 0 }.count
            maxLanes = max(maxLanes, lanes)
            if lanes > 0 { laneFrames += 1 }
            let slots = (session.core.convolver.isActive(0), session.core.convolver.isActive(1))
            if slots.0 && slots.1 { bothSlots += 1 }
            if slots.0 && slots.1 && !(lastSlots.0 && lastSlots.1) { crossfades += 1 }
            lastSlots = slots
            maxVoices = max(maxVoices, session.engine.voicePool?.playing ?? 0)
        }
        let audioSeconds = Double(renders * frames) / Self.rate
        let renderPercent = Double(renderCPU) / 1e9 / audioSeconds * 100
        let mainPercent = Double(mainCPU) / 1e9 / audioSeconds * 100
        let report: [String: Any] = [
            "audioSeconds": audioSeconds, "renderCalls": renders,
            "renderPercentOfCore": renderPercent, "mainThreadPercentOfCore": mainPercent, "totalPercentOfCore": renderPercent + mainPercent,
            "maxHrtfLanes": maxLanes, "framesWithLanes": laneFrames, "framesWithBothReverbSlots": bothSlots, "crossfades": crossfades,
            "maxVoices": maxVoices, "gameFrames": gameFrames,
        ]
        let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        print("M8b cpu: \(String(decoding: json, as: UTF8.self))")
        if let path = ProcessInfo.processInfo.environment["IRONVALE_M8B_CPU_REPORT"] { try json.write(to: URL(fileURLWithPath: path)) }
        #expect(maxLanes == SpatialLanes.count, "the firefight never filled all 8 HRTF lanes")
        #expect(crossfades >= 2, "the firefight never crossfaded between reverb slots")
        #expect(maxVoices > 8)
        #expect(renderPercent + mainPercent < 5)
    }

    /// The M8a guarantee still holds with convolution and HRTF lanes running: no allocation in render.
    @Test(.enabled(if: MixCoreTests.optimized, "allocation check runs on optimized builds (native/ci/check-m8b.sh)"))
    func roomsAndLanesDoNotAllocate() throws {
        try #require(MallocHook.install(), "malloc_logger is not available")
        let host = StubFirefight(seed: 17)
        let session = try AudioSession(repo: Fixtures.repo, host: host, sampleRate: Self.rate)
        session.engine.enterMap(StubFirefight.map)
        session.engine.unlock()
        let frames = 128
        var left = [Float](repeating: 0, count: frames), right = [Float](repeating: 0, count: frames)
        var counted = 0, renders = 0, laneRenders = 0, crossfadeRenders = 0
        let firstCounted = MallocHook.count(.offline)
        var owed = 0.0
        // 60 s: over one full walk around the loop, through the interior zone and out again.
        for _ in 0..<3600 {
            session.frame(dt: 1.0 / 60, events: host.step(1.0 / 60))
            owed += Self.rate / 60
            while owed >= Double(frames) {
                let start = MallocHook.count(.offline)
                MallocHook.counting(.offline)
                session.core.render(frames: frames, left: &left, right: &right)
                MallocHook.counting(nil)
                counted += MallocHook.count(.offline) - start
                owed -= Double(frames)
                renders += 1
                if (0..<SpatialLanes.count).contains(where: { session.core.lanes.laneMixer[$0] >= 0 }) { laneRenders += 1 }
                if session.core.convolver.isActive(0) && session.core.convolver.isActive(1) { crossfadeRenders += 1 }
            }
        }
        print("M8b alloc: \(renders) renders, \(laneRenders) with HRTF lanes, \(crossfadeRenders) during reverb crossfades, \(counted) allocations")
        #expect(laneRenders > renders / 2)
        #expect(crossfadeRenders > 0)
        #expect(counted == 0, "\(counted) allocations in \(renders) render calls\n\(mallocHookReport(.offline, since: firstCounted))")
    }
}
