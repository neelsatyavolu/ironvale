// Ported from src/net/api.ts (NetRole, NetMethod, LobbyStep, NetErrorCode) at commit cbe0add.
// Names differ from IronvaleUI's mock lobby types so a file importing both modules stays unambiguous;
// raw values are the web's strings, so the UI maps them one to one.

/// Which side of a two-player game this machine is. The host always makes the WebRTC offer.
public enum PeerRole: String, Sendable, CaseIterable { case host, guest }

/// `room`: a six-character code through the relay. `manual`: codes copied and pasted by hand.
public enum SignalMethod: String, Sendable, CaseIterable { case room, manual }

/// `LobbyStep` in api.ts.
public enum LobbyPhase: String, Sendable {
    case idle, opening, waiting, reply, connecting, connected
}

/// `NetErrorCode` in api.ts.
public enum NetFailure: String, Error, Sendable, CaseIterable {
    case signalUnreachable = "signal-unreachable"
    case noRoom = "no-room"
    case roomFull = "room-full"
    case roomExpired = "room-expired"
    case rateLimited = "rate-limited"
    case badCode = "bad-code"
    case wrongCodeKind = "wrong-code-kind"
    case codeTooLong = "code-too-long"
    case connectFailed = "connect-failed"
    case version
    case unknownMap = "unknown-map"
    case loadFailed = "load-failed"
    case peerLeft = "peer-left"
    case peerTimeout = "peer-timeout"
}
