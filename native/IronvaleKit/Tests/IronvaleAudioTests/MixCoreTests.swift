import Foundation
import IronvaleCore
import Testing
@testable import IronvaleAudio

/// MixCore and its parts: params, ring, rendering, and the no-allocation rule.
@Suite(.serialized) struct MixCoreTests {
    #if DEBUG
    static let optimized = false
    #else
    static let optimized = true
    #endif

    /// The per-sample renderer follows the same automation curve as the timeline (and the web stub).
    @Test func renderParamMatchesTimeline() {
        var random = SeededRandom(seed: 42)
        let rate = 48000.0
        for round in 0..<40 {
            var timeline = ParamTimeline(defaultValue: 1)
            var param = RenderParam(initial: 1)
            defer { param.free() }
            var t = 0.0
            var worst = 0.0
            for _ in 0..<12 {
                let at = t + random.next() * 0.05
                let kinds: [AutomationKind] = [.set, .lin, .target, .cancel]
                let kind = kinds[Int(random.next() * 4)]
                let event = Automation(kind, time: at, value: random.next() * 2, tau: 0.005 + random.next() * 0.2)
                timeline.apply(event)
                param.apply(event)
                // Render 512 samples and compare each with the closed form.
                for _ in 0..<512 {
                    let value = param.step(at: t, sampleRate: rate)
                    worst = max(worst, abs(value - timeline.value(at: t)))
                    t += 1 / rate
                }
            }
            #expect(worst < 1e-6, "round \(round): worst \(worst)")
        }
    }

