// Ported from src/net/transport.ts (PeerLink) at commit cbe0add, on Google libwebrtc
// (stasel/WebRTC). Additions the browser does not need, from PLAN.md 3.11.1: loopback, VPN and
// link-local candidates are left out, trickled candidates are capped at 24 per attempt, and the
// same filter and cap apply to the candidates inside a copy-and-paste description.
import Foundation
import IronvaleNet
import IronvaleWire
import WebRTC

/// One peer connection with the two negotiated data channels the web uses.
@MainActor
public final class WebRTCPeerLink: PeerLink {
    private let options: PeerLinkOptions
    private let handlers: PeerLinkHandlers
    private let connection: RTCPeerConnection
    private let stateChannel: RTCDataChannel
    private let eventsChannel: RTCDataChannel
    private let bridge: Bridge
    private var opened = false
    private var closed = false
    /// While false a failed connection attempt is not final: the other side may not have our answer yet.
    private var failFast = true
    /// Candidates that arrived before the description they belong to.
    private var queued: [IceCandidateInit] = []
    private var remoteSet = false
    private var trickled = 0
    private var gatherWaiters: [@MainActor () -> Void] = []

    /// Candidates this link sent through signaling (trickled, or inside the description).
    public private(set) var candidatesSent = 0

    /// The factory method the session takes (`PeerLinkFactory`).
    public static func make(options: PeerLinkOptions, handlers: PeerLinkHandlers) -> PeerLink {
        WebRTCPeerLink(options: options, handlers: handlers)
    }

    public init(options: PeerLinkOptions, handlers: PeerLinkHandlers) {
        self.options = options
        self.handlers = handlers
        let bridge = Bridge()
        self.bridge = bridge
        let config = RTCConfiguration()
        config.iceServers = options.iceServers.map { server in
            RTCIceServer(urlStrings: server.urls, username: server.username, credential: server.credential)
        }
        config.sdpSemantics = .unifiedPlan
        config.iceTransportPolicy = options.relayOnly ? .relay : .all
        // Gather once: continual gathering keeps trickling candidates as interfaces change.
        config.continualGatheringPolicy = .gatherOnce
        config.disableLinkLocalNetworks = true
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let connection = Factory.shared.peerConnection(with: config, constraints: constraints, delegate: bridge) else {
            preconditionFailure("libwebrtc refused a peer connection configuration")
        }
        self.connection = connection
        // Both sides create the same two channels by id, so neither waits for the other to announce them.
        let stateConfig = RTCDataChannelConfiguration()
        stateConfig.isNegotiated = true
        stateConfig.channelId = 0
        stateConfig.isOrdered = false
        stateConfig.maxRetransmits = 0
        let eventsConfig = RTCDataChannelConfiguration()
        eventsConfig.isNegotiated = true
        eventsConfig.channelId = 1
        eventsConfig.isOrdered = true
        guard let state = connection.dataChannel(forLabel: "state", configuration: stateConfig),
              let events = connection.dataChannel(forLabel: "events", configuration: eventsConfig) else {
            preconditionFailure("libwebrtc refused the negotiated data channels")
        }
        stateChannel = state
        eventsChannel = events
        state.delegate = bridge
        events.delegate = bridge
        bridge.link = self
    }

    public var isOpen: Bool { opened && !closed }

    public func makeOffer() {
        connection.offer(for: Self.noConstraints) { [bridge] description, error in
            let sdp = error == nil ? description?.sdp : nil
            bridge.main { link in link.setLocal(sdp, type: .offer) }
        }
    }

