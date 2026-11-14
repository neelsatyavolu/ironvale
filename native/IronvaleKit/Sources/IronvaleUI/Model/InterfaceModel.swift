// Ported from the screen state machine in src/ui/index.ts at cbe0add: match phase x overlay -> screen,
// Escape/back rules, first-run gating and the hand-offs between menu, sheets and lobby.
import Foundation
import Observation

public enum MatchPhase: String, Sendable { case menu, loading, playing, paused, won, lost }
public enum ScreenID: String, Sendable, CaseIterable { case menu, loading, pause, end, settings, controls, firstRun, friend, credits }
public enum Overlay: String, Sendable { case settings, controls, firstRun, friend, credits }
public enum SettingsTab: String, Sendable, CaseIterable { case graphics, controls, audio, gameplay }

/// A solo match to start (the menu's choices).
public struct MatchRequest: Equatable, Sendable {
    public var mapId: String
    public var mode: MatchMode
    public var difficulty: Difficulty
    public var botCount: Int
}

/// What the interface asks of the game. The app wires these at M10 integration; nil runs the built-in demo flow.
public struct InterfaceCommands {
    public var startMatch: @MainActor (MatchRequest) -> Void
    public var restart: @MainActor () -> Void
    public var resume: @MainActor () -> Void
    public var quitToMenu: @MainActor () -> Void

    public init(startMatch: @escaping @MainActor (MatchRequest) -> Void, restart: @escaping @MainActor () -> Void,
                resume: @escaping @MainActor () -> Void, quitToMenu: @escaping @MainActor () -> Void) {
        self.startMatch = startMatch
        self.restart = restart
        self.resume = resume
        self.quitToMenu = quitToMenu
    }
}

public struct LoadingInfo: Equatable, Sendable {
    public var mapName = ""
    public var tagline = ""
    public var detail = ""
    public var label = ""
    public var progress = 0.0
    public var tips: [String] = []
}

public struct PauseInfo: Equatable, Sendable {
    public var detail = ""
    public var note = ""
    /// In a match with a friend: it keeps running and cannot be restarted from here.
    public var live = false
}

@MainActor
@Observable
public final class InterfaceModel {
    public let settings: SettingsStore
    public let lobby: any LobbyController
    public let maps: [MapInfo]
    @ObservationIgnored let storage: StringStore?
    @ObservationIgnored public var commands: InterfaceCommands?

    public private(set) var phase: MatchPhase = .menu
    public private(set) var overlay: Overlay?
    public private(set) var menuChoices: MenuChoices
    public var menuError = ""
    public var settingsTab: SettingsTab = .graphics
    public private(set) var loading = LoadingInfo()
    public private(set) var pause = PauseInfo()
    public private(set) var result: MatchResult?
    /// The room code from an invite link (`?join=` or `ironvale://join`), until joined or declined.
    public private(set) var invitedCode = ""
    /// The settings sheet opened the controls reference, so Back returns there.
    private var controlsReturn: Overlay?
    private var pendingMatch: MatchRequest?

    public init(settings: SettingsStore, lobby: any LobbyController, storage: StringStore?, maps: [MapInfo] = WebData.shared.maps) {
        self.settings = settings
        self.lobby = lobby
        self.storage = storage
        self.maps = maps
        menuChoices = MenuChoices.load(storage, maps: maps)
        lobby.setName(PlayerName.read(storage))
    }

    /// The name field: clean it, keep it for next time (`ironvale.net.v1`) and tell the lobby.
    public func setPlayerName(_ raw: String) {
        lobby.setName(PlayerName.save(raw, to: storage))
    }

    /// A model with in-memory storage and the mock lobby, for tests and for the app before M5.
    public static func demo(storage: StringStore = MemoryStringStore()) -> InterfaceModel {
        InterfaceModel(settings: SettingsStore(storage: storage), lobby: MockLobby(), storage: storage)
    }

    // MARK: Which screen shows

    /// The screen on top, or nil while the game has the keys (playing).
    public var activeScreen: ScreenID? {
        let canOverlay = phase == .menu || (phase == .paused && overlay != .friend && overlay != .credits)
        if let overlay, canOverlay { return ScreenID(rawValue: overlay.rawValue) }
        switch phase {
        case .menu: return .menu
        case .loading: return .loading
        case .paused: return .pause
        case .won, .lost: return .end
        case .playing: return nil
        }
    }

    /// Sheets over the menu sit on the solid canvas; over a paused match they sit on a scrim.
    public var sheetIsSolid: Bool { phase == .menu }

    public func open(_ next: Overlay?) {
        if next == .controls, overlay != .settings { controlsReturn = nil }
        overlay = next
    }

    public func openControlsFromSettings() {
        controlsReturn = .settings
        overlay = .controls
    }

