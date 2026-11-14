// Ported from src/net/transport.ts (PeerLinkHandlers, PeerLinkOptions, PeerLink's surface) at
// commit cbe0add. The WebRTC implementation lives in IronvaleTransportWebRTC, so this module and
// everything that depends on it build without the framework (PLAN.md 2).

public struct PeerLinkOptions: Sendable {
    public var iceServers: [IceServer]
    /// true: send candidates as they are found. false: one description that carries them.
    public var trickle: Bool
    /// Only TURN candidates (`iceTransportPolicy = relay`), for the deployed-relay smoke test.
    public var relayOnly: Bool

    public init(iceServers: [IceServer], trickle: Bool, relayOnly: Bool = false) {
        self.iceServers = iceServers
        self.trickle = trickle
        self.relayOnly = relayOnly
    }
}

/// Everything a link reports, always on the main actor and in the order it happened.
@MainActor
public struct PeerLinkHandlers {
    /// Both channels are open.
    public var onOpen: @MainActor () -> Void
    /// A binary frame from the unreliable `state` channel.
    public var onState: @MainActor ([UInt8]) -> Void
    /// A text frame (JSON event) from the reliable `events` channel.
    public var onEventText: @MainActor (String) -> Void
    /// A binary frame (shot) from the reliable `events` channel.
    public var onEventBinary: @MainActor ([UInt8]) -> Void
    /// The connection ended or could not be made. Called once.
    public var onClosed: @MainActor () -> Void
    /// Something for the other side: pass it through the signaling in use.
    public var onSignal: @MainActor (SignalMessage) -> Void

    public init(
        onOpen: @escaping @MainActor () -> Void,
        onState: @escaping @MainActor ([UInt8]) -> Void,
        onEventText: @escaping @MainActor (String) -> Void,
        onEventBinary: @escaping @MainActor ([UInt8]) -> Void,
        onClosed: @escaping @MainActor () -> Void,
        onSignal: @escaping @MainActor (SignalMessage) -> Void
    ) {
        self.onOpen = onOpen
        self.onState = onState
        self.onEventText = onEventText
        self.onEventBinary = onEventBinary
        self.onClosed = onClosed
        self.onSignal = onSignal
    }
}

/// One peer connection with two negotiated data channels: `state` (id 0, unordered, no
/// retransmits) and `events` (id 1, ordered, reliable). See PLAN.md 3.11.1.
@MainActor
public protocol PeerLink: AnyObject {
    var isOpen: Bool { get }
    /// Host: create the offer and hand it to signaling.
    func makeOffer()
    /// Guest: take the host's offer and answer it. `patient`: a failed attempt is not final
    /// before opening (copy-and-paste replies can take minutes to reach the host).
    func acceptOffer(sdp: String, patient: Bool)
    /// Host: take the guest's answer.
    func acceptAnswer(sdp: String)
    func addCandidate(_ candidate: IceCandidateInit)
    /// Unreliable channel. Dropped when the link is not ready or is backed up.
    func sendState(_ bytes: [UInt8])
    /// Reliable channel, as a text frame. False when it could not be queued.
    @discardableResult func sendEvent(text: String) -> Bool
    /// Reliable channel, as a binary frame. False when it could not be queued.
    @discardableResult func sendEvent(binary: [UInt8]) -> Bool
    func close()
}

/// Makes the link for one connection attempt; the app passes the WebRTC one.
public typealias PeerLinkFactory = @MainActor (PeerLinkOptions, PeerLinkHandlers) -> PeerLink
