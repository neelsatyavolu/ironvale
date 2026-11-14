// IronvaleNet against fixtures computed by the web's own functions (native/Tools/interop/
// net-fixtures.test.ts): parseSignal, parseIceServers, ClockSync; and the constants against
// native/Contract/protocol.json.
import Foundation
import IronvaleContract
import IronvaleCore
import Testing
@testable import IronvaleNet

private let fixtureURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Tools/interop/fixtures/net-session.json")

private func fixtures() throws -> JSONValue {
    let text = try String(contentsOf: fixtureURL, encoding: .utf8)
    return try #require(JSONValue.parse(text))
}

private func json(_ message: RelayMessage?) -> JSONValue {
    switch message {
    case nil: .null
    case .room(let peer)?: .object(JSONObject([("type", .string("room")), ("peer", .bool(peer))]))
    case .peer(let joined)?: .object(JSONObject([("type", .string("peer")), ("joined", .bool(joined))]))
    case .signal(let signal)?: SignalCodec.json(signal)
    }
}

@Test func parseSignalMatchesWeb() throws {
    let cases = try #require(try fixtures()["signal"]?.array)
    #expect(cases.count > 20)
    for item in cases {
        let input = try #require(item["input"]?.string)
        let expected = try #require(item["output"])
        #expect(json(SignalCodec.parse(input)).stringify() == expected.stringify(), "input \(input.prefix(80))")
    }
}

@Test func encodedSignalsParseBack() {
    let candidate = IceCandidateInit(candidate: "candidate:1 1 udp 1 10.0.0.2 4000 typ host ufrag ab", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "ab")
    for message in [SignalMessage.offer(sdp: "v=0\r\n"), .answer(sdp: "v=0\r\na=b\r\n"), .candidate(candidate),
                    .candidate(IceCandidateInit(candidate: "c", sdpMid: nil, sdpMLineIndex: nil, usernameFragment: nil))] {
        #expect(SignalCodec.parse(SignalCodec.encode(message)) == .signal(message))
    }
    // The browser's toJSON shape, nulls included.
    #expect(SignalCodec.encode(.candidate(IceCandidateInit(candidate: "c", sdpMid: nil, sdpMLineIndex: nil, usernameFragment: nil)))
        == #"{"type":"candidate","candidate":{"candidate":"c","sdpMid":null,"sdpMLineIndex":null,"usernameFragment":null}}"#)
}

@Test func parseIceServersMatchesWeb() throws {
    let cases = try #require(try fixtures()["iceServers"]?.array)
    for item in cases {
        let input = item["input"]?.string
        let expected = try #require(item["output"])
        #expect(IceServers.json(IceServers.parse(input)).stringify() == expected.stringify(), "input \(String(describing: input))")
    }
}

