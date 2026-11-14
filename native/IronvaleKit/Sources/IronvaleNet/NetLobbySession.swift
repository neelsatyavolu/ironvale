// Ported from src/net/session.ts (the lobby and connection half of NetSession) at commit cbe0add.
// The match half (MatchSync, spawns, takeover) needs a running Game and lands with M6/M7b; until
// then match messages are handed to `MatchHooks`, which ivpeer uses to run scripted matches.
import Foundation
import IronvaleCore
import IronvaleWire

/// `LobbyState` in api.ts.
public struct NetLobbyState: Sendable, Equatable {
    public var phase: LobbyPhase = .idle
    public var role: PeerRole?
    public var method: SignalMethod?
    /// The code to pass to the friend: a room code, an invite or a reply. Empty until there is one.
    public var code = ""
    public var error: NetFailure?
    public var localName: String
    public var peerName = "Friend"
    /// Guest: pressed Ready. Host: always true.
    public var localReady = false
    public var peerReady = false
    /// The host's choices. The guest sees a copy.
    public var config: NetMatchConfig
    /// Round trip in milliseconds, or -1 when not known.
    public var rttMs = -1
    /// A match with the friend is loading or under way.
    public var inMatch = false
}

/// `DEFAULT_NET_CONFIG` in api.ts, with the first listed map.
public extension NetMatchConfig {
    static func standard(mapId: String, difficulty: Difficulty = .regular) -> NetMatchConfig {
        NetMatchConfig(mapId: mapId, mode: .coop, rules: .skirmish, difficulty: difficulty, botCount: 8, killTarget: 10, duelBot: .none)
    }
}

/// What the session needs from the game, and where match traffic goes.
@MainActor
public struct MatchHooks {
    /// Ids of maps a peer may choose (`hooks.listMaps()` plus `range` in development builds).
    public var knownMaps: @MainActor () -> Set<String>
    /// The host pressed Start or the guest got `load`: load the map, then call `matchLoaded()`.
    public var beginMatch: @MainActor (NetMatchConfig, PeerRole) -> Void
    /// A match event the session does not handle itself (hit, death, action, switch, botSpawn,
    /// match, nade, boom), with the local arrival time.
    public var matchEvent: @MainActor (NetEvent, Double) -> Void
    /// Player state, bot snapshot or shot, with the local arrival time.
    public var matchBinary: @MainActor (BinaryMessage, Double) -> Void
    public var chat: @MainActor (_ name: String, _ text: String, _ mine: Bool) -> Void

    public init(
        knownMaps: @escaping @MainActor () -> Set<String>,
        beginMatch: @escaping @MainActor (NetMatchConfig, PeerRole) -> Void = { _, _ in },
        matchEvent: @escaping @MainActor (NetEvent, Double) -> Void = { _, _ in },
        matchBinary: @escaping @MainActor (BinaryMessage, Double) -> Void = { _, _ in },
        chat: @escaping @MainActor (String, String, Bool) -> Void = { _, _, _ in }
    ) {
        self.knownMaps = knownMaps
        self.beginMatch = beginMatch
        self.matchEvent = matchEvent
        self.matchBinary = matchBinary
        self.chat = chat
    }
}

/// Wire-level observation for logs and interop tests. Never changes behaviour.
@MainActor
public struct NetTap {
    public enum Channel: String, Sendable { case state, events }
    public enum Frame: Sendable, Equatable { case text(String), binary([UInt8]) }

    public var sent: @MainActor (Channel, Frame) -> Void = { _, _ in }
    public var received: @MainActor (Channel, Frame) -> Void = { _, _ in }
    /// A received frame the web would drop: undecodable binary, an invalid event, a frame type
    /// that does not belong on its channel.
    public var rejected: @MainActor (Channel, Frame, String) -> Void = { _, _, _ in }
    public var signal: @MainActor (_ outgoing: Bool, SignalMessage) -> Void = { _, _ in }
    public var relayServers: @MainActor (RelayClient.RelayServers) -> Void = { _ in }

    public init() {}
}

