// Ported from src/net/signaling.ts (RoomSignaling) at commit cbe0add. URLSessionWebSocketTask
// rather than NWConnection: it reports both the relay's 4xxx close codes and the HTTP status of a
// refused upgrade (403, 400, 429), which NWConnection hides.
import Foundation
import IronvaleWire

/// Signaling through the relay under a six-character room code, with trickled candidates.
@MainActor
public final class RoomSignaling: Signaling {
    public let trickle = true
    private let relay: RelayClient
    private let makeCode: () -> String
    private var socket: RelaySocket?
    private var handlers: SignalHandlers?
    private var attempts = 0

    public init(relay: RelayClient, makeCode: @escaping () -> String = { RoomCode.make() }) {
        self.relay = relay
        self.makeCode = makeCode
    }

    public func open(role: PeerRole, code: String, handlers: SignalHandlers) {
        self.handlers = handlers
        if role == .host {
            connect(role: role, code: makeCode())
            return
        }
        let tidy = RoomCode.from(code)
        guard RoomCode.isValid(tidy) else {
            fail(.badCode)
            return
        }
        connect(role: role, code: tidy)
    }

    public func send(_ message: SignalMessage) {
        socket?.send(SignalCodec.encode(message))
    }

    public func paste(_ text: String) {
        // Room codes need nothing pasted back.
    }

    public func close() {
        handlers = nil
        let socket = self.socket
        self.socket = nil
        socket?.close()
    }

    private func fail(_ error: NetFailure) {
        let handlers = self.handlers
        close()
        handlers?.onError(error)
    }

    private func connect(role: PeerRole, code: String) {
        guard let url = relay.roomURL(code: code, role: role) else {
            fail(.signalUnreachable)
            return
        }
        let current = WeakRef<RelaySocket>()
        let socket = RelaySocket(url: url, origin: relay.origin, onText: { [weak self] text in
            guard let self, self.socket === current.value, let message = SignalCodec.parse(text) else { return }
            switch message {
            case .room(let peer):
                // The relay let us in. A host now has a code to share; a guest knows the host is there.
                if role == .host { self.handlers?.onCode(code) } else { self.handlers?.onPeer(peer) }
            case .peer(let joined):
                self.handlers?.onPeer(joined)
            case .signal(let signal):
                self.handlers?.onSignal(signal)
            }
        }, onClose: { [weak self] closeCode, httpStatus, opened in
            guard let self, self.socket === current.value else { return }
            self.socket = nil
            // Another game holds this code: pick a new one.
            if role == .host, closeCode == 4409 {
                self.attempts += 1
                if self.attempts < TransportLimits.hostCodeAttempts {
                    self.connect(role: role, code: self.makeCode())
                    return
                }
            }
            let error: NetFailure? = if !opened, let httpStatus, httpStatus != 101 {
                RelayClose.failure(httpStatus: httpStatus)
            } else {
                RelayClose.failure(code: closeCode, role: role, opened: opened)
            }
            if let error { self.fail(error) }
        })
        current.value = socket
        self.socket = socket
        socket.start()
    }
}

/// One WebSocket to the relay. Every callback arrives on the main queue, in order.
@MainActor
final class RelaySocket {
    private let task: URLSessionWebSocketTask
    private let session: URLSession
    private let delegate: Delegate
    private var opened = false
    private var finished = false
    private let onText: @MainActor (String) -> Void
    private let onClose: @MainActor (_ code: Int, _ httpStatus: Int?, _ opened: Bool) -> Void

    init(url: URL, origin: String,
         onText: @escaping @MainActor (String) -> Void,
         onClose: @escaping @MainActor (Int, Int?, Bool) -> Void) {
        self.onText = onText
        self.onClose = onClose
        let queue = OperationQueue()
        queue.underlyingQueue = .main
        queue.maxConcurrentOperationCount = 1
        delegate = Delegate()
        session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: queue)
        var request = URLRequest(url: url)
        request.setValue(origin, forHTTPHeaderField: "Origin")
        task = session.webSocketTask(with: request)
        // The relay's messages are at most 16 KB; leave room for a full SDP.
        task.maximumMessageSize = 64 * 1024
        delegate.socket = self
    }

    func start() {
        task.resume()
        receive()
    }

    func send(_ text: String) {
        guard opened, !finished else { return }
        task.send(.string(text)) { _ in }
    }

    /// Close with 1000. No callback follows.
    func close() {
        guard !finished else { return }
        finished = true
        task.cancel(with: .normalClosure, reason: nil)
        session.finishTasksAndInvalidate()
    }

    fileprivate func didOpen() { opened = true }

    fileprivate func didFinish() {
        guard !finished else { return }
        finished = true
        let status = (task.response as? HTTPURLResponse)?.statusCode
        let code = task.closeCode.rawValue
        session.finishTasksAndInvalidate()
        onClose(code, status, opened)
    }

    private func receive() {
        task.receive { [weak self] result in
            // Delivered on the session's delegate queue, which is the main queue.
            MainActor.assumeIsolated {
                guard let self, !self.finished else { return }
                switch result {
                case .success(.string(let text)):
                    self.onText(text)
                    self.receive()
                case .success:
                    // Binary frames are never relayed; ignore and keep listening.
                    self.receive()
                case .failure:
                    // didCompleteWithError follows with the close code or HTTP status.
                    break
                }
            }
        }
    }

    private final class Delegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
        // Only touched on the main queue (the session's delegate queue).
        weak var socket: RelaySocket?

        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
            MainActor.assumeIsolated { socket?.didOpen() }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            MainActor.assumeIsolated { socket?.didFinish() }
        }
    }
}
