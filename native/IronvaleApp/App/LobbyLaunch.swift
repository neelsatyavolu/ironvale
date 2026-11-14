// M10: the interface's lobby is the real network session (IronvaleUI NetLobby over IronvaleNet's
// NetLobbySession and the WebRTC link), so `ironvale://join?code=` and a pasted `?join=` link join a
// room through the relay. Launch arguments, for the invite end-to-end test
// (native/Tools/interop/invite-join.test.ts, run by native/ci/check-m10.sh):
//   --signal URL               the relay (default: RelayDefaults)
//   --net-name NAME            the player's name, as typed into the friend screen's name field
//   --accept-invite            when an invite link opens the friend screen, press its "Join game" button
//   --paste-join TEXT          type TEXT into the friend screen's "Link or code" field and press Join
//   --lobby-log PATH           JSON lines: invites, joins, every lobby change, events received
//   --lobby-quit-connected S   S seconds after the lobby connects, leave it and quit
import AppKit
import Foundation
import IronvaleNet
import IronvaleTransportWebRTC
import IronvaleUI
import os

struct LobbyLaunchOptions {
    var signal: String?
    var name: String?
    var acceptInvite = false
    var pasteJoin: String?
    var logPath: String?
    var quitConnected: Double?

    static func parse(_ arguments: some Sequence<String>) -> LobbyLaunchOptions {
        var options = LobbyLaunchOptions()
        var iterator = arguments.makeIterator()
        while let arg = iterator.next() {
            switch arg {
            case "--signal": options.signal = iterator.next()
            case "--net-name": options.name = iterator.next()
            case "--accept-invite": options.acceptInvite = true
            case "--paste-join": options.pasteJoin = iterator.next()
            case "--lobby-log": options.logPath = iterator.next()
            case "--lobby-quit-connected": options.quitConnected = iterator.next().flatMap { Double($0) }
            default: continue
            }
        }
        return options
    }
}

@MainActor
final class LobbyLaunch {
    private static let logger = Logger(subsystem: "dev.n3el.ironvale", category: "lobby")

    let options: LobbyLaunchOptions
    let lobby: NetLobby
    private weak var interface: InterfaceModel?
    private let log: FileHandle?
    private let started = ProcessInfo.processInfo.systemUptime
    private var quitScheduled = false

    /// The lobby for the interface: the relay from `--signal` (or the deployed one) and WebRTC links.
    init(arguments: some Sequence<String>, knownMaps: Set<String>) {
        options = LobbyLaunchOptions.parse(arguments)
        let relay = RelayClient(url: options.signal ?? RelayDefaults.url)
        let hooks = MatchHooks(
            knownMaps: { knownMaps },
            // A match started from this lobby is not wired to the game yet (two-player matches run through
            // NetDuel / NetMatch); the lobby still reaches `inMatch`, and the log says the load arrived.
            beginMatch: { _, _ in },
            matchEvent: { _, _ in },
            matchBinary: { _, _ in },
            chat: { _, _, _ in }
        )
        let session = NetLobbySession(relay: relay, makeLink: WebRTCPeerLink.make, hooks: hooks)
        lobby = NetLobby(session: session)
        if let path = options.logPath {
            FileManager.default.createFile(atPath: path, contents: nil)
            log = FileHandle(forWritingAtPath: path)
        } else {
            log = nil
        }
        lobby.onChange = { [weak self] state in self?.changed(state) }
        var tap = NetTap()
        tap.received = { [weak self] channel, frame in
            if channel == .events, case let .text(text) = frame { self?.write("recv", ["data": text]) }
        }
        tap.rejected = { [weak self] channel, _, reason in self?.write("reject", ["channel": channel.rawValue, "reason": reason]) }
        session.tap = tap
        write("start", ["signal": options.signal ?? RelayDefaults.url])
    }

    /// The interface exists: apply `--net-name` and `--paste-join`.
    func attach(_ interface: InterfaceModel) {
        self.interface = interface
        if let name = options.name { interface.setPlayerName(name) }
        guard let text = options.pasteJoin else { return }
        Task { @MainActor in
            // The friend screen offers the "Link or code" field only when room codes work (FriendView).
            guard await lobby.roomCodesAvailable() else {
                write("error", ["reason": "room codes unavailable: the relay did not answer /health"])
                return
            }
            write("join", ["source": "paste", "text": text])
            interface.setPlayerName(interface.lobby.state.localName)
            interface.lobby.join(.room, code: text)
        }
    }

    /// An invite link opened the friend screen (`application(_:open:)`).
    func inviteOpened(_ url: URL) {
        guard let interface else { return }
        write("invite", ["url": url.absoluteString, "code": interface.invitedCode])
        guard options.acceptInvite else { return }
        // What the invited view's "Join game" button does (FriendView.invitedView).
        write("join", ["source": "url", "code": interface.invitedCode])
        interface.setPlayerName(interface.lobby.state.localName)
        interface.acceptInvite()
    }

    private func changed(_ state: LobbyState) {
        write("lobby", ["step": state.step.rawValue, "role": state.role?.rawValue ?? "", "code": state.code,
                        "error": state.error?.rawValue ?? "", "localName": state.localName, "peerName": state.peerName,
                        "map": state.config.mapId, "inMatch": "\(state.inMatch)"])
        guard state.step == .connected, let seconds = options.quitConnected, !quitScheduled else { return }
        quitScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.write("leave", ["rttMs": "\(self.lobby.state.rttMs)", "peerName": self.lobby.state.peerName])
                self.lobby.leave()
                // Let the bye reach the peer before the process goes.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
            }
        }
    }

    private func write(_ kind: String, _ fields: [String: String] = [:]) {
        var object: [String: Any] = fields
        object["kind"] = kind
        object["t"] = ((ProcessInfo.processInfo.systemUptime - started) * 1000).rounded() / 1000
        guard let log, let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        log.write(data + Data("\n".utf8))
        Self.logger.info("\(kind, privacy: .public) \(fields.description, privacy: .public)")
    }
}
