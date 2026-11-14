// Ported from src/net/signaling.ts (SignalMessage, parseSignal) at commit cbe0add.
import IronvaleCore

/// A connection candidate in the browser's `RTCIceCandidate.toJSON()` shape. Missing fields are null.
public struct IceCandidateInit: Sendable, Equatable {
    public var candidate: String
    public var sdpMid: String?
    public var sdpMLineIndex: Int?
    public var usernameFragment: String?

    public init(candidate: String, sdpMid: String?, sdpMLineIndex: Int?, usernameFragment: String?) {
        self.candidate = candidate
        self.sdpMid = sdpMid
        self.sdpMLineIndex = sdpMLineIndex
        self.usernameFragment = usernameFragment
    }
}

/// What the two peers pass through signaling before WebRTC connects them.
public enum SignalMessage: Sendable, Equatable {
    case offer(sdp: String)
    case answer(sdp: String)
    case candidate(IceCandidateInit)
}

/// Everything the room relay can say to a client: a relayed signal, or its own room notices.
public enum RelayMessage: Sendable, Equatable {
    case signal(SignalMessage)
    /// Admission: whether the other seat is already filled.
    case room(peer: Bool)
    /// The other side arrived or left.
    case peer(joined: Bool)
}

public enum SignalCodec {
    /// `parseSignal`: validate a relayed message before it reaches the peer connection.
    public static func parse(_ text: String) -> RelayMessage? {
        guard JS.length(text) <= TransportLimits.maxSdpChars + 200,
              case .object(let fields)? = JSONValue.parse(text) else { return nil }
        switch fields["type"]?.string {
        case "offer", "answer":
            guard let sdp = fields["sdp"]?.string, JS.length(sdp) <= TransportLimits.maxSdpChars else { return nil }
            return .signal(fields["type"]?.string == "offer" ? .offer(sdp: sdp) : .answer(sdp: sdp))
        case "candidate":
            guard let initial = fields["candidate"]?.object,
                  let candidate = initial["candidate"]?.string,
                  JS.length(candidate) <= TransportLimits.maxCandidateChars else { return nil }
            let line: Int? = initial["sdpMLineIndex"]?.number.flatMap { JS.isInteger($0) ? Int(exactly: $0) : nil }
            return .signal(.candidate(IceCandidateInit(
                candidate: candidate,
                sdpMid: initial["sdpMid"]?.string.map { JS.slice($0, 32) },
                sdpMLineIndex: line,
                usernameFragment: initial["usernameFragment"]?.string.map { JS.slice($0, 256) }
            )))
        case "room":
            return fields["peer"]?.bool.map { .room(peer: $0) }
        case "peer":
            return fields["joined"]?.bool.map { .peer(joined: $0) }
        default:
            return nil
        }
    }

    /// `JSON.stringify(message)` as the web sends it.
    public static func encode(_ message: SignalMessage) -> String {
        json(message).stringify()
    }

    public static func json(_ message: SignalMessage) -> JSONValue {
        switch message {
        case .offer(let sdp): .object(JSONObject([("type", .string("offer")), ("sdp", .string(sdp))]))
        case .answer(let sdp): .object(JSONObject([("type", .string("answer")), ("sdp", .string(sdp))]))
        case .candidate(let c):
            .object(JSONObject([
                ("type", .string("candidate")),
                ("candidate", .object(JSONObject([
                    ("candidate", .string(c.candidate)),
                    ("sdpMid", c.sdpMid.map(JSONValue.string) ?? .null),
                    ("sdpMLineIndex", c.sdpMLineIndex.map { .number(Double($0)) } ?? .null),
                    ("usernameFragment", c.usernameFragment.map(JSONValue.string) ?? .null),
                ]))),
            ]))
        }
    }
}
