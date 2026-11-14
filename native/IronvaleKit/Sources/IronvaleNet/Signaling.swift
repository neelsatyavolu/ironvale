// Ported from src/net/signaling.ts (Signaling, SignalHandlers, ManualSignaling, closeError) at
// commit cbe0add. Everything here runs on the main actor, which stands in for the browser's single
// thread: callbacks from URLSession and WebRTC are funnelled onto it in arrival order.
import Foundation
import IronvaleWire

/// What signaling reports to the session.
@MainActor
public struct SignalHandlers {
    /// A code for the player to pass on: the room code, the invite, or the reply.
    public var onCode: @MainActor (String) -> Void
    /// The other side is there (or has gone). The host makes its offer when this turns true.
    public var onPeer: @MainActor (Bool) -> Void
    public var onSignal: @MainActor (SignalMessage) -> Void
    public var onError: @MainActor (NetFailure) -> Void

    public init(
        onCode: @escaping @MainActor (String) -> Void,
        onPeer: @escaping @MainActor (Bool) -> Void,
        onSignal: @escaping @MainActor (SignalMessage) -> Void,
        onError: @escaping @MainActor (NetFailure) -> Void
    ) {
        self.onCode = onCode
        self.onPeer = onPeer
        self.onSignal = onSignal
        self.onError = onError
    }
}

@MainActor
public protocol Signaling: AnyObject {
    /// true: candidates travel one by one. false: each side sends one description carrying them all.
    var trickle: Bool { get }
    /// `code`: for a guest, the room code or the pasted invite. Ignored for a host.
    func open(role: PeerRole, code: String, handlers: SignalHandlers)
    func send(_ message: SignalMessage)
    /// Copy-and-paste only: the host pastes the guest's reply here.
    func paste(_ text: String)
    /// Stop. No handler is called after this.
    func close()
}

/// Copy-and-paste codes: the host's offer is the invite, the guest's answer is the reply.
@MainActor
public final class ManualSignaling: Signaling {
    public let trickle = false
    private var handlers: SignalHandlers?
    private var role: PeerRole = .host

    public init() {}

    public func open(role: PeerRole, code: String, handlers: SignalHandlers) {
        self.handlers = handlers
        self.role = role
        if role == .host {
            // Nobody to wait for: the offer itself is the invite.
            handlers.onPeer(true)
            return
        }
        read(code, expected: .offer)
    }

    public func send(_ message: SignalMessage) {
        let code: String
        switch message {
        case .candidate: return
        case .offer(let sdp): code = InviteCodec.encode(kind: .offer, sdp: sdp)
        case .answer(let sdp): code = InviteCodec.encode(kind: .answer, sdp: sdp)
        }
        // The web encodes asynchronously (CompressionStream); keep the handler off the caller's stack too.
        DispatchQueue.main.async { MainActor.assumeIsolated { self.handlers?.onCode(code) } }
    }

    public func paste(_ text: String) {
        if role == .host { read(text, expected: .answer) }
    }

    public func close() {
        handlers = nil
    }

    private func read(_ text: String, expected: InviteKind) {
        let result = InviteCodec.decode(text, expected: expected)
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                switch result {
                case .success(let sdp): self.handlers?.onSignal(expected == .offer ? .offer(sdp: sdp) : .answer(sdp: sdp))
                case .failure(let error): self.handlers?.onError(Self.inviteFailure(error))
                }
            }
        }
    }

    /// `INVITE_ERRORS` in signaling.ts.
    public nonisolated static func inviteFailure(_ error: InviteError) -> NetFailure {
        switch error {
        case .empty, .malformed: .badCode
        case .tooLong: .codeTooLong
        case .wrongKind: .wrongCodeKind
        }
    }
}

public enum RelayClose {
    /// `closeError`: why the relay closed the socket, as an error the interface can explain;
    /// nil when it is not an error. `opened`: the WebSocket handshake had completed.
    public static func failure(code: Int, role: PeerRole, opened: Bool) -> NetFailure? {
        switch code {
        case 4404: .noRoom
        case 4409: .roomFull
        case 4410, 4000: .roomExpired
        case 4001: .peerLeft
        case 4008, 4429: .rateLimited
        case 1000: nil
        default: opened ? (role == .guest ? .peerLeft : .signalUnreachable) : .signalUnreachable
        }
    }

    /// A refusal before the upgrade (HTTP status, which a browser never sees). 429 becomes
    /// `rate-limited`, a deliberate improvement on the web's `signal-unreachable` (PLAN.md 3.11.1).
    public static func failure(httpStatus: Int) -> NetFailure {
        httpStatus == 429 ? .rateLimited : .signalUnreachable
    }
}
