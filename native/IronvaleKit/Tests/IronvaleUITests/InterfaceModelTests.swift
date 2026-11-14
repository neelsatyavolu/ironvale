import Foundation
import Testing
@testable import IronvaleUI

@MainActor
@Suite struct InterfaceFlow {
    @Test func menuOpensEverySheetAndEscapeComesBack() {
        let model = InterfaceModel.demo()
        #expect(model.activeScreen == .menu)
        for overlay in [Overlay.settings, .controls, .credits, .friend] {
            model.open(overlay)
            #expect(model.activeScreen == ScreenID(rawValue: overlay.rawValue))
            model.back()
            #expect(model.activeScreen == .menu)
        }
    }

    @Test func controlsFromSettingsReturnsToSettings() {
        let model = InterfaceModel.demo()
        model.open(.settings)
        model.openControlsFromSettings()
        #expect(model.activeScreen == .controls)
        model.back()
        #expect(model.activeScreen == .settings)
        model.back()
        #expect(model.activeScreen == .menu)
    }

    @Test func firstRunShowsOnceForTrackpadPlayers() {
        let storage = MemoryStringStore()
        let model = InterfaceModel.demo(storage: storage)
        model.play()
        #expect(model.activeScreen == .firstRun)
        model.finishFirstRun(useMouse: false)
        #expect(model.activeScreen == .loading)
        #expect(storage.values["ironvale.firstRun.v1"] == #"{"seen":true}"#)
        model.showMenu()
        model.play()
        #expect(model.activeScreen == .loading)
    }

    @Test func firstRunMouseChoiceSwitchesPresetAndEscapeCancels() {
        let storage = MemoryStringStore()
        let model = InterfaceModel.demo(storage: storage)
        model.play()
        model.back()
        #expect(model.activeScreen == .menu)
        model.play()
        model.finishFirstRun(useMouse: true)
        #expect(model.settings.value.controls == WebData.shared.controlPresets[.mouse])
        #expect(Settings.parse(storage.values[Settings.storageKey]).controls.preset == .mouse)
    }

    @Test func mousePlayersSkipTheFirstRunCard() {
        let model = InterfaceModel.demo()
        model.settings.update { $0.controls = WebData.shared.controlPresets[.mouse]! }
        model.play()
        #expect(model.activeScreen == .loading)
        #expect(model.loading.mapName == "Railyard")
        #expect(model.loading.detail == "Skirmish · Regular · 8 enemies")
        #expect(model.loading.tips == WebData.shared.controlTips[.mouse])
    }

    @Test func phasesPickTheScreen() {
        let model = InterfaceModel.demo()
        model.showPlaying()
        #expect(model.activeScreen == nil)
        model.showPause(detail: "Railyard · Skirmish · 1:02", live: false)
        #expect(model.activeScreen == .pause)
        model.open(.settings)
        #expect(model.activeScreen == .settings)
        #expect(!model.sheetIsSolid)
        model.back()
        // Friend and credits are menu-only; over a pause they do not show.
        model.open(.credits)
        #expect(model.activeScreen == .pause)
        model.open(nil)
        model.resume()
        #expect(model.activeScreen == nil)
        let result = MatchResult(won: true, mode: .skirmish, mapName: "Railyard", kills: 8, deaths: 1, elapsed: 125, wave: 1, accuracy: 41)
        model.showEnd(result)
        #expect(model.activeScreen == .end)
        model.endSecondary()
        #expect(model.activeScreen == .menu)
    }

    @Test func endWithAConnectedFriendGoesBackToTheLobby() {
        let model = InterfaceModel.demo()
        let lobby = model.lobby as! MockLobby
        lobby.host(.room)
        lobby.simulateConnected()
        model.showEnd(MatchResult(won: false, mode: .duel, mapName: "Harbor", kills: 4, deaths: 5, elapsed: 300, wave: 1, accuracy: nil,
                                  friend: .init(name: "Sam", kills: 5, killTarget: 5, connected: true)))
        #expect(model.result?.headline == "Sam won the duel")
        model.endPrimary()
        #expect(model.activeScreen == .friend)
        #expect(lobby.state.step == .connected)
    }

    @Test func escapeKeepsAFriendConnection() {
        let model = InterfaceModel.demo()
        model.open(.friend)
        model.lobby.host(.room)
        model.back()
        #expect(model.activeScreen == .friend)
        model.lobby.leave()
        model.back()
        #expect(model.activeScreen == .menu)
    }

    @Test func inviteLinkOpensTheInvitedView() {
        let model = InterfaceModel.demo()
        model.openInvite("K7M3QX")
        #expect(model.activeScreen == .friend)
        #expect(FriendViewKind.of(model.lobby.state, invited: model.invitedCode) == .invited)
        model.acceptInvite()
        #expect(model.lobby.state.role == .guest)
        #expect(FriendViewKind.of(model.lobby.state, invited: model.invitedCode) == .link)
    }

