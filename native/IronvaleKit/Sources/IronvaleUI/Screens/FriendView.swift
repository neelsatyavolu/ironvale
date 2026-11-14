// Ported from src/ui/screens/friend.ts and src/ui/styles/friend.css at cbe0add: name, then one of four views
// (invited, idle, link, lobby) chosen by the lobby step.
import AppKit
import SwiftUI

struct FriendScreen: View {
    @Bindable var model: InterfaceModel
    @State private var name = ""
    @State private var roomsAvailable: Bool?
    @State private var method: NetMethod = .manual
    @State private var lastRole: NetRole = .host
    @State private var joinCode = ""
    @State private var joinInvite = ""
    @State private var reply = ""
    @State private var copyNote = ""
    @Environment(\.layoutMetrics) private var metrics

    private var lobby: any LobbyController { model.lobby }
    private var state: LobbyState { lobby.state }
    private var view: FriendViewKind { FriendViewKind.of(state, invited: model.invitedCode) }

    var body: some View {
        ScreenFrame(solid: true) {
            ScrollContainer {
                Page {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Play with a friend").ledger(.title)
                        Text("Two players. One hosts and sends a link; the other opens it, picks a name and joins.").ledger(.lede)
                    }
                    .frame(maxWidth: 640, alignment: .leading)
                    .padding(.bottom, 48)

                    nameSection
                    if let error = state.error {
                        Text(LobbyText.errorText(error, state: state, wasHost: lastRole == .host))
                            .font(Ledger.sans(14)).foregroundStyle(Ledger.danger).padding(.top, 24)
                    }
                    Group {
                        switch view {
                        case .invited: invitedView
                        case .idle: idleView
                        case .link: linkView
                        case .lobby: lobbyView
                        }
                    }
                    .padding(.top, 32)
                }
            }
        }
        .task {
            name = state.localName
            let available = await lobby.roomCodesAvailable()
            // Room codes are the easier way: start there when they work.
            if roomsAvailable == nil, available { method = .room }
            roomsAvailable = available
        }
        .onChange(of: state.role) { _, role in if let role { lastRole = role } }
        .onChange(of: state.step) { _, step in
            // The code has done its job; an old one left in the box would only confuse the next attempt.
            if step == .connected {
                joinCode = ""
                joinInvite = ""
                reply = ""
            }
        }
    }

    private func commitName() {
        model.setPlayerName(name)
        name = lobby.state.localName
    }

    // MARK: Name

    private var nameSection: some View {
        LedgerSection(label: "Your name") {
            LedgerField(id: "friend.name", text: $name, placeholder: "", enabled: state.step == .idle || state.step == .connected, onSubmit: commitName)
                .frame(maxWidth: 304)
                .padding(.top, 12)
                .onChange(of: name) { _, value in if value.count > LobbyText.nameLength { name = String(value.prefix(LobbyText.nameLength)) } }
            Text("Your friend sees this. Up to 16 characters.").ledger(.note).padding(.top, 8)
        }
    }

    // MARK: Invited

    private var invitedView: some View {
        VStack(alignment: .leading, spacing: 32) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Your friend invited you to a game.").ledger(.headline)
                Text("Choose the name they will see, then join. The host picks the map and the rules.").ledger(.note)
            }
            actionRow {
                LedgerButton("Join game", .accent, id: "friend.invited.join") {
                    lastRole = .guest
                    commitName()
                    model.acceptInvite()
                }
                LedgerButton("Not now", id: "friend.invited.decline") { model.declineInvite() }
            }
        }
    }

    // MARK: Idle

    private var rooms: Bool { roomsAvailable == true }
    private var activeMethod: NetMethod { rooms ? method : .manual }

    private var idleView: some View {
        VStack(alignment: .leading, spacing: 32) {
            TwoColumns {
                LedgerSection(label: "Host") {
                    Text("You choose the map and the rules, then send your friend a link.").ledger(.note).padding(.top, 12)
                    LedgerButton("Host a game", .accent, id: "friend.host") {
                        lastRole = .host
                        commitName()
                        lobby.host(activeMethod)
                    }
                    .padding(.top, 12)
                }
            } right: {
                LedgerSection(label: "Join") {
                    Text(activeMethod == .room
                         ? "Paste the link your friend sent you, or type its six-character code."
                         : "Paste the invite your friend sent you. You will get a reply code to send back.")
                        .ledger(.note).padding(.top, 12)
                    HStack(alignment: .top, spacing: 12) {
                        if activeMethod == .room {
                            LedgerField(id: "friend.joinCode", text: $joinCode, placeholder: "Link or code", mono: true, onSubmit: join)
                                .frame(maxWidth: 200)
                        } else {
                            LedgerTextBlock(id: "friend.joinInvite", text: $joinInvite, placeholder: "Paste the invite from the host", lines: 3)
                        }
                        LedgerButton("Join", .primary, id: "friend.join", action: join)
                    }
                    .padding(.top, 12)
                }
            }
            Text(methodNote).ledger(.note)
            actionRow {
                LedgerButton("Back", id: "friend.back") { model.open(nil) }
                if rooms {
                    LedgerButton(method == .room ? "Use copy-and-paste codes instead" : "Use a link instead", id: "friend.method") {
                        method = method == .room ? .manual : .room
                    }
                }
            }
        }
    }

    private func join() {
        lastRole = .guest
        commitName()
        lobby.join(activeMethod, code: activeMethod == .room ? joinCode : joinInvite)
    }

    private var methodNote: String {
        if activeMethod == .room { return "The host gets a link to send. Opening it joins the game." }
        if rooms { return "No server involved: the host sends an invite code by any messenger and the guest sends a reply code back." }
        if roomsAvailable == nil { return "Checking whether room codes are available." }
        return "Room codes are not available here, so you pass two codes by hand: the host sends an invite by any messenger and the guest sends a reply back."
    }

    // MARK: Link

    private var linkView: some View {
        let room = state.method == .room
        let shown = room && !state.code.isEmpty ? LobbyText.inviteLink(state.code) : state.code
        return VStack(alignment: .leading, spacing: 32) {
            Text(LobbyText.linkText(state)).ledger(.headline)
            if !state.code.isEmpty {
                LedgerSection(label: room ? "Invite link" : state.role == .host ? "Invite code" : "Reply code", meta: copyNote) {
                    if room {
                        Text("Code \(state.code)").font(Ledger.mono(14)).foregroundStyle(Ledger.ink).padding(.top, 12)
                    }
                    Text(shown)
                        .font(Ledger.mono(13)).foregroundStyle(Ledger.body)
                        .lineLimit(room ? 1 : 4).truncationMode(.middle)
                        .textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Ledger.card, in: RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Ledger.line2))
                        .padding(.top, 12)
                    LedgerButton(room ? "Copy link" : "Copy code", .primary, id: "friend.copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(shown, forType: .string)
                        copyNote = "Copied"
                        Task { @MainActor in
                            try? await Task.sleep(for: .seconds(2))
                            copyNote = ""
                        }
                    }
                    .padding(.top, 12)
                }
            }
            if state.role == .host && state.method == .manual && state.step == .waiting {
                LedgerSection(label: "Reply from your friend") {
                    HStack(alignment: .top, spacing: 12) {
                        LedgerTextBlock(id: "friend.reply", text: $reply, placeholder: "Paste the reply from your friend", lines: 3)
                        LedgerButton("Connect", .accent, id: "friend.connect") { lobby.acceptReply(reply) }
                    }
                    .padding(.top, 12)
                }
            }
            if state.role == .host { HostSetup(model: model) }
            actionRow {
                LedgerButton("Cancel", id: "friend.cancel") { lobby.leave() }
            }
        }
    }

    // MARK: Lobby

    private var lobbyView: some View {
        let host = state.role == .host
        return VStack(alignment: .leading, spacing: 32) {
            HStack(alignment: .firstTextBaseline, spacing: 24) {
                Text("Connected to \(state.peerName)").ledger(.headline)
                Text(state.rttMs >= 0 ? "Round trip \(state.rttMs) ms" : "Measuring the connection").ledger(.label)
            }
            if host { HostSetup(model: model) } else { GuestSummary(state: state, maps: model.maps) }
            Text(readyLine).font(Ledger.sans(14)).foregroundStyle(readyLit ? Ledger.ink : Ledger.mute)
            actionRow {
                if host {
                    LedgerButton("Start match", .accent, id: "friend.start", enabled: state.peerReady) { lobby.start() }
                } else {
                    LedgerButton(state.localReady ? "Not ready" : "Ready", state.localReady ? .ghost : .accent, id: "friend.ready") {
                        lobby.setReady(!state.localReady)
                    }
                }
                LedgerButton("Leave", id: "friend.leave") { lobby.leave() }
            }
        }
    }

    private var readyLit: Bool { state.role == .host ? state.peerReady : state.localReady }

    private var readyLine: String {
        if state.role == .host {
            return state.peerReady ? "\(state.peerName) is ready. Start when you are." : "Waiting for \(state.peerName) to press Ready."
        }
        return state.localReady
            ? "You are ready. Waiting for \(state.peerName) to start the match."
            : "Press Ready when you are set. \(state.peerName) starts the match."
    }

    private func actionRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 12, content: content)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 16)
            .overlay(alignment: .top) { Rectangle().fill(Ledger.line2).frame(height: 1) }
    }
}


