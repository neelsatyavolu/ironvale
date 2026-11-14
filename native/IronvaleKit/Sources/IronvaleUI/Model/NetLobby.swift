// The lobby screens over the real network session (IronvaleNet's NetLobbySession, ported from
// src/net/session.ts): what the friend screen, invite links and the HUD's lobby read and call. The
// session's types carry the web's raw values, so the mapping is one to one (NetTypes.swift).
import Foundation
import IronvaleNet
import IronvaleWire
import Observation

@MainActor
@Observable
public final class NetLobby: LobbyController {
    public private(set) var state: LobbyState
    /// Every lobby change, after `state` has it (the app's `--lobby-log`).
    @ObservationIgnored public var onChange: (LobbyState) -> Void = { _ in }

    @ObservationIgnored public let session: NetLobbySession
    /// Pings and round trips run from `session.update`; the lobby has no game frame, so it pumps it.
    static let pumpInterval: Duration = .milliseconds(100)

    public init(session: NetLobbySession) {
        self.session = session
        state = Self.lobbyState(session.state)
        session.onChange = { [weak self] next in
            guard let self else { return }
            state = Self.lobbyState(next)
            onChange(state)
        }
        Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.pumpInterval)
                guard let lobby = self else { return }
                if !lobby.session.inMatch { lobby.session.update(running: false) }
            }
        }
    }

    public func roomCodesAvailable() async -> Bool { await session.roomCodesAvailable() }
    public func setName(_ name: String) { session.setName(name) }
    public func host(_ method: NetMethod) { session.host(Self.method(method)) }
    public func join(_ method: NetMethod, code: String) { session.join(Self.method(method), code: code) }
    public func acceptReply(_ reply: String) { session.acceptReply(reply) }
    public func setReady(_ ready: Bool) { session.setReady(ready) }
    public func start() { session.start() }
    public func leave() { session.leave() }

    public func setConfig(_ change: (inout NetMatchConfig) -> Void) {
        session.setConfig { wire in
            var config = Self.uiConfig(wire)
            change(&config)
            wire = Self.wireConfig(config, fallback: wire)
        }
    }

    // MARK: Mapping

    static func method(_ method: NetMethod) -> SignalMethod { method == .room ? .room : .manual }

    static func lobbyState(_ net: NetLobbyState) -> LobbyState {
        var state = LobbyState(config: uiConfig(net.config))
        state.step = LobbyStep(rawValue: net.phase.rawValue) ?? .idle
        state.role = net.role.flatMap { NetRole(rawValue: $0.rawValue) }
        state.method = net.method.flatMap { NetMethod(rawValue: $0.rawValue) }
        state.code = net.code
        state.error = net.error.flatMap { NetErrorCode(rawValue: $0.rawValue) }
        state.localName = net.localName
        state.peerName = net.peerName
        state.localReady = net.localReady
        state.peerReady = net.peerReady
        state.rttMs = net.rttMs
        state.inMatch = net.inMatch
        return state
    }

    static func uiConfig(_ wire: IronvaleWire.NetMatchConfig) -> NetMatchConfig {
        NetMatchConfig(mapId: wire.mapId, mode: NetMode(rawValue: wire.mode.rawValue) ?? .coop,
                       rules: NetRules(rawValue: wire.rules.rawValue) ?? .skirmish,
                       difficulty: Difficulty(rawValue: wire.difficulty.rawValue) ?? .regular,
                       botCount: wire.botCount, killTarget: wire.killTarget,
                       duelBot: DuelBot(rawValue: wire.duelBot.rawValue) ?? .none)
    }

    static func wireConfig(_ ui: NetMatchConfig, fallback: IronvaleWire.NetMatchConfig) -> IronvaleWire.NetMatchConfig {
        IronvaleWire.NetMatchConfig(mapId: ui.mapId, mode: IronvaleWire.NetMode(rawValue: ui.mode.rawValue) ?? fallback.mode,
                                    rules: IronvaleWire.NetRules(rawValue: ui.rules.rawValue) ?? fallback.rules,
                                    difficulty: IronvaleWire.Difficulty(rawValue: ui.difficulty.rawValue) ?? fallback.difficulty,
                                    botCount: ui.botCount, killTarget: ui.killTarget,
                                    duelBot: IronvaleWire.DuelBot(rawValue: ui.duelBot.rawValue) ?? fallback.duelBot)
    }
}