    @Test func timelineCompactionKeepsValues() {
        var timeline = ParamTimeline(defaultValue: 0)
        for i in 0..<40 {
            let t = Double(i) * 0.1
            timeline.apply(Automation(i % 3 == 0 ? .target : .set, time: t, value: Double(i % 5), tau: 0.05))
        }
        timeline.apply(Automation(.lin, time: 5, value: 9))
        let probes = stride(from: 3.95, through: 6, by: 0.01).map { $0 }
        let before = probes.map { timeline.value(at: $0) }
        timeline.compact(now: 3.95)
        #expect(timeline.events.count < 6)
        for (t, v) in zip(probes, before) { #expect(abs(timeline.value(at: t) - v) < 1e-12) }
    }

    @Test func ringPassesValuesAcrossThreads() async {
        let ring = SPSCRing<Int>(capacity: 64)
        let total = 200_000
        let consumer = Task.detached {
            var expected = 0
            while expected < total {
                if let v = ring.pop() {
                    if v != expected { return false }
                    expected += 1
                }
            }
            return true
        }
        var sent = 0
        while sent < total { if ring.push(sent) { sent += 1 } }
        #expect(await consumer.value)
    }

    @Test func softClipAndPanLaws() {
        let clip = SoftClip()
        defer { clip.free() }
        #expect(abs(clip.apply(0.5) - 0.5) < 1e-3)
        #expect(clip.apply(4) <= 0.98)
        #expect(clip.apply(-4) >= -0.98)
        // Straight ahead, hard right, behind-left.
        let ahead = Panning.equalPowerAzimuth(listener: (0, 0, 0), forward: (0, 0, -1), up: (0, 1, 0), source: (0, 0, -5))
        let right = Panning.equalPowerAzimuth(listener: (0, 0, 0), forward: (0, 0, -1), up: (0, 1, 0), source: (5, 0, 0))
        let behindLeft = Panning.equalPowerAzimuth(listener: (0, 0, 0), forward: (0, 0, -1), up: (0, 1, 0), source: (-3, 0, 3))
        #expect(abs(ahead) < 1e-9)
        #expect(abs(right - 90) < 1e-9)
        #expect(abs(behindLeft + 45) < 1e-9)
        let (l, r) = Panning.monoGains(azimuth: 0)
        #expect(abs(l * l + r * r - 1) < 1e-6)
    }

    /// Every sound in the manifest decodes through AVAudioFile, and its length agrees with the
    /// MP3 frame count the web traces use (gapless decoders differ by a few milliseconds at most).
    @Test func decodesEveryManifestSound() throws {
        let core = MixCore(sampleRate: 48000)
        let library = try SoundLibrary(repo: Fixtures.repo, core: core)
        let sounds = try Fixtures.json(Fixtures.traces.appending(path: "sounds.json"))
        let lengths = sounds["lengths"] as! [String: Int]
        #expect(library.ids.count == lengths.count)
        var worst = 0.0
        for id in library.ids {
            let decoded = try library.decodeOrThrow(id)
            let web = Double(lengths[id] ?? 0) / 48000
            worst = max(worst, abs(decoded.duration - web))
            // One-shots skip at most the scanned lead-in; loops start at their loop point.
            #expect(decoded.offset >= 0 && (decoded.offset < 0.12 || (decoded.loopStart > 0 && decoded.offset == decoded.loopStart)))
        }
        print("M8a decode: \(library.ids.count) sounds, \(library.decodedFrames) frames, worst length difference \(worst) s")
        #expect(worst < 0.06)
    }

    /// Render real sounds offline through the whole engine: sound comes out, voices end and are handed back.
    @Test func rendersAFirefightOffline() throws {
        let host = StubFirefight(seed: 3)
        let session = try AudioSession(repo: Fixtures.repo, host: host, sampleRate: 48000)
        session.engine.enterMap(StubFirefight.map)
        session.engine.unlock()
        #expect(session.library.failures.isEmpty, "\(session.library.failures)")
        let frames = 800
        let left = UnsafeMutablePointer<Float>.allocate(capacity: frames), right = UnsafeMutablePointer<Float>.allocate(capacity: frames)
        defer { left.deallocate(); right.deallocate() }
        var peak: Float = 0
        var energy = 0.0
        var maxVoices = 0
        // 20 s of game at 60 fps, 800 frames of audio per game frame (48 kHz / 60).
        for _ in 0..<1200 {
            session.frame(dt: 1.0 / 60, events: host.step(1.0 / 60))
            session.core.render(frames: frames, left: left, right: right)
            for i in 0..<frames {
                peak = max(peak, abs(left[i]), abs(right[i]))
                energy += Double(left[i] * left[i] + right[i] * right[i])
            }
            maxVoices = max(maxVoices, session.engine.voicePool?.playing ?? 0)
        }
        #expect(peak > 0.05)
        #expect(peak <= 0.98)
        #expect(energy > 1)
        #expect(maxVoices > 8)
        #expect(session.core.commands.droppedCount == 0)
        #expect(session.core.ended.droppedCount == 0)
    }

    /// The render path allocates nothing; the hook itself is proven live by a deliberate allocation.
    /// Runs on optimized builds (check-m8a.sh builds the tests with -c release): unoptimized Swift
    /// calls unspecialized generics (Range iteration among them) that box values on the heap.
    @Test(.enabled(if: MixCoreTests.optimized, "allocation check runs on optimized builds (native/ci/check-m8a.sh)"))
    func renderDoesNotAllocate() throws {
        try #require(MallocHook.install(), "malloc_logger is not available")
        // Positive control: an allocation inside a counted region is seen.
        let before = MallocHook.count
        MallocHook.counting(true)
        let leak = UnsafeMutableRawPointer.allocate(byteCount: 64, alignment: 16)
        MallocHook.counting(false)
        leak.deallocate()
        #expect(MallocHook.count > before, "the malloc hook did not see a deliberate allocation")

        let host = StubFirefight(seed: 11)
        let session = try AudioSession(repo: Fixtures.repo, host: host, sampleRate: 48000)
        session.engine.enterMap(StubFirefight.map)
        session.engine.unlock()
        let frames = 128
        let left = UnsafeMutablePointer<Float>.allocate(capacity: frames), right = UnsafeMutablePointer<Float>.allocate(capacity: frames)
        defer { left.deallocate(); right.deallocate() }
        var counted = 0
        var renders = 0
        // 30 s of game; 6.25 render calls of 128 frames per 60 Hz frame.
        var owed = 0.0
        for _ in 0..<1800 {
            session.frame(dt: 1.0 / 60, events: host.step(1.0 / 60))
            owed += 48000.0 / 60
            while owed >= Double(frames) {
                let start = MallocHook.count
                MallocHook.counting(true)
                session.core.render(frames: frames, left: left, right: right)
                MallocHook.counting(false)
                counted += MallocHook.count - start
                owed -= Double(frames)
                renders += 1
            }
        }
        #expect(renders >= 11250)
        #expect(counted == 0, "\(counted) allocations in \(renders) render calls\n\(mallocHookReport())")
    }
}
