// M9post: the Swift DynamicResolution replays the web controller's traces
// (native/Tools/m3-parity/fixtures/dynamic-resolution.json, from dynres.test.ts), and the post
// settings follow QUALITY_PRESETS and main.ts debugSettings.
import Foundation
import Testing
@testable import IronvaleRender

private struct DynResFixture: Decodable {
    struct Trace: Decodable { let dt: [Double]; let scale: [Double] }
    let budget: Double
    let floor: Double
    let traces: [String: Trace]
}

@Test func dynamicResolutionMatchesTheWebTraces() throws {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "Tools/m3-parity/fixtures/dynamic-resolution.json")
    let fixture = try JSONDecoder().decode(DynResFixture.self, from: Data(contentsOf: url))
    #expect(fixture.traces.count == 5)
    for (name, trace) in fixture.traces.sorted(by: { $0.key < $1.key }) {
        var controller = DynamicResolution()
        for (i, dt) in trace.dt.enumerated() {
            controller.update(dt: dt, budget: fixture.budget, floor: fixture.floor)
            guard controller.scale == trace.scale[i] else {
                Issue.record("\(name): frame \(i) scale \(controller.scale), web \(trace.scale[i])")
                break
            }
        }
    }
}

@Test func postSettingsFollowTheWebPresetsAndOverrides() {
    #expect(PostSettings.parse(["--map", "railyard"]) == nil)
    let high = PostSettings.parse(["--q", "high", "--no", "grain"])!
    #expect(high.renderScale == 0.85 && high.reflections && high.ambientOcclusion && high.volumetricLight && high.bloom)
    #expect(high.antiAliasing == .traa && !high.filmGrain && !high.dynamicResolution)
    #expect(high.aoSamples == 12 && high.godraySteps == 48 && high.aoResolutionScale == 0.5)
    let medium = PostSettings.preset(.medium)
    #expect(medium.aoSamples == 8 && medium.godraySteps == 32 && !medium.reflections && medium.dynamicResolution)
    let flat = PostSettings.parse(["--no", "ssr,ao,godrays,bloom,aa,grain,shadows"])!
    #expect(flat.tier == .high && !flat.reflections && !flat.ambientOcclusion && !flat.bloom && flat.antiAliasing == .none)
    #expect(flat.shadowMapSize == 0)
    #expect(high.targetFps == 60)
    let fast = PostSettings.parse(["--q", "high", "--target-fps", "120", "--dynamic-resolution", "on"])!
    #expect(fast.targetFps == 120 && fast.dynamicResolution && fast.renderScale == 0.85)
    #expect(!PostSettings.parse(["--q", "high", "--target-fps", "120"])!.dynamicResolution)
    #expect(PostSettings.parse(["--q", "high", "--target-fps", "90"])!.targetFps == 60)
}

@MainActor @Test func bloomTapsSumToTheGaussian() {
    // BloomNode pairs adjacent Gaussian taps into one bilinear fetch; the weights must sum the same.
    for radius in PostChain.bloomKernels {
        let c = PostKernels.gaussian(radius: radius)
        let (center, taps) = PostKernels.bloomTaps(radius: radius)
        #expect(center == c[0])
        let paired = taps.reduce(0) { $0 + $1.y }
        #expect(abs(paired - c.dropFirst().reduce(0, +)) < 1e-5)
    }
}

@Test func presentedIntervalRoundsUpToWholeRefreshIntervals() {
    let refresh = 1.0 / 120
    #expect(PresentedInterval.quantized(0.004, refresh: refresh) == refresh)
    #expect(PresentedInterval.quantized(0.0083, refresh: refresh) == refresh)
    #expect(PresentedInterval.quantized(0.0086, refresh: refresh) == 2 * refresh)
    #expect(PresentedInterval.quantized(0.0180, refresh: refresh) == 3 * refresh)
    // A display-paced interval passes through unchanged.
    #expect(PresentedInterval.quantized(refresh, refresh: refresh) == refresh)
    #expect(PresentedInterval.quantized(0.0086, refresh: 0) == 0.0086)
}

@Test func presentedIntervalsPastTheBudgetStepTheResolutionDown() {
    // 8.6 ms frames at a 120 fps target: never long as measured (budget x 1.18 = 9.8 ms), always
    // long as a 120 Hz display presents them.
    var raw = DynamicResolution(), presented = DynamicResolution()
    for _ in 0..<400 {
        raw.update(dt: 0.0086, budget: 1.0 / 120, floor: 0.5)
        presented.update(dt: PresentedInterval.quantized(0.0086, refresh: 1.0 / 120), budget: 1.0 / 120, floor: 0.5)
    }
    #expect(raw.scale == 1)
    #expect(presented.scale < 1)
}