/// The two-player session: the lobby, the connection, the start of a match.
@MainActor
public final class NetLobbySession {
    public private(set) var state: NetLobbyState {
        didSet { if state != oldValue { onChange(state) } }
    }
    public var onChange: @MainActor (NetLobbyState) -> Void = { _ in }
    public var tap = NetTap()

    private let relay: RelayClient?
    private let makeLink: PeerLinkFactory
    private let extraIceServers: [IceServer]
    private let relayOnly: Bool
    private let hooks: MatchHooks

    public private(set) var clock = ClockSync()
    private var signaling: Signaling?
    private var link: PeerLink?
    private var relayServers: [IceServer] = []
    private var connectTimer: DispatchWorkItem?
    private var reachable: (at: Double, value: Bool)?

    public private(set) var match: NetMatchConfig?
    public private(set) var matchRole: PeerRole = .host
    private var localLoaded = false
    private var peerLoaded = false
    /// Local clock time the match starts; infinite until both have loaded.
    public private(set) var goAt = Double.infinity
    public private(set) var peerGone = false
    public private(set) var peerAway = false
    private var matchAttached = false
    private var queued: [NetEvent] = []
    private var pingId = 0
    private var pingsSent = 0
    private var nextPingAt: Double = 0
    /// Last player state from the peer (MatchSync.lastStateAt), for the 5 s timeout.
    public var lastStateAt: Double = 0

    /// - Parameters:
    ///   - relay: the relay, or nil when there is none (room codes are then unavailable).
    ///   - extraIceServers: `VITE_ICE_SERVERS` equivalent, already parsed.
    public init(relay: RelayClient?, makeLink: @escaping PeerLinkFactory, hooks: MatchHooks,
                localName: String = "Player", extraIceServers: [IceServer] = [], relayOnly: Bool = false) {
        self.relay = relay
        self.makeLink = makeLink
        self.hooks = hooks
        self.extraIceServers = extraIceServers
        self.relayOnly = relayOnly
        let firstMap = hooks.knownMaps().sorted().first ?? ""
        state = NetLobbyState(localName: Sanitize.name(localName), config: .standard(mapId: firstMap))
    }

    // MARK: - lobby

    /// Room codes are offered only when the relay answers `/health` (cached 10 s).
    public func roomCodesAvailable() async -> Bool {
        let now = NetClock.now()
        if let reachable, now - reachable.at < SessionTiming.reachableCacheMs { return reachable.value }
        let value = await relay?.healthy() ?? false
        reachable = (now, value)
        return value
    }

    public func host(_ method: SignalMethod) { open(role: .host, method: method, code: "") }

    public func join(_ method: SignalMethod, code: String) { open(role: .guest, method: method, code: code) }

    public func acceptReply(_ code: String) {
        guard state.role == .host, state.method == .manual else { return }
        state.error = nil
        signaling?.paste(code)
    }

    public func setConfig(_ change: (inout NetMatchConfig) -> Void) {
        guard state.role != .guest else { return }
        var config = state.config
        change(&config)
        config.botCount = Self.clampWhole(config.botCount, 1, EventCodec.maxNetBots)
        config.killTarget = Self.clampWhole(config.killTarget, 1, EventCodec.maxKillTarget)
        state.config = config
        if state.phase == .connected { send(.lobby(config)) }
    }

    public func setReady(_ ready: Bool) {
        guard state.role == .guest, state.phase == .connected else { return }
        state.localReady = ready
        send(.ready(ready))
    }

    public func start() {
        guard state.role == .host, state.phase == .connected, state.peerReady, match == nil else { return }
        guard hooks.knownMaps().contains(state.config.mapId) else {
            state.error = .unknownMap
            return
        }
        send(.load(state.config))
        beginMatch(state.config)
    }

    public func leave() {
        send(.bye(.left))
        closeConnection()
        resetLobby(error: nil)
        if match != nil, !peerGone { peerGone = true }
    }

    public func setName(_ name: String) {
        let localName = Sanitize.name(name)
        guard localName != state.localName else { return }
        state.localName = localName
        if state.phase == .connected { send(.hello(v: Wire.protocolVersion, name: localName)) }
    }

