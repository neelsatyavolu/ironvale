// Ported from src/net/session.ts, transport.ts, signaling.ts and ice.ts at commit cbe0add.
// Every value is checked against native/Contract/protocol.json (`timing.session`, `transport`)
// by IronvaleNetTests, so a web change fails the tests instead of cross-play.

/// Session timers (session.ts), milliseconds.
public enum SessionTiming {
    public static let countdownMs: Double = 3000
    public static let peerTimeoutMs: Double = 5000
    public static let connectTimeoutMs: Double = 25_000
    public static let pingFastMs: Double = 250
    public static let pingSlowMs: Double = 1000
    public static let pingFastCount = 8
    public static let reachableCacheMs: Double = 10_000
    public static let maxQueuedEvents = 256
}

/// Data-channel and signaling limits (transport.ts, signaling.ts, ice.ts).
public enum TransportLimits {
    public static let gatherTimeoutMs: Double = 4000
    public static let stateBacklogBytes = 16_384
    public static let eventBacklogBytes = 1_000_000
    public static let maxIncomingBytes = 8192
    public static let maxSdpChars = 12_000
    public static let maxCandidateChars = 1000
    public static let healthTimeoutMs: Double = 2500
    public static let hostCodeAttempts = 4
    public static let relayTimeoutMs: Double = 3000
    public static let maxExtraServers = 6
    /// Candidates queued before the remote description, newest kept (transport.ts addCandidate).
    public static let maxQueuedCandidates = 64
    /// Native only (PLAN.md 3.11.1): trickled candidates per attempt, under the relay's 40-message burst.
    public static let maxTrickledCandidates = 24
}

/// Where the native client finds the relay and how it introduces itself.
public enum RelayDefaults {
    /// The deployed relay (`signaling/wrangler.jsonc` routes).
    public static let url = "wss://ironvale-signal.n3el.dev"
    /// The native client's `Origin` (owner decision W6, PLAN.md 13). Only relays whose
    /// `ALLOWED_ORIGINS` list it accept the client; the deployed relay will after W6 ships.
    public static let origin = "app://ironvale"
}
