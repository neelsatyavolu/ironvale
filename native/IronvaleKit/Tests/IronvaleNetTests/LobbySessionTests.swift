// NetLobbySession end to end over copy-and-paste codes and an in-memory link: the lobby
// handshake of session.ts (hello, lobby, ready, load, loaded, go), chat, bye and the version check.
// The same flow runs over WebRTC against the web's NetSession in native/Tools/interop.
import Foundation
import IronvaleWire
import Testing
@testable import IronvaleNet

/// Two links joined in memory. An offer names its link, so the answer can find it.
@MainActor
final class LoopbackLink: PeerLink {
    nonisolated(unsafe) static var registry: [String: LoopbackLink] = [:]
    private static var next = 0
    let id: String
    let handlers: PeerLinkHandlers
    weak var partner: LoopbackLink?
    private(set) var isOpen = false
    private var closed = false

    init(handlers: PeerLinkHandlers) {
        Self.next += 1
        id = "link\(Self.next)"
        self.handlers = handlers
        Self.registry[id] = self
        Self.latest = self
    }

    nonisolated(unsafe) static weak var latest: LoopbackLink?

    static func make(_ options: PeerLinkOptions, _ handlers: PeerLinkHandlers) -> PeerLink {
        LoopbackLink(handlers: handlers)
    }

    func makeOffer() { later { self.handlers.onSignal(.offer(sdp: "v=0\r\no=\(self.id)\r\n")) } }

    func acceptOffer(sdp: String, patient: Bool) {
        let hostID = sdp.components(separatedBy: "o=").last?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        partner = Self.registry[hostID]
        partner?.partner = self
        later { self.handlers.onSignal(.answer(sdp: "v=0\r\no=\(self.id)\r\n")) }
    }

    func acceptAnswer(sdp: String) {
        later {
            self.open()
            self.partner?.open()
        }
    }

    func addCandidate(_ candidate: IceCandidateInit) {}

    func sendState(_ bytes: [UInt8]) {
        guard isOpen else { return }
        later { self.partner?.deliver { $0.handlers.onState(bytes) } }
    }

    func sendEvent(text: String) -> Bool {
        guard isOpen else { return false }
        later { self.partner?.deliver { $0.handlers.onEventText(text) } }
        return true
    }

    func sendEvent(binary: [UInt8]) -> Bool {
        guard isOpen else { return false }
        later { self.partner?.deliver { $0.handlers.onEventBinary(binary) } }
        return true
    }

    func close() {
        guard !closed else { return }
        closed = true
        isOpen = false
        let partner = self.partner
        later { partner?.remoteClosed() }
    }

    private func open() {
        guard !isOpen, !closed else { return }
        isOpen = true
        handlers.onOpen()
    }

    private func remoteClosed() {
        guard !closed else { return }
        closed = true
        isOpen = false
        handlers.onClosed()
    }

    private func deliver(_ body: (LoopbackLink) -> Void) {
        if !closed { body(self) }
    }

    private func later(_ body: @escaping @MainActor () -> Void) {
        DispatchQueue.main.async { MainActor.assumeIsolated(body) }
    }
}

@MainActor
private final class Recorder {
    var began: [(NetMatchConfig, PeerRole)] = []
    var chat: [String] = []
    var events: [NetEvent] = []
    var binaries: [BinaryMessage] = []
}

@MainActor
private func makeSession(_ recorder: Recorder, name: String) -> NetLobbySession {
    let hooks = MatchHooks(
        knownMaps: { ["railyard", "range"] },
        beginMatch: { config, role in recorder.began.append((config, role)) },
        matchEvent: { event, _ in recorder.events.append(event) },
        matchBinary: { message, _ in recorder.binaries.append(message) },
        chat: { name, text, _ in recorder.chat.append("\(name): \(text)") }
    )
    return NetLobbySession(relay: nil, makeLink: LoopbackLink.make, hooks: hooks, localName: name)
}

@MainActor
private func waitUntil(_ what: String, _ condition: () -> Bool) async throws {
    for _ in 0..<400 where !condition() {
        try await Task.sleep(for: .milliseconds(5))
    }
    #expect(condition(), "timed out waiting for \(what)")
    if !condition() { throw CancellationError() }
}