    public func sendChat(_ text: String) {
        let line = Sanitize.chat(text)
        guard !line.isEmpty, state.phase == .connected, link != nil else { return }
        send(.chat(line))
        hooks.chat(state.localName, line, true)
    }

    /// Native lifecycle (PLAN.md 3.11.1): miniaturised, occluded or hidden.
    public func setAway(_ away: Bool) { send(.away(away)) }

    // MARK: - match traffic (what MatchSync sends through `MatchLink`)

    public func send(_ event: NetEvent) {
        let text = EventCodec.encode(event)
        if link?.sendEvent(text: text) == true { tap.sent(.events, .text(text)) }
    }

    public func sendState(_ bytes: [UInt8]) {
        guard let link, link.isOpen else { return }
        link.sendState(bytes)
        tap.sent(.state, .binary(bytes))
    }

    public func sendShot(_ bytes: [UInt8]) {
        if link?.sendEvent(binary: bytes) == true { tap.sent(.events, .binary(bytes)) }
    }

    public var isConnected: Bool { link?.isOpen == true && state.phase == .connected }
    public var inMatch: Bool { match != nil && !peerGone && link != nil }
    public var frozen: Bool { inMatch && NetClock.now() < goAt }

    /// The map is loaded here: tell the peer, and (host) start the countdown once both are.
    public func matchLoaded() {
        guard match != nil else { return }
        localLoaded = true
        guard !peerGone else { return }
        send(.loaded)
        maybeGo()
    }

    /// The game left the match's map (`leaveMap` in session.ts, M6): the match is over here.
    public func leaveMatch() {
        guard match != nil else { return }
        match = nil
        queued = []
        matchAttached = false
        goAt = .infinity
        state.inMatch = false
    }

    /// The match is ready to take events: deliver what arrived while it was loading.
    public func attachMatch() {
        guard match != nil, !matchAttached else { return }
        matchAttached = true
        let now = NetClock.now()
        let pending = queued
        queued = []
        for event in pending { hooks.matchEvent(event, now) }
    }

    /// Once per frame: pings, and the peer timeout while the match runs.
    public func update(running: Bool) {
        let now = NetClock.now()
        if let link, link.isOpen, now >= nextPingAt {
            nextPingAt = now + (pingsSent < SessionTiming.pingFastCount ? SessionTiming.pingFastMs : SessionTiming.pingSlowMs)
            pingsSent += 1
            sendState(BinaryCodec.encodePing(id: pingId & 0xFF, sentAt: now))
            pingId += 1
            let rtt = Int(JS.round(clock.rtt))
            if rtt != state.rttMs { state.rttMs = rtt }
        }
        guard matchAttached else { return }
        if !running || !inMatch || frozen {
            // Nothing is expected from the other player yet: the timeout starts with the match.
            lastStateAt = now
            return
        }
        if now - lastStateAt > SessionTiming.peerTimeoutMs { peerLost(timeout: true) }
    }

    public func dispose() {
        send(.bye(.left))
        closeConnection()
    }

    // MARK: - connecting

    private func open(role: PeerRole, method: SignalMethod, code: String) {
        closeConnection()
        state.phase = .opening
        state.role = role
        state.method = method
        state.code = ""
        state.error = nil
        state.peerReady = false
        state.localReady = role == .host
        state.rttMs = -1
        let signaling: Signaling
        if method == .room {
            guard let relay else {
                fail(.signalUnreachable)
                return
            }
            signaling = RoomSignaling(relay: relay)
        } else {
            signaling = ManualSignaling()
        }
        self.signaling = signaling
        let handlers = makeHandlers(signaling: signaling, role: role, method: method)
        guard let relay else {
            signaling.open(role: role, code: code, handlers: handlers)
            return
        }
        // Ask for relay servers first, so both sides have them before any offer is made.
        Task { @MainActor in
            let result = await relay.relayServers()
            guard self.signaling === signaling else { return }
            self.tap.relayServers(result)
            self.relayServers = result.servers
            signaling.open(role: role, code: code, handlers: handlers)
        }
    }