/// The host's match setup, shown while waiting and in the lobby (`renderSetup`).
private struct HostSetup: View {
    let model: InterfaceModel
    private var config: NetMatchConfig { model.lobby.state.config }

    var body: some View {
        let duel = config.mode == .duel
        let duelBot = duel && config.duelBot != .none
        TwoColumns {
            VStack(alignment: .leading, spacing: 24) {
                LedgerSection(label: "Mode") {
                    Segmented(id: "setup.mode", options: [SegmentOption(value: NetMode.coop, label: "Co-op"), SegmentOption(value: NetMode.duel, label: "Duel")],
                              selection: config.mode, wide: true) { mode in set { $0.mode = mode } }
                        .padding(.top, 12)
                    Text(LobbyText.modeNote(config.mode)).ledger(.note).fixedSize(horizontal: false, vertical: true).padding(.top, 8)
                }
                LedgerSection(label: "Map") {
                    Segmented(id: "setup.map", options: model.maps.map { SegmentOption(value: $0.id, label: $0.name) },
                              selection: config.mapId, wide: true) { id in set { $0.mapId = id } }
                        .padding(.top, 12)
                }
            }
        } right: {
            VStack(alignment: .leading, spacing: 24) {
                if !duel {
                    LedgerSection(label: "Rules") {
                        Segmented(id: "setup.rules", options: [SegmentOption(value: NetRules.skirmish, label: "Skirmish"), SegmentOption(value: NetRules.survival, label: "Survival")],
                                  selection: config.rules, wide: true) { rules in set { $0.rules = rules } }
                            .padding(.top, 12)
                        Text(LobbyText.rulesNote(config.rules)).ledger(.note).padding(.top, 8)
                    }
                } else {
                    LedgerSection(label: "Kills to win") {
                        LedgerSlider(id: "setup.kills", label: "Kills to win", range: 3...30, step: 1, value: Double(config.killTarget), wide: true,
                                     format: { "First to \(Int($0))" }) { v in set { $0.killTarget = Int(v) } }
                            .padding(.top, 12)
                    }
                    LedgerSection(label: "Bot teammate") {
                        Segmented(id: "setup.duelBot", options: [
                            SegmentOption(value: DuelBot.none, label: "None"), SegmentOption(value: DuelBot.host, label: "With me"),
                            SegmentOption(value: DuelBot.guest, label: "With friend"),
                        ], selection: config.duelBot, wide: true) { bot in set { $0.duelBot = bot } }
                            .padding(.top, 12)
                        Text(LobbyText.duelBotNote).ledger(.note).fixedSize(horizontal: false, vertical: true).padding(.top, 8)
                    }
                }
                // In a duel the difficulty sets how well the bot plays, so it shows only when there is one.
                if !duel || duelBot {
                    LedgerSection(label: "Difficulty") {
                        Segmented(id: "setup.difficulty", options: Difficulty.allCases.map { SegmentOption(value: $0, label: LobbyText.difficultyName($0)) },
                                  selection: config.difficulty, wide: true) { d in set { $0.difficulty = d } }
                            .padding(.top, 12)
                    }
                }
                if !duel {
                    LedgerSection(label: "Enemies") {
                        LedgerSlider(id: "setup.enemies", label: "Enemies", range: 4...16, step: 1,
                                     value: Double(min(16, max(4, config.botCount))), wide: true,
                                     format: { String(Int($0)) }) { v in set { $0.botCount = Int(v) } }
                            .padding(.top, 12)
                    }
                }
            }
        }
    }