@Test func clockSyncMatchesWeb() throws {
    let trace = try #require(try fixtures()["clock"]?.array)
    var clock = ClockSync()
    for step in trace {
        let remote = step["remoteTime"]?.string == "NaN" ? Double.nan : try #require(step["remoteTime"]?.number)
        clock.addSample(sentAt: try #require(step["sentAt"]?.number), remoteTime: remote, receivedAt: try #require(step["receivedAt"]?.number))
        #expect(clock.synced == step["synced"]?.bool)
        #expect(clock.offset == step["offset"]?.number)
        #expect(clock.rtt == step["rtt"]?.number)
        #expect(clock.toLocal(10_000) == step["toLocal1e4"]?.number)
    }
    clock.reset()
    #expect(!clock.synced && clock.rtt == -1 && clock.offset == 0)
}

@Test func constantsMatchContract() throws {
    let p = try Contract(directory: ContractLocation.sourceTreeDirectory).protocolTable
    let session = try #require(p.timing["session"])
    #expect(SessionTiming.countdownMs == session["COUNTDOWN_MS"])
    #expect(SessionTiming.peerTimeoutMs == session["PEER_TIMEOUT_MS"])
    #expect(SessionTiming.connectTimeoutMs == session["CONNECT_TIMEOUT_MS"])
    #expect(SessionTiming.pingFastMs == session["PING_FAST_MS"])
    #expect(SessionTiming.pingSlowMs == session["PING_SLOW_MS"])
    #expect(Double(SessionTiming.pingFastCount) == session["PING_FAST_COUNT"])
    #expect(SessionTiming.reachableCacheMs == session["REACHABLE_CACHE_MS"])
    #expect(Double(SessionTiming.maxQueuedEvents) == session["MAX_QUEUED_EVENTS"])
    let clock = try #require(p.timing["clock"])
    #expect(Double(ClockSync.window) == clock["WINDOW"])
    #expect(ClockSync.maxRttMs == clock["MAX_RTT_MS"])
    #expect(ClockSync.rttSmoothing == clock["RTT_SMOOTHING"])
    let t = p.transport
    #expect(TransportLimits.gatherTimeoutMs == t.GATHER_TIMEOUT_MS)
    #expect(TransportLimits.stateBacklogBytes == t.STATE_BACKLOG_BYTES)
    #expect(TransportLimits.eventBacklogBytes == t.EVENT_BACKLOG_BYTES)
    #expect(TransportLimits.maxIncomingBytes == t.MAX_INCOMING_BYTES)
    #expect(TransportLimits.maxSdpChars == t.MAX_SDP_CHARS)
    #expect(TransportLimits.maxCandidateChars == t.MAX_CANDIDATE_CHARS)
    #expect(TransportLimits.healthTimeoutMs == t.HEALTH_TIMEOUT_MS)
    #expect(TransportLimits.hostCodeAttempts == t.HOST_CODE_ATTEMPTS)
    #expect(TransportLimits.relayTimeoutMs == t.RELAY_TIMEOUT_MS)
    #expect(TransportLimits.maxExtraServers == t.MAX_EXTRA_SERVERS)
    #expect(IceServers.stun.urls == t.STUN.urls)
    #expect(p.relay.close["expired"] == 4000 && p.relay.close["hostLeft"] == 4001 && p.relay.close["flooding"] == 4008)
}

@Test func relayURLs() throws {
    #expect(RelayClient.normalize(" wss://relay.example/// ") == "wss://relay.example")
    #expect(RelayClient.normalize("ftp://x") == nil)
    #expect(RelayClient.normalize("") == nil)
    let wss = try #require(RelayClient(url: "wss://relay.example"))
    #expect(wss.httpBase == "https://relay.example")
    #expect(wss.roomURL(code: "ABC234", role: .guest)?.absoluteString == "wss://relay.example/room/ABC234?role=guest")
    let http = try #require(RelayClient(url: "http://127.0.0.1:8790/"))
    #expect(http.httpBase == "http://127.0.0.1:8790")
    #expect(http.wsBase == "ws://127.0.0.1:8790")
    #expect(http.origin == "app://ironvale")
}

@Test func relayCloseCodes() {
    // signaling.ts closeError, and the native 429 improvement (PLAN.md 3.11.1).
    #expect(RelayClose.failure(code: 4404, role: .guest, opened: true) == .noRoom)
    #expect(RelayClose.failure(code: 4409, role: .host, opened: true) == .roomFull)
    #expect(RelayClose.failure(code: 4410, role: .guest, opened: true) == .roomExpired)
    #expect(RelayClose.failure(code: 4000, role: .host, opened: true) == .roomExpired)
    #expect(RelayClose.failure(code: 4001, role: .guest, opened: true) == .peerLeft)
    #expect(RelayClose.failure(code: 4008, role: .host, opened: true) == .rateLimited)
    #expect(RelayClose.failure(code: 4429, role: .host, opened: false) == .rateLimited)
    #expect(RelayClose.failure(code: 1000, role: .host, opened: true) == nil)
    #expect(RelayClose.failure(code: 1006, role: .guest, opened: true) == .peerLeft)
    #expect(RelayClose.failure(code: 1006, role: .host, opened: true) == .signalUnreachable)
    #expect(RelayClose.failure(code: 1006, role: .guest, opened: false) == .signalUnreachable)
    #expect(RelayClose.failure(httpStatus: 429) == .rateLimited)
    #expect(RelayClose.failure(httpStatus: 403) == .signalUnreachable)
    #expect(ManualSignaling.inviteFailure(.tooLong) == .codeTooLong)
    #expect(ManualSignaling.inviteFailure(.wrongKind) == .wrongCodeKind)
    #expect(ManualSignaling.inviteFailure(.malformed) == .badCode)
}