    private func makeHandlers(signaling: Signaling, role: PeerRole, method: SignalMethod) -> SignalHandlers {
        SignalHandlers(
            onCode: { [weak self] text in
                guard let self, self.signaling === signaling else { return }
                self.state.code = text
                self.state.phase = role == .host ? .waiting : .reply
            },
            onPeer: { [weak self] present in
                guard let self, self.signaling === signaling else { return }
                if role == .guest {
                    if present { self.state.phase = .connecting }
                    return
                }
                guard present else {
                    // The friend closed the page before connecting: wait for them to come back.
                    self.dropLink()
                    self.state.phase = .waiting
                    return
                }
                self.newLink(signaling: signaling).makeOffer()
            },
            onSignal: { [weak self] message in
                guard let self, self.signaling === signaling else { return }
                self.tap.signal(false, message)
                switch message {
                case .candidate(let candidate):
                    self.link?.addCandidate(candidate)
                case .offer(let sdp) where role == .guest:
                    self.newLink(signaling: signaling).acceptOffer(sdp: sdp, patient: method == .manual)
                    if method == .room { self.expectConnection() }
                case .answer(let sdp) where role == .host && self.link != nil:
                    self.state.phase = .connecting
                    self.state.error = nil
                    self.link?.acceptAnswer(sdp: sdp)
                    self.expectConnection()
                default:
                    break
                }
            },
            onError: { [weak self] error in
                guard let self, self.signaling === signaling else { return }
                // A wrong paste on the host's side does not spoil the invite: say so and let them try again.
                let pasteErrors: [NetFailure] = [.badCode, .wrongCodeKind, .codeTooLong]
                if role == .host, method == .manual, pasteErrors.contains(error) {
                    self.state.error = error
                } else {
                    self.fail(error)
                }
            }
        )
    }

    private func newLink(signaling: Signaling) -> PeerLink {
        dropLink()
        let options = PeerLinkOptions(
            iceServers: IceServers.configured(extra: nil) + extraIceServers + relayServers,
            trickle: signaling.trickle,
            relayOnly: relayOnly
        )
        let created = WeakRef<AnyObject>()
        let handlers = PeerLinkHandlers(
            onOpen: { [weak self] in
                guard let self, self.link === created.value else { return }
                self.onConnected()
            },
            onState: { [weak self] bytes in
                guard let self, self.link === created.value else { return }
                self.tap.received(.state, .binary(bytes))
                self.onBinary(bytes, channel: .state)
            },
            onEventText: { [weak self] text in
                guard let self, self.link === created.value else { return }
                self.tap.received(.events, .text(text))
                self.onEvent(text)
            },
            onEventBinary: { [weak self] bytes in
                guard let self, self.link === created.value else { return }
                self.tap.received(.events, .binary(bytes))
                self.onBinary(bytes, channel: .events)
            },
            onClosed: { [weak self] in
                guard let self, self.link === created.value else { return }
                if self.state.phase == .connected { self.peerLost(timeout: false) } else { self.fail(.connectFailed) }
            },
            onSignal: { [weak self] message in
                guard let self, self.link === created.value else { return }
                self.tap.signal(true, message)
                self.signaling?.send(message)
            }
        )
        let link = makeLink(options, handlers)
        created.value = link
        self.link = link
        return link
    }