    private func set(_ change: (inout NetMatchConfig) -> Void) { model.lobby.setConfig(change) }
}

/// What the guest sees of the host's choices (`facts`).
private struct GuestSummary: View {
    let state: LobbyState
    let maps: [MapInfo]

    var body: some View {
        LedgerSection(label: "Set up by the host") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 152), spacing: 24, alignment: .topLeading)], alignment: .leading, spacing: 16) {
                ForEach(Self.facts(state, maps: maps), id: \.0) { fact in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(fact.0).ledger(.label)
                        Text(fact.1).font(Ledger.sans(15)).foregroundStyle(Ledger.ink)
                    }
                }
            }
            .padding(.top, 12)
        }
    }

    /// The rows shown, with the duel and co-op visibility rules from friend.ts `renderLobby`.
    static func facts(_ state: LobbyState, maps: [MapInfo]) -> [(String, String)] {
        let config = state.config
        let duel = config.mode == .duel
        var rows: [(String, String)] = [
            ("Mode", duel ? "Duel" : "Co-op"),
            ("Map", maps.first { $0.id == config.mapId }?.name ?? config.mapId),
        ]
        if !duel { rows.append(("Rules", config.rules == .survival ? "Survival" : "Skirmish")) }
        if !(duel && config.duelBot == .none) { rows.append(("Difficulty", LobbyText.difficultyName(config.difficulty))) }
        if !duel { rows.append(("Enemies", String(config.botCount))) }
        if duel {
            rows.append(("Kills to win", "First to \(config.killTarget)"))
            rows.append(("Bot teammate", config.duelBot == .host ? "With \(state.peerName)" : config.duelBot == .guest ? "With you" : "None"))
        }
        return rows
    }
}

