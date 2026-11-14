// A stand-in for the network session so the lobby screens can be built and tested before M5.
// It walks the same steps the web session does (src/net/session.ts) without touching the network.
import Foundation
import Observation

@MainActor
@Observable
public final class MockLobby: LobbyController {
    public private(set) var state: LobbyState
    /// What `roomCodesAvailable` answers.
    public var roomsAvailable: Bool
    /// The room code a host gets. Fixed so screens and tests are repeatable.
    public var nextRoomCode = "K7M3QX"

    public init(maps: [MapInfo] = WebData.shared.maps, roomsAvailable: Bool = true) {
        state = LobbyState(config: NetMatchConfig(mapId: maps.first?.id ?? ""))
        self.roomsAvailable = roomsAvailable
    }

    public func roomCodesAvailable() async -> Bool { roomsAvailable }

    public func setName(_ name: String) {
        state.localName = LobbyText.mockSanitizeName(name)
    }

    public func host(_ method: NetMethod) {
        state.error = nil
        state.role = .host
        state.method = method
        state.step = .waiting
        state.localReady = true
        state.code = method == .room ? nextRoomCode : "IV1-INVITE-" + String(repeating: "A1b2", count: 24)
    }

    public func join(_ method: NetMethod, code: String) {
        state.error = nil
        state.role = .guest
        state.method = method
        state.localReady = false
        if code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            state.error = .badCode
            state.step = .idle
            return
        }
        state.step = method == .room ? .connecting : .reply
        state.code = method == .room ? "" : "IV1-REPLY-" + String(repeating: "Z9y8", count: 24)
    }

    public func acceptReply(_ reply: String) {
        guard state.role == .host else { return }
        if reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            state.error = .badCode
            return
        }
        state.error = nil
        state.step = .connecting
    }

    public func setConfig(_ change: (inout NetMatchConfig) -> Void) {
        guard state.role != .guest else { return }
        var next = state.config
        change(&next)
        next.botCount = min(NetMatchConfig.botRange.upperBound, max(NetMatchConfig.botRange.lowerBound, next.botCount))
        next.killTarget = min(NetMatchConfig.killRange.upperBound, max(NetMatchConfig.killRange.lowerBound, next.killTarget))
        state.config = next
    }

    public func setReady(_ ready: Bool) {
        guard state.role == .guest else { return }
        state.localReady = ready
    }

    public func start() {
        guard state.role == .host, state.peerReady, state.step == .connected else { return }
        state.inMatch = true
    }

    public func leave() {
        let name = state.localName
        let config = state.config
        state = LobbyState(config: config)
        state.localName = name
    }

    // MARK: Driving the mock (tests, previews of states, the app before M5)

    /// The other side answered: both players are in the lobby.
    public func simulateConnected(peerName: String = "Sam", rttMs: Int = 38) {
        guard state.role != nil else { return }
        state.step = .connected
        state.peerName = peerName
        state.rttMs = rttMs
        state.peerReady = state.role == .guest
        state.error = nil
    }

    public func simulatePeerReady(_ ready: Bool) {
        guard state.role == .host else { return }
        state.peerReady = ready
    }

    public func simulateError(_ error: NetErrorCode) {
        let name = state.localName
        let peer = state.peerName
        state = LobbyState(config: state.config)
        state.localName = name
        state.peerName = peer
        state.error = error
    }
}