    private func expectConnection() {
        connectTimer?.cancel()
        let timer = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.connectTimer = nil
                if self.state.phase != .connected, self.state.phase != .idle { self.fail(.connectFailed) }
            }
        }
        connectTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + SessionTiming.connectTimeoutMs / 1000, execute: timer)
    }

    private func onConnected() {
        connectTimer?.cancel()
        connectTimer = nil
        // The relay has done its job; the two machines talk directly from here.
        signaling?.close()
        signaling = nil
        clock.reset()
        pingsSent = 0
        nextPingAt = 0
        state.phase = .connected
        state.error = nil
        send(.hello(v: Wire.protocolVersion, name: state.localName))
        if state.role == .host { send(.lobby(state.config)) }
    }

    private func fail(_ error: NetFailure) {
        closeConnection()
        resetLobby(error: error)
        orphanMatch()
    }

    private func resetLobby(error: NetFailure?) {
        state.phase = .idle
        state.role = nil
        state.method = nil
        state.code = ""
        state.error = error
        state.peerReady = false
        state.localReady = false
        state.inMatch = false
    }

    private func dropLink() {
        let link = self.link
        self.link = nil
        link?.close()
    }

    private func closeConnection() {
        connectTimer?.cancel()
        connectTimer = nil
        let signaling = self.signaling
        self.signaling = nil
        signaling?.close()
        dropLink()
    }

    // MARK: - messages in

    private func onBinary(_ bytes: [UInt8], channel: NetTap.Channel) {
        guard let message = BinaryCodec.decode(bytes) else {
            tap.rejected(channel, .binary(bytes), "undecodable binary")
            return
        }
        let now = NetClock.now()
        switch message {
        case .ping(let id, let sentAt):
            sendState(BinaryCodec.encodePong(id: id, sentAt: sentAt, remoteTime: now))
        case .pong(_, let sentAt, let remoteTime):
            clock.addSample(sentAt: sentAt, remoteTime: remoteTime, receivedAt: now)
        default:
            if case .state = message { lastStateAt = now }
            if matchAttached { hooks.matchBinary(message, now) }
        }
    }

    private func onEvent(_ text: String) {
        guard let event = EventCodec.parse(text) else {
            tap.rejected(.events, .text(text), "invalid event")
            return
        }
        let role = state.role
        switch event {
        case .hello(let v, let name):
            guard v == Wire.protocolVersion else {
                send(.bye(.left))
                fail(.version)
                return
            }
            state.peerName = name
        case .lobby(let config):
            if role == .guest, match == nil { state.config = config }
        case .ready(let ready):
            if role == .host { state.peerReady = ready }
        case .load(let config):
            // The host can only start once this guest has said it is ready; a repeat mid-match is ignored.
            guard role == .guest, state.localReady else { break }
            guard hooks.knownMaps().contains(config.mapId) else {
                send(.bye(.left))
                fail(.unknownMap)
                break
            }
            state.config = config
            beginMatch(config)
        case .loaded:
            peerLoaded = true
            maybeGo()
        case .go(let at):
            // Once per match: a later one could hold this player frozen while the other shoots.
            if role == .guest, match != nil, goAt == .infinity {
                let now = NetClock.now()
                goAt = min(now + SessionTiming.countdownMs * 3, max(now, clock.toLocal(at)))
            }
        case .chat(let line):
            hooks.chat(state.peerName, line, false)
        case .away(let away):
            peerAway = away
        case .bye(let reason):
            peerLost(timeout: reason == .timeout)
        default:
            if matchAttached {
                hooks.matchEvent(event, NetClock.now())
            } else if match != nil, queued.count < SessionTiming.maxQueuedEvents {
                queued.append(event)
            }
        }
    }

    // MARK: - match start and loss

    private func beginMatch(_ config: NetMatchConfig) {
        guard let role = state.role else { return }
        match = config
        matchRole = role
        localLoaded = false
        peerLoaded = false
        goAt = .infinity
        peerGone = false
        peerAway = false
        matchAttached = false
        queued = []
        state.inMatch = true
        state.localReady = role == .host
        state.peerReady = false
        state.error = nil
        hooks.beginMatch(config, role)
    }

    private func maybeGo() {
        guard matchRole == .host, match != nil, localLoaded, peerLoaded, goAt == .infinity else { return }
        // The host's clock is the reference; the guest converts it with its clock estimate.
        goAt = NetClock.now() + SessionTiming.countdownMs
        send(.go(at: goAt))
    }

    private func peerLost(timeout: Bool) {
        if timeout { send(.bye(.timeout)) }
        closeConnection()
        resetLobby(error: timeout ? .peerTimeout : .peerLeft)
        orphanMatch()
    }

    private func orphanMatch() {
        guard match != nil, !peerGone else { return }
        peerGone = true
    }

    private static func clampWhole(_ value: Int, _ low: Int, _ high: Int) -> Int {
        min(high, max(low, value))
    }
}

/// A reference filled in after the closures that check it are made.
@MainActor
final class WeakRef<T: AnyObject> {
    weak var value: T?
    init() {}
}