    /// Escape. Never drops a friend connection by accident: Cancel and Leave do that.
    public func back() {
        switch overlay {
        case .controls: overlay = controlsReturn
        case .friend: if lobby.state.step == .idle { overlay = nil }
        case .firstRun:
            pendingMatch = nil
            overlay = nil
        case .settings, .credits: overlay = nil
        case nil: break
        }
    }

    // MARK: Menu

    public func chooseMenu(_ change: (inout MenuChoices) -> Void) {
        var next = menuChoices
        change(&next)
        next.botCount = min(MenuChoices.botRange.upperBound, max(MenuChoices.botRange.lowerBound, next.botCount))
        menuChoices = next
        next.save(storage)
    }

    public func play() {
        guard !menuChoices.mapId.isEmpty else { return }
        let request = MatchRequest(
            mapId: menuChoices.mapId,
            mode: menuChoices.mode == .survival ? .survival : .skirmish,
            difficulty: settings.value.gameplay.difficulty,
            botCount: menuChoices.botCount
        )
        if settings.value.controls.preset == .trackpad, !FirstRun.seen(storage) {
            pendingMatch = request
            overlay = .firstRun
            return
        }
        start(request)
    }

    public func finishFirstRun(useMouse: Bool) {
        if useMouse {
            settings.update { $0.controls = WebData.shared.controlPresets[.mouse]! }
        }
        FirstRun.markSeen(storage)
        let request = pendingMatch
        pendingMatch = nil
        if let request { start(request) } else { overlay = nil }
    }

    private func start(_ request: MatchRequest) {
        overlay = nil
        menuError = ""
        if let commands {
            commands.startMatch(request)
            return
        }
        let map = maps.first { $0.id == request.mapId }
        showLoading(
            map: map ?? MapInfo(id: request.mapId, name: request.mapId, tagline: ""),
            detail: "\(Format.modeName(request.mode)) · \(LobbyText.difficultyName(request.difficulty)) · \(request.botCount) enemies"
        )
    }

    // MARK: Driven by the game (or the demo flow)

    public func showLoading(map: MapInfo, detail: String) {
        let preset = settings.value.controls.preset
        loading = LoadingInfo(mapName: map.name, tagline: map.tagline, detail: detail, label: "", progress: 0,
                              tips: WebData.shared.controlTips[preset] ?? [])
        enter(.loading)
    }

    public func updateLoading(progress: Double, label: String) {
        loading.progress = min(1, max(0, progress))
        loading.label = label
    }

    public func showPlaying() { enter(.playing) }

    public func showPause(detail: String, live: Bool) {
        pause = PauseInfo(detail: detail, note: "", live: live)
        enter(.paused)
    }

    public func showEnd(_ result: MatchResult) {
        self.result = result
        enter(result.won ? .won : .lost)
    }

    public func showMenu() { enter(.menu) }

    private func enter(_ next: MatchPhase) {
        if next != .menu && next != .paused { overlay = nil }
        phase = next
    }

    // MARK: Pause and end actions

    public func resume() {
        if let commands { commands.resume() } else { enter(.playing) }
    }

    public func restart() {
        overlay = nil
        if let commands { commands.restart() } else if let result {
            showLoading(map: maps.first { $0.name == result.mapName } ?? maps[0], detail: result.modeLine)
        } else {
            enter(.loading)
        }
    }

    /// Quit to menu, or leave the match with a friend (which also drops the connection).
    public func leaveMatch() {
        if lobby.state.step != .idle { lobby.leave() }
        quitToMenu()
    }

    public func quitToMenu() {
        if let commands { commands.quitToMenu() } else { enter(.menu) }
    }

    /// End screen, primary button: play again alone, or back to the lobby together.
    public func endPrimary() {
        if result?.together == true {
            quitToMenu()
            overlay = .friend
        } else {
            restart()
        }
    }

    /// End screen, second button: menu, or leave the friend.
    public func endSecondary() {
        if result?.together == true { leaveMatch() } else { quitToMenu() }
    }

    // MARK: Invite links

    /// A pasted `?join=` link or an `ironvale://join?code=` URL: open the lobby on the invite.
    public func openInvite(_ code: String) {
        invitedCode = code
        if phase == .menu { overlay = .friend }
    }

    public func declineInvite() { invitedCode = "" }

    /// macOS opened `ironvale://join?code=` (or a web invite link): show the invite. False when the URL is not one.
    @discardableResult
    public func openInviteURL(_ url: URL) -> Bool {
        guard let code = InviteLink.code(from: url) else { return false }
        openInvite(code)
        return true
    }

    /// Text pasted outside a field: an invite link opens the invite. False when it holds none.
    @discardableResult
    public func pasteInvite(_ text: String) -> Bool {
        guard let code = InviteLink.code(fromText: text) else { return false }
        openInvite(code)
        return true
    }

    public func acceptInvite() {
        let code = invitedCode
        invitedCode = ""
        lobby.join(.room, code: code)
    }
}