/// A one-line text input (`.iv-input`).
struct LedgerField: View {
    let id: String
    @Binding var text: String
    let placeholder: String
    var mono = false
    var enabled = true
    var onSubmit: () -> Void = {}

    var body: some View {
        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Ledger.mute))
            .textFieldStyle(.plain)
            .font(mono ? Ledger.mono(16) : Ledger.sans(15))
            .foregroundStyle(enabled ? Ledger.ink : Ledger.mute)
            .autocorrectionDisabled()
            .disabled(!enabled)
            .onSubmit(onSubmit)
            .padding(.horizontal, 12)
            .frame(height: 36)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(enabled ? Ledger.field : Ledger.line2))
            .navTextItem(id, enabled: enabled)
    }
}

/// A multi-line paste box for invite and reply codes (`.iv-input--block`).
struct LedgerTextBlock: View {
    let id: String
    @Binding var text: String
    let placeholder: String
    let lines: Int

    var body: some View {
        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Ledger.mute), axis: .vertical)
            .textFieldStyle(.plain)
            .font(Ledger.mono(13))
            .foregroundStyle(Ledger.ink)
            .lineLimit(lines, reservesSpace: true)
            .autocorrectionDisabled()
            .padding(.horizontal, 12).padding(.vertical, 8)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Ledger.field))
            .navTextItem(id)
    }
}
