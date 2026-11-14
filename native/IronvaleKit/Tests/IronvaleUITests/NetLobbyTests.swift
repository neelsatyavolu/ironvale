// M10: the interface over the real session (NetLobby over NetLobbySession). Two sessions joined by an
// in-memory link with copy-and-paste codes: the guest's InterfaceModel opens a pasted invite and joins,
// both lobbies reach `connected` with each other's names, and the host's config reaches the guest in the
// UI's types. Over WebRTC and the relay, against the web's NetSession, the app does the same in
// native/Tools/interop/invite-join.test.ts (check-m10.sh).
import Foundation
import IronvaleNet
import IronvaleWire
import Testing
@testable import IronvaleUI

/// Two links joined in memory; an offer names its link so the answer can find it.
@MainActor
private final class MemoryLink: PeerLink {
    static var registry: [String: MemoryLink] = [:]
    private static var next = 0
    let id: String
    let handlers: PeerLinkHandlers
    weak var partner: MemoryLink?
    private(set) var isOpen = false
    private var closed = false

    init(handlers: PeerLinkHandlers) {
        Self.next += 1
        id = "uilink\(Self.next)"
        self.handlers = handlers
        Self.registry[id] = self
    }

    static let factory: PeerLinkFactory = { _, handlers in MemoryLink(handlers: handlers) }

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
        later { if self.partner?.closed == false { self.partner?.handlers.onState(bytes) } }
    }
    func sendEvent(text: String) -> Bool {
        guard isOpen else { return false }
        later { if self.partner?.closed == false { self.partner?.handlers.onEventText(text) } }
        return true
    }
    func sendEvent(binary: [UInt8]) -> Bool {
        guard isOpen else { return false }
        later { if self.partner?.closed == false { self.partner?.handlers.onEventBinary(binary) } }
        return true
    }
    func close() {
        guard !closed else { return }
        closed = true
        isOpen = false
        let partner = partner
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
    private func later(_ body: @escaping @MainActor () -> Void) {
        DispatchQueue.main.async { MainActor.assumeIsolated(body) }
    }
}

@MainActor
private func makeLobby(relay: RelayClient? = nil) -> NetLobby {
    let hooks = MatchHooks(knownMaps: { ["railyard", "harbor"] }, beginMatch: { _, _ in }, matchEvent: { _, _ in },
                           matchBinary: { _, _ in }, chat: { _, _, _ in })
    return NetLobby(session: NetLobbySession(relay: relay, makeLink: MemoryLink.factory, hooks: hooks))
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
@Suite struct NetLobbyOverTheSession {
    @Test func aGuestInterfaceJoinsAHostAndSeesItsConfig() async throws {
        let host = makeLobby()
        host.setName("Hostess")
        host.setConfig { $0.mapId = "harbor"; $0.mode = .duel; $0.killTarget = 7; $0.difficulty = .elite; $0.duelBot = .guest }
        host.host(.manual)
        try await waitUntil("invite") { host.state.step == .waiting && !host.state.code.isEmpty }
        #expect(host.state.role == .host && host.state.method == .manual)

        let guest = makeLobby()
        let model = InterfaceModel(settings: SettingsStore(storage: nil), lobby: guest, storage: nil)
        model.setPlayerName("Guesty")
        model.lobby.join(.manual, code: host.state.code)
        try await waitUntil("reply") { guest.state.step == .reply && !guest.state.code.isEmpty }
        host.acceptReply(guest.state.code)
        try await waitUntil("connected") { host.state.step == .connected && guest.state.step == .connected }
        try await waitUntil("hello and lobby") { guest.state.peerName == "Hostess" && host.state.peerName == "Guesty" }
        try await waitUntil("config") { guest.state.config.mapId == "harbor" }
        #expect(guest.state.config == NetMatchConfig(mapId: "harbor", mode: .duel, rules: .skirmish, difficulty: .elite,
                                                     botCount: host.state.config.botCount, killTarget: 7, duelBot: .guest))
        #expect(FriendViewKind.of(guest.state, invited: model.invitedCode) == .lobby)
        // A guest cannot change the host's config.
        guest.setConfig { $0.mapId = "railyard" }
        #expect(guest.state.config.mapId == "harbor")

        guest.setReady(true)
        try await waitUntil("peer ready") { host.state.peerReady }
        guest.leave()
        try await waitUntil("bye") { host.state.error == .peerLeft }
        #expect(host.state.step == .idle && guest.state.step == .idle)
    }

    @Test func roomErrorsReachTheScreenInItsTerms() async throws {
        // No relay: room codes are unavailable and a room join fails as the web's does.
        let offline = makeLobby()
        #expect(await offline.roomCodesAvailable() == false)
        let model = InterfaceModel(settings: SettingsStore(storage: nil), lobby: offline, storage: nil)
        #expect(model.openInviteURL(URL(string: "ironvale://join?code=K7M3QX")!))
        model.acceptInvite()
        #expect(offline.state.error == .signalUnreachable && offline.state.step == .idle && offline.state.role == nil)
        // A pasted link that is no room code.
        let relayed = makeLobby(relay: RelayClient(url: "ws://127.0.0.1:9")!)
        relayed.join(.room, code: "https://ironvale.n3el.dev/?join=K7M")
        try await waitUntil("bad code") { relayed.state.error != nil }
        #expect(relayed.state.error == .badCode)
    }

    @Test func configMapsBothWays() {
        let wire = IronvaleWire.NetMatchConfig(mapId: "railyard", mode: .coop, rules: .survival, difficulty: .recruit,
                                               botCount: 12, killTarget: 5, duelBot: .host)
        let ui = NetLobby.uiConfig(wire)
        #expect(ui == NetMatchConfig(mapId: "railyard", mode: .coop, rules: .survival, difficulty: .recruit, botCount: 12, killTarget: 5, duelBot: .host))
        #expect(NetLobby.wireConfig(ui, fallback: wire) == wire)
    }
}