    @Test func everyScreenHasAKeyboardStart() {
        let model = InterfaceModel.demo()
        for screen in ScreenID.allCases where screen != .loading && screen != .end {
            #expect(RootView.defaultFocus(screen, model: model) != nil, "\(screen)")
        }
        model.showEnd(MatchResult(won: false, mode: .duel, mapName: "Harbor", kills: 1, deaths: 3, elapsed: 60, wave: 1, accuracy: nil,
                                  friend: .init(name: "Sam", kills: 3, killTarget: 3, connected: false)))
        // A duel cannot be replayed alone, so Menu is the only button.
        #expect(RootView.defaultFocus(.end, model: model) == "end.menu")
    }
}

@MainActor
@Suite struct Storage {
    @Test func menuChoicesPersistUnderTheWebKey() {
        let storage = MemoryStringStore()
        let model = InterfaceModel.demo(storage: storage)
        model.chooseMenu { $0.mapId = "harbor"; $0.mode = .survival; $0.botCount = 40 }
        #expect(storage.values["ironvale.menu.v1"] == #"{"mapId":"harbor","mode":"survival","botCount":16}"#)
        let again = InterfaceModel.demo(storage: storage)
        #expect(again.menuChoices == MenuChoices(mapId: "harbor", mode: .survival, botCount: 16))
    }

    @Test func badMenuChoicesFallBack() {
        let storage = MemoryStringStore(["ironvale.menu.v1": #"{"mapId":"moon","mode":7,"botCount":4.5}"#])
        let model = InterfaceModel.demo(storage: storage)
        #expect(model.menuChoices == MenuChoices(mapId: "railyard", mode: .skirmish, botCount: 5))
    }

    @Test func settingsSaveTheWebJSON() {
        let storage = MemoryStringStore()
        let store = SettingsStore(storage: storage)
        store.update { $0.audio.master = 0.25 }
        let saved = storage.values[Settings.storageKey]
        #expect(saved?.contains(#""audio":{"master":0.25,"effects":1,"ambience":0.8,"interface":0.7,"hrtf":true}"#) == true)
        #expect(SettingsStore(storage: storage).value.audio.master == 0.25)
    }

    @Test func firstRunPicksATierFromTheGpuOnce() {
        let storage = MemoryStringStore()
        let store = SettingsStore(storage: storage, gpuName: { "Apple M1" })
        #expect(store.value.graphics.tier == .medium)
        let later = SettingsStore(storage: storage, gpuName: { "Intel Iris" })
        #expect(later.value.graphics.tier == .medium)
    }
}

@MainActor
@Suite struct LobbyLogic {
    @Test func hostFlowThroughTheMock() {
        let lobby = MockLobby()
        lobby.host(.room)
        #expect(lobby.state.step == .waiting)
        #expect(LobbyText.inviteLink(lobby.state.code) == "https://ironvale.n3el.dev/?join=K7M3QX")
        #expect(LobbyText.linkText(lobby.state).hasPrefix("Send this link"))
        lobby.simulateConnected(peerName: "Sam")
        lobby.setConfig { $0.mode = .duel; $0.killTarget = 99 }
        #expect(lobby.state.config.killTarget == 30)
        lobby.start()
        #expect(!lobby.state.inMatch)
        lobby.simulatePeerReady(true)
        lobby.start()
        #expect(lobby.state.inMatch)
    }

    @Test func guestCannotChangeTheSetup() {
        let lobby = MockLobby()
        lobby.join(.room, code: "K7M3QX")
        lobby.setConfig { $0.mode = .duel }
        #expect(lobby.state.config.mode == .coop)
        lobby.simulateConnected()
        lobby.setReady(true)
        #expect(lobby.state.localReady)
    }

    @Test func everyErrorHasPlainWords() {
        var state = LobbyState(config: NetMatchConfig(mapId: "harbor"))
        state.peerName = "Sam"
        for error in NetErrorCode.allCases {
            let text = LobbyText.errorText(error, state: state, wasHost: true)
            #expect(text.hasSuffix("."), "\(error)")
        }
        #expect(LobbyText.errorText(.peerLeft, state: state, wasHost: false).hasPrefix("Sam disconnected"))
        #expect(LobbyText.errorText(.wrongCodeKind, state: state, wasHost: false).contains("reply code"))
    }

    @Test func mockNamesAreCleaned() {
        #expect(LobbyText.mockSanitizeName("  Ana <script>  ") == "Ana script")
        #expect(LobbyText.mockSanitizeName("") == "Player")
        #expect(LobbyText.mockSanitizeName(String(repeating: "x", count: 30)).count == 16)
    }
}
