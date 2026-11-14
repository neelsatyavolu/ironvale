import Foundation
import Testing
@testable import IronvaleAudio

/// Live playback through AVAudioEngine with the device I/O buffer at 128 frames, driven by the stub
/// firefight at 60 Hz: no device overloads, no allocations on the Core Audio render thread, no
/// dropped commands. Opt-in by duration: IRONVALE_AUDIO_SOAK_SECONDS=600 is the M8a 10-minute run.
/// Output is muted after the soft clip (all DSP still runs) unless IRONVALE_AUDIO_AUDIBLE=1.
/// IRONVALE_AUDIO_SOAK_REPORT=<path> writes the measurements as JSON.
@Suite(.serialized) struct SoakTests {
    static let seconds = Double(ProcessInfo.processInfo.environment["IRONVALE_AUDIO_SOAK_SECONDS"] ?? "") ?? 0

    @Test(.enabled(if: SoakTests.seconds > 0 && MixCoreTests.optimized, "set IRONVALE_AUDIO_SOAK_SECONDS and build optimized (native/ci/check-m8a.sh)"))
    func liveSoakAt128Frames() throws {
        let env = ProcessInfo.processInfo.environment
        try #require(MallocHook.install(), "malloc_logger is not available")
        let host = StubFirefight(seed: 5)
        // The built-in output by default: a Bluetooth default output keeps its own I/O size.
        // IRONVALE_AUDIO_DEVICE=default uses the system default output instead.
        let device = env["IRONVALE_AUDIO_DEVICE"] == "default" ? nil : AudioOutput.builtInOutputDevice()
        let rate = device.flatMap(AudioOutput.sampleRate(of:)) ?? AudioOutput.hardwareSampleRate()
        let session = try AudioSession(repo: Fixtures.repo, host: host, sampleRate: rate)
        session.engine.enterMap(StubFirefight.map)
        session.engine.unlock()
        try #require(session.library.failures.isEmpty, "\(session.library.failures)")
        if env["IRONVALE_AUDIO_AUDIBLE"] != "1" { session.core.setOutputGain(0) }

        let mallocsBefore = MallocHook.count(.live)
        try session.startOutput(bufferFrames: 128, device: device, probe: MallocProbe())
        defer { session.output?.stop() }
        let buffer = session.output?.bufferFrames

        let dt = 1.0 / 60
        let start = DispatchTime.now().uptimeNanoseconds
        var frames = 0
        var maxVoices = 0
        var maxLanes = 0
        var crossfadeFrames = 0
        var events = 0
        while true {
            let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e9
            if elapsed >= SoakTests.seconds { break }
            let due = Double(frames + 1) * dt
            if due > elapsed { Thread.sleep(forTimeInterval: due - elapsed) }
            let batch = host.step(dt)
            events += batch.count
            session.frame(dt: dt, events: batch)
            maxVoices = max(maxVoices, session.engine.voicePool?.playing ?? 0)
            maxLanes = max(maxLanes, (0..<SpatialLanes.count).filter { session.core.lanes.laneMixer[$0] >= 0 }.count)
            if session.core.convolver.isActive(0) && session.core.convolver.isActive(1) { crossfadeFrames += 1 }
            frames += 1
        }
        session.output?.stop()
        let mallocs = MallocHook.count(.live) - mallocsBefore
        let core = session.core
        let report: [String: Any] = [
            "seconds": SoakTests.seconds,
            "sampleRate": rate,
            "bufferFrames": buffer ?? -1,
            "device": device.map { Int($0) } ?? -1,
            "renderCalls": core.renderCalls.load(ordering: .relaxed),
            "deviceOverloads": session.output?.overloads ?? -1,
            "renderOverBudget": core.overruns.load(ordering: .relaxed),
            "longestRenderMicros": Double(core.longestRenderNanos.load(ordering: .relaxed)) / 1000,
            "renderPercentOfCore": Double(core.renderNanos.load(ordering: .relaxed)) / 1e9 / SoakTests.seconds * 100,
            "maxHrtfLanes": maxLanes,
            "reverbCrossfadeFrames": crossfadeFrames,
            "budgetMicros": 128 / rate * 1e6,
            "renderThreadAllocations": mallocs,
            "droppedCommands": core.commands.droppedCount,
            "droppedEnded": core.ended.droppedCount,
            "gameFrames": frames,
            "events": events,
            "maxVoices": maxVoices,
        ]
        let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        print("M8a soak: \(String(decoding: json, as: UTF8.self))")
        if let path = env["IRONVALE_AUDIO_SOAK_REPORT"] { try json.write(to: URL(fileURLWithPath: path)) }

        #expect(buffer == 128)
        #expect(Double(session.engine.sampleRate) == rate)
        #expect(core.renderCalls.load(ordering: .relaxed) > Int(SoakTests.seconds * rate / 128 * 0.9))
        #expect(session.output?.overloads == 0)
        #expect(mallocs == 0, "\(mallocs) allocations on the render thread\n\(mallocHookReport(.live, since: mallocsBefore))")
        #expect(core.commands.droppedCount == 0)
        #expect(core.ended.droppedCount == 0)
        #expect(maxVoices > 8)
    }
}