@MainActor
@Test func manualLobbyHandshakeAndMatchStart() async throws {
    let hostLog = Recorder()
    let guestLog = Recorder()
    let host = makeSession(hostLog, name: "Hostess")
    let guest = makeSession(guestLog, name: "  Guesty!!  ")
    let duel = NetMatchConfig(mapId: "range", mode: .duel, rules: .skirmish, difficulty: .elite, botCount: 99, killTarget: 0, duelBot: .guest)
    host.setConfig { $0 = duel }
    // The host clamps what it sets (session.ts setConfig).
    #expect(host.state.config.botCount == 32 && host.state.config.killTarget == 1)

    host.host(.manual)
    try await waitUntil("invite") { host.state.phase == .waiting && host.state.code.hasPrefix("IVH1.") }
    guest.join(.manual, code: " \n" + host.state.code + "\n")
    try await waitUntil("reply") { guest.state.phase == .reply && guest.state.code.hasPrefix("IVG1.") }
    // A wrong paste does not spoil the invite.
    host.acceptReply(host.state.code)
    try await waitUntil("wrong-kind error") { host.state.error == .wrongCodeKind }
    #expect(host.state.phase == .waiting)
    host.acceptReply(guest.state.code)
    try await waitUntil("connected") { host.state.phase == .connected && guest.state.phase == .connected }
    try await waitUntil("hello and lobby") { guest.state.peerName == "Hostess" && host.state.peerName == "Guesty" && guest.state.config == host.state.config }

    host.start()
    #expect(hostLog.began.isEmpty, "the host cannot start before the guest is ready")
    guest.setReady(true)
    try await waitUntil("peer ready") { host.state.peerReady }
    host.start()
    try await waitUntil("load reached the guest") { guestLog.began.count == 1 }
    #expect(hostLog.began.first?.1 == .host && guestLog.began.first?.1 == .guest)
    #expect(guestLog.began.first?.0 == host.state.config)
    #expect(host.state.inMatch && guest.state.inMatch)

    // A match event before the guest has loaded is queued, then delivered on attach.
    host.send(.switchWeapon(.mp5))
    try await Task.sleep(for: .milliseconds(20))
    #expect(guestLog.events.isEmpty)
    for session in [host, guest] {
        session.attachMatch()
        session.matchLoaded()
    }
    try await waitUntil("go") { guest.goAt.isFinite && host.goAt.isFinite }
    #expect(guestLog.events == [.switchWeapon(.mp5)])
    #expect(guest.frozen)

    // State and shots go to the match hooks.
    let state = PlayerState(seq: 1, time: 1000, x: 1, y: 2, z: 3, vx: 0, vy: 0, vz: 0, yaw: 0.5, pitch: 0, crouching: false,
                            sprinting: false, aiming: true, alive: true, onGround: true, reloading: false, weapon: .m4a1, health: 100, life: 0)
    host.sendState(BinaryCodec.encodeState(state))
    host.sendShot(BinaryCodec.encodeShot(ShotMessage(actor: 0, weapon: .m24, muzzle: Vec3(0, 1, 0), direction: Vec3(0, 0, -1), ends: [Vec3(0, 1, -10)])))
    try await waitUntil("state and shot") { guestLog.binaries.count == 2 }

    // Pings run from update(); the pong gives both sides a round trip.
    for _ in 0..<5 {
        host.update(running: true)
        guest.update(running: true)
        try await Task.sleep(for: .milliseconds(5))
    }
    try await waitUntil("clock sync") { host.clock.synced }

    guest.sendChat("  hi\u{0007} there  ")
    try await waitUntil("chat") { hostLog.chat == ["Guesty: hi there"] }
    #expect(guestLog.chat == ["Guesty: hi there"])

    guest.leave()
    try await waitUntil("bye") { host.state.error == .peerLeft }
    #expect(host.state.phase == .idle && !host.inMatch && host.peerGone)
}

@MainActor
@Test func versionMismatchEndsTheConnection() async throws {
    let host = makeSession(Recorder(), name: "A")
    let guest = makeSession(Recorder(), name: "B")
    host.host(.manual)
    try await waitUntil("invite") { !host.state.code.isEmpty }
    guest.join(.manual, code: host.state.code)
    try await waitUntil("reply") { !guest.state.code.isEmpty }
    host.acceptReply(guest.state.code)
    try await waitUntil("connected") { host.state.phase == .connected && guest.state.phase == .connected }
    // An old peer says hello with another protocol version.
    // The guest's link is the one made last (the host makes its offer first).
    let guestLink = try #require(LoopbackLink.latest)
    _ = guestLink.sendEvent(text: #"{"t":"hello","v":3,"name":"Old"}"#)
    try await waitUntil("version error") { host.state.error == .version || guest.state.error == .version }
}

@MainActor
@Test func guestErrors() async throws {
    let guest = makeSession(Recorder(), name: "B")
    guest.join(.manual, code: "IVH1.%%%")
    try await waitUntil("bad code") { guest.state.error == .badCode }
    guest.join(.manual, code: "IVG1.abc")
    try await waitUntil("wrong kind") { guest.state.error == .wrongCodeKind }
    guest.join(.manual, code: String(repeating: "a", count: 6001))
    try await waitUntil("too long") { guest.state.error == .codeTooLong }
    // No relay configured: room codes are unavailable and a room join fails at once.
    #expect(await guest.roomCodesAvailable() == false)
    guest.join(.room, code: "ABC234")
    #expect(guest.state.error == .signalUnreachable)
}
