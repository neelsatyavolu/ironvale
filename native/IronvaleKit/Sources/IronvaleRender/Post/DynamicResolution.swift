// Ported from src/render/dynamic-resolution.ts at commit 1aca0b7 (1:1; no rendering in it).
// Decides the dynamic render-scale multiplier from frame times: steps down while frames run long,
// probes back up after a calm stretch, backs off after failed probes, and gives the pixels back
// when going to the floor did not help (resolution is not the bottleneck).

public struct DynamicResolution: Sendable, Equatable {
    public static let resolutionStep = 0.05
    static let windowSeconds = 1.5
    static let longFrame = 1.18
    static let slowShare = 0.4
    static let calmShare = 0.05
    static let probeSeconds = 4.5
    static let maxProbeSeconds = 72.0
    static let hitchSeconds = 0.25
    static let usefulGain = 0.1
    static let holdSeconds = 30.0
    static let maxHoldSeconds = 240.0

    /// Multiplier applied to the chosen render scale, in (0, 1].
    public private(set) var scale = 1.0
    private var windowTime = 0.0
    private var windowFrames = 0
    private var longTime = 0.0
    private var calmTime = 0.0
    private var probeWait = probeSeconds
    private var probing = false
    private var descentFrom = 1.0
    private var descentFrameTime = 0.0
    private var descending = false
    private var hold = 0.0
    private var holdLength = holdSeconds

    public init() {}

    public mutating func reset() { self = DynamicResolution() }

    /// Feeds one frame: `dt` the real frame interval, `budget` the target interval, `floor` the lowest
    /// multiplier. Returns true when the scale changed.
    @discardableResult
    public mutating func update(dt: Double, budget: Double, floor: Double) -> Bool {
        if dt <= 0 || dt > Self.hitchSeconds { return false }
        windowTime += dt
        windowFrames += 1
        if dt > budget * Self.longFrame { longTime += dt }
        if windowTime < Self.windowSeconds { return false }

        let window = windowTime
        let longShare = longTime / window
        let frameTime = window / Double(windowFrames)
        windowTime = 0
        windowFrames = 0
        longTime = 0
        hold = max(0, hold - window)
        let before = scale

        if longShare > Self.slowShare {
            calmTime = 0
            stepDown(floor: floor, frameTime: frameTime)
        } else {
            descending = false
            if longShare < Self.calmShare { calm(seconds: window) } else { calmTime = 0 }
        }
        return scale != before
    }

    private mutating func stepDown(floor: Double, frameTime: Double) {
        if probing {
            probing = false
            probeWait = min(Self.maxProbeSeconds, probeWait * 2)
            scale = max(floor, scale - Self.resolutionStep)
            return
        }
        if hold > 0 { return }
        if !descending {
            descending = true
            descentFrom = scale
            descentFrameTime = frameTime
        }
        if scale > floor + 1e-6 {
            scale = max(floor, scale - Self.resolutionStep)
            return
        }
        if descentFrom > scale && frameTime > descentFrameTime * (1 - Self.usefulGain) {
            scale = descentFrom
            hold = holdLength
            holdLength = min(Self.maxHoldSeconds, holdLength * 2)
        }
        descending = false
    }

    private mutating func calm(seconds: Double) {
        if probing {
            probing = false
            probeWait = Self.probeSeconds
        }
        if scale >= 1 { return }
        calmTime += seconds
        if calmTime < probeWait { return }
        calmTime = 0
        scale = min(1, scale + Self.resolutionStep)
        probing = true
    }
}