    public func acceptOffer(sdp: String, patient: Bool) {
        // A copy-and-paste answer can sit in a chat window for minutes before the host uses it.
        failFast = !patient
        connection.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: sdp)) { [bridge] error in
            bridge.main { link in
                guard error == nil else { return link.finish() }
                link.flushCandidates()
                link.connection.answer(for: Self.noConstraints) { description, error in
                    let sdp = error == nil ? description?.sdp : nil
                    bridge.main { link in link.setLocal(sdp, type: .answer) }
                }
            }
        }
    }

    public func acceptAnswer(sdp: String) {
        connection.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [bridge] error in
            bridge.main { link in
                guard error == nil else { return link.finish() }
                link.flushCandidates()
            }
        }
    }

    public func addCandidate(_ candidate: IceCandidateInit) {
        guard remoteSet else {
            queued = Array((queued + [candidate]).suffix(TransportLimits.maxQueuedCandidates))
            return
        }
        // Browsers need sdpMid or sdpMLineIndex; there is one m-line, so default to it.
        let ice = RTCIceCandidate(sdp: candidate.candidate, sdpMLineIndex: Int32(candidate.sdpMLineIndex ?? 0), sdpMid: candidate.sdpMid)
        connection.add(ice) { error in
            if let error { NSLog("ivnet: a connection candidate was not usable: %@", String(describing: error)) }
        }
    }

    public func sendState(_ bytes: [UInt8]) {
        guard isOpen, stateChannel.readyState == .open,
              stateChannel.bufferedAmount <= UInt64(TransportLimits.stateBacklogBytes) else { return }
        stateChannel.sendData(RTCDataBuffer(data: Data(bytes), isBinary: true))
    }

    @discardableResult
    public func sendEvent(text: String) -> Bool {
        // The web drops events over MAX_EVENT_CHARS; on a reliable channel that is a silent desync.
        assert(text.utf16.count <= Wire.maxEventChars, "event over \(Wire.maxEventChars) UTF-16 units")
        return sendEvent(RTCDataBuffer(data: Data(text.utf8), isBinary: false))
    }

    @discardableResult
    public func sendEvent(binary: [UInt8]) -> Bool {
        assert(binary.count <= TransportLimits.maxIncomingBytes, "binary frame over \(TransportLimits.maxIncomingBytes) bytes")
        return sendEvent(RTCDataBuffer(data: Data(binary), isBinary: true))
    }

    public func close() {
        guard !closed else { return }
        closed = true
        bridge.link = nil
        stateChannel.close()
        eventsChannel.close()
        connection.close()
    }

    // MARK: - private

    private static let noConstraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)

    private func sendEvent(_ buffer: RTCDataBuffer) -> Bool {
        guard isOpen, eventsChannel.readyState == .open,
              eventsChannel.bufferedAmount <= UInt64(TransportLimits.eventBacklogBytes) else { return false }
        return eventsChannel.sendData(buffer)
    }

    private func finish() {
        guard !closed else { return }
        close()
        handlers.onClosed()
    }

    private func setLocal(_ sdp: String?, type: RTCSdpType) {
        guard !closed else { return }
        guard let sdp else { return finish() }
        connection.setLocalDescription(RTCSessionDescription(type: type, sdp: sdp)) { [bridge] error in
            bridge.main { link in
                guard error == nil else { return link.finish() }
                link.sendLocalDescription(type: type)
            }
        }
    }

    private func sendLocalDescription(type: RTCSdpType) {
        let send: @MainActor () -> Void = { [weak self] in
            guard let self, !self.closed, let sdp = self.connection.localDescription?.sdp else { return }
            let filtered = self.options.trickle ? sdp : self.filteredDescription(sdp)
            self.handlers.onSignal(type == .offer ? .offer(sdp: filtered) : .answer(sdp: filtered))
        }
        if options.trickle { return send() }
        waitForGathering(then: send)
    }

    /// Resolves when gathering completes, or after 4 s with whatever was found.
    private func waitForGathering(then done: @escaping @MainActor () -> Void) {
        if connection.iceGatheringState == .complete { return done() }
        var fired = false
        let once: @MainActor () -> Void = {
            guard !fired else { return }
            fired = true
            done()
        }
        gatherWaiters.append(once)
        DispatchQueue.main.asyncAfter(deadline: .now() + TransportLimits.gatherTimeoutMs / 1000) {
            MainActor.assumeIsolated { once() }
        }
    }

    /// Non-trickle descriptions carry their candidates; apply the same filter and cap to them.
    private func filteredDescription(_ sdp: String) -> String {
        var kept = 0
        let lines = sdp.components(separatedBy: "\r\n").filter { line in
            guard line.hasPrefix("a=candidate:") else { return true }
            guard CandidateFilter.allows(String(line.dropFirst(2))), kept < TransportLimits.maxTrickledCandidates else { return false }
            kept += 1
            return true
        }
        candidatesSent += kept
        return lines.joined(separator: "\r\n")
    }

    private func flushCandidates() {
        remoteSet = true
        let pending = queued
        queued = []
        for candidate in pending { addCandidate(candidate) }
    }

    fileprivate func generated(_ candidate: IceCandidateInit) {
        guard options.trickle, !closed, CandidateFilter.allows(candidate.candidate),
              trickled < TransportLimits.maxTrickledCandidates else { return }
        trickled += 1
        candidatesSent += 1
        handlers.onSignal(.candidate(candidate))
    }

    fileprivate func gatheringChanged(_ state: RTCIceGatheringState) {
        guard state == .complete else { return }
        let waiters = gatherWaiters
        gatherWaiters = []
        for waiter in waiters { waiter() }
    }

    fileprivate func connectionChanged(_ state: RTCPeerConnectionState) {
        if state == .closed || (state == .failed && (failFast || opened)) { finish() }
    }

    fileprivate func channelChanged(id: Int32, state: RTCDataChannelState) {
        if id == eventsChannel.channelId, state == .closed { return finish() }
        guard !opened, !closed, stateChannel.readyState == .open, eventsChannel.readyState == .open else { return }
        opened = true
        handlers.onOpen()
    }

    fileprivate func received(_ data: Data, isBinary: Bool, channel id: Int32) {
        guard !closed else { return }
        if id == stateChannel.channelId {
            if isBinary, data.count <= TransportLimits.maxIncomingBytes { handlers.onState([UInt8](data)) }
            return
        }
        if isBinary {
            if data.count <= TransportLimits.maxIncomingBytes { handlers.onEventBinary([UInt8](data)) }
        } else if let text = String(data: data, encoding: .utf8), text.utf16.count <= TransportLimits.maxIncomingBytes {
            handlers.onEventText(text)
        }
    }

    /// One factory for the process. libwebrtc's threads live as long as it does.
    private enum Factory {
        nonisolated(unsafe) static let shared: RTCPeerConnectionFactory = {
            RTCInitializeSSL()
            let factory = RTCPeerConnectionFactory(encoderFactory: nil, decoderFactory: nil)
            let options = RTCPeerConnectionFactoryOptions()
            options.ignoreLoopbackNetworkAdapter = true
            // utun* interfaces: VPN addresses add candidates that rarely work across the internet.
            options.ignoreVPNNetworkAdapter = true
            factory.setOptions(options)
            return factory
        }()
    }

    /// libwebrtc calls back on its signaling thread; everything goes onto the main queue in order.
    private final class Bridge: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, @unchecked Sendable {
        // Read and written only on the main queue.
        nonisolated(unsafe) weak var link: WebRTCPeerLink?

        func main(_ body: @escaping @MainActor (WebRTCPeerLink) -> Void) {
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let link = self.link else { return }
                    body(link)
                }
            }
        }

        func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
            let sdp = candidate.sdp
            let candidateInit = IceCandidateInit(
                candidate: sdp,
                sdpMid: candidate.sdpMid,
                sdpMLineIndex: Int(candidate.sdpMLineIndex),
                usernameFragment: CandidateFilter.usernameFragment(sdp)
            )
            main { $0.generated(candidateInit) }
        }

        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
            main { $0.gatheringChanged(newState) }
        }

        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
            main { $0.connectionChanged(newState) }
        }

        func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
            let id = dataChannel.channelId
            let state = dataChannel.readyState
            main { $0.channelChanged(id: id, state: state) }
        }

        func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
            let id = dataChannel.channelId
            let data = buffer.data
            let isBinary = buffer.isBinary
            main { $0.received(data, isBinary: isBinary, channel: id) }
        }

        func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
        func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    }
}

/// Which gathered candidates are worth sending (PLAN.md 3.11.1).
public enum CandidateFilter {
    /// false for loopback and link-local addresses (awdl*, llw* and bridge interfaces carry only
    /// link-local ones) and for anything that does not parse as a candidate line.
    public static func allows(_ candidate: String) -> Bool {
        let fields = candidate.split(separator: " ")
        guard fields.count >= 8, fields[0].hasPrefix("candidate:") else { return false }
        let address = fields[4].lowercased()
        if address.hasSuffix(".local") { return true }
        if address.hasPrefix("127.") || address == "::1" || address == "0.0.0.0" { return false }
        if address.hasPrefix("169.254.") { return false }
        if address.hasPrefix("fe8") || address.hasPrefix("fe9") || address.hasPrefix("fea") || address.hasPrefix("feb") { return false }
        return true
    }

    /// The `ufrag` attribute of a candidate line, which the browser reports as `usernameFragment`.
    public static func usernameFragment(_ candidate: String) -> String? {
        let fields = candidate.split(separator: " ")
        guard let index = fields.firstIndex(of: "ufrag"), fields.index(after: index) < fields.endIndex else { return nil }
        return String(fields[fields.index(after: index)])
    }
}
