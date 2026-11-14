// Ported from src/net/clock.ts at commit cbe0add.

/// Offset and round-trip estimate from ping/pong samples. The trusted offset is the one from the
/// quickest of the last few samples; the displayed round trip is smoothed.
public struct ClockSync: Sendable {
    public static let window = 10
    public static let maxRttMs: Double = 10_000
    public static let rttSmoothing = 0.2

    private struct Sample: Sendable { let rtt: Double; let offset: Double }
    private var samples: [Sample] = []
    private var best: Sample?
    public private(set) var rtt: Double = -1

    public init() {}

    public var synced: Bool { best != nil }
    /// Remote clock minus local clock, milliseconds. 0 until the first ping returns.
    public var offset: Double { best?.offset ?? 0 }

    public mutating func addSample(sentAt: Double, remoteTime: Double, receivedAt: Double) {
        let rtt = receivedAt - sentAt
        guard rtt.isFinite, remoteTime.isFinite, rtt >= 0, rtt <= Self.maxRttMs else { return }
        let sample = Sample(rtt: rtt, offset: remoteTime - (sentAt + rtt / 2))
        samples = Array((samples + [sample]).suffix(Self.window))
        // `entry.rtt <= quickest.rtt`: ties go to the later sample.
        best = samples.dropFirst().reduce(samples[0]) { quickest, entry in entry.rtt <= quickest.rtt ? entry : quickest }
        self.rtt = self.rtt < 0 ? rtt : self.rtt + (rtt - self.rtt) * Self.rttSmoothing
    }

    public func toLocal(_ remoteTime: Double) -> Double { remoteTime - offset }
    public func toRemote(_ localTime: Double) -> Double { localTime + offset }

    public mutating func reset() { self = ClockSync() }
}
