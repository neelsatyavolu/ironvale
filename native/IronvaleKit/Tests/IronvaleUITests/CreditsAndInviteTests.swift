// M10: the credits model against tests/ui/credits-model.test.ts's cases and CREDITS.md, the player-name
// and first-run keys (PLAN.md 3.12), and both invite paths (ironvale://join and a pasted ?join= link).
import Foundation
import IronvaleNet
import IronvaleWire
import Testing
@testable import IronvaleUI

@Suite struct CreditsPort {
    static func asset(_ value: JSValue) -> CreditsModel.Asset {
        CreditsModel.Asset(id: value["id"]!.text!, kind: value["kind"]!.text!, license: value["license"]!.text!, source: value["source"]!.text!,
                           credit: value["credit"]?.text)
    }

    @Test(arguments: HUDFixtures.list("credits").indices)
    func casesMatchTheWeb(_ index: Int) {
        let item = HUDFixtures.list("credits")[index]
        let groups = CreditsModel.build(HUDFixtures.list("input", in: item).map(Self.asset))
        let expected = HUDFixtures.list("groups", in: item)
        #expect(groups.count == expected.count)
        for (got, want) in zip(groups, expected) {
            #expect(got.id == want["id"]!.text! && got.title == want["title"]!.text! && Double(got.count) == want["count"]!.double!)
            let lines = HUDFixtures.list("credited", in: want)
            #expect(got.credited == lines.map { CreditsModel.Line(text: $0["text"]!.text!, url: $0["url"]!.text!, count: Int($0["count"]!.double!)) },
                    "\(got.id)")
            let thanks = HUDFixtures.list("thanks", in: want)
            #expect(got.thanks == thanks.map {
                CreditThanks(name: $0["name"]!.text!, url: $0["url"]!.text!, licence: $0["licence"]!.text!, note: $0["note"]!.text!)
            }, "\(got.id)")
        }
        #expect(CreditsModel.markdown(groups) == item["markdown"]!.text!)
    }

    @Test func shippedManifestGivesCreditsMarkdown() throws {
        let markdown = CreditsModel.markdown(CreditsModel.build(CreditsModel.manifest))
        #expect(markdown == HUDFixtures.root["creditsMarkdown"]!.text!)
        let file = HUDFixtures.native.deletingLastPathComponent().appending(path: "CREDITS.md")
        #expect(markdown == (try String(contentsOf: file, encoding: .utf8)))
    }

    @Test func screenListsTheNativeLibrariesAndEveryGroup() {
        let groups = CreditsModel.screenGroups
        #expect(groups.map(\.id) == ["models", "sounds", "textures", "fonts", "libraries"])
        #expect(groups.last?.thanks == CreditsModel.nativeLibraries)
        #expect(groups.allSatisfy { !$0.credited.isEmpty || !$0.thanks.isEmpty })
        #expect(groups[0].credited.allSatisfy { $0.sentence.hasSuffix(".") })
    }
}

@MainActor
@Suite struct StorageKeys {
    @Test(arguments: HUDFixtures.list("names").indices)
    func playerNameRoundTripsLikeTheWeb(_ index: Int) {
        let item = HUDFixtures.list("names")[index]
        let store = MemoryStringStore()
        let saved = PlayerName.save(item["raw"]?.text, to: store)
        #expect(store.string(forKey: "ironvale.net.v1") == item["stored"]!.text!)
        #expect(saved == item["read"]!.text!)
        #expect(PlayerName.read(store) == item["read"]!.text!)
    }

    @Test func nameFallsBackForMissingOrOddValues() {
        for raw in [nil, "", "null", "42", "[1]", "{\"name\":7}", "not json"] {
            let store = MemoryStringStore(raw.map { ["ironvale.net.v1": $0] } ?? [:])
            #expect(PlayerName.read(store) == "Player", "\(raw ?? "nil")")
        }
    }

    @Test func theInterfaceRestoresAndKeepsTheName() {
        let store = MemoryStringStore(["ironvale.net.v1": "{\"name\":\"Ada\"}"])
        let model = InterfaceModel(settings: SettingsStore(storage: store), lobby: MockLobby(), storage: store)
        #expect(model.lobby.state.localName == "Ada")
        model.setPlayerName("  Grace   Hopper!! ")
        #expect(model.lobby.state.localName == "Grace Hopper")
        #expect(store.string(forKey: "ironvale.net.v1") == "{\"name\":\"Grace Hopper\"}")
        let again = InterfaceModel(settings: SettingsStore(storage: store), lobby: MockLobby(), storage: store)
        #expect(again.lobby.state.localName == "Grace Hopper")
    }

    @Test func allThreeKeysAreTheWebKeys() {
        #expect(Settings.storageKey == "ironvale.settings.v1")
        #expect(PlayerName.storageKey == "ironvale.net.v1")
        #expect(FirstRun.storageKey == "ironvale.firstRun.v1")
        let store = MemoryStringStore()
        FirstRun.markSeen(store)
        #expect(store.string(forKey: "ironvale.firstRun.v1") == "{\"seen\":true}")
        #expect(FirstRun.seen(store))
        #expect(!FirstRun.seen(MemoryStringStore(["ironvale.firstRun.v1": "{\"seen\":\"yes\"}"])))
    }
}

/// Records what the friend screen asks of the lobby, on top of the mock.
@MainActor
final class RecordingLobby: LobbyController {
    let mock = MockLobby()
    var joins: [(NetMethod, String)] = []
    var state: LobbyState { mock.state }
    func roomCodesAvailable() async -> Bool { true }
    func setName(_ name: String) { mock.setName(name) }
    func host(_ method: NetMethod) { mock.host(method) }
    func join(_ method: NetMethod, code: String) {
        joins.append((method, code))
        mock.join(method, code: code)
    }
    func acceptReply(_ reply: String) { mock.acceptReply(reply) }
    func setConfig(_ change: (inout IronvaleUI.NetMatchConfig) -> Void) { mock.setConfig(change) }
    func setReady(_ ready: Bool) { mock.setReady(ready) }
    func start() { mock.start() }
    func leave() { mock.leave() }
}

@MainActor
@Suite struct InviteLinks {
    let relay = RelayClient(url: "wss://ironvale-signal.n3el.dev")!

    @Test func urlSchemeAndWebLinksGiveTheCode() {
        let cases: [(String, String?)] = [
            ("ironvale://join?code=K7M3QX", "K7M3QX"),
            ("ironvale://join?code=k7m3qx", "K7M3QX"),
            ("ironvale://join/K7M3QX", "K7M3QX"),
            ("ironvale://join?join=K7M3QX", "K7M3QX"),
            ("https://ironvale.n3el.dev/?join=K7M3QX", "K7M3QX"),
            ("https://ironvale.n3el.dev/play?x=1&join=K7M3QX#top", "K7M3QX"),
            ("ironvale://join?code=K7M3Q", nil),
            ("ironvale://host?code=K7M3QX", nil),
            ("https://ironvale.n3el.dev/", nil),
            ("ironvale://join?code=IL0O1Q", nil),
        ]
        for (text, code) in cases {
            #expect(InviteLink.code(from: URL(string: text)!) == code, "\(text)")
        }
        #expect(InviteLink.appURL(code: "K7M3QX")?.absoluteString == "ironvale://join?code=K7M3QX")
        #expect(InviteLink.code(fromText: "join me: https://ironvale.n3el.dev/?join=K7M3QX ") == "K7M3QX")
        #expect(InviteLink.code(fromText: "K7M3QX") == nil)
    }

    /// Both paths end in a room join whose signaling URL is the relay's /room/CODE?role=guest.
    @Test func bothPathsJoinTheRoom() throws {
        for open in [
            { (m: InterfaceModel) in m.openInviteURL(URL(string: "ironvale://join?code=K7M3QX")!) },
            { (m: InterfaceModel) in m.pasteInvite("https://ironvale.n3el.dev/?join=K7M3QX") },
        ] {
            let lobby = RecordingLobby()
            let model = InterfaceModel(settings: SettingsStore(storage: nil), lobby: lobby, storage: nil)
            #expect(open(model))
            #expect(model.activeScreen == .friend)
            #expect(FriendViewKind.of(lobby.state, invited: model.invitedCode) == .invited)
            model.acceptInvite()
            let join = try #require(lobby.joins.last)
            #expect(join.0 == .room)
            let url = relay.roomURL(code: RoomCode.from(join.1), role: .guest)
            #expect(url?.absoluteString == "wss://ironvale-signal.n3el.dev/room/K7M3QX?role=guest")
        }
        // A link pasted straight into the friend screen's code field: the session's RoomSignaling reads the code from it.
        #expect(RoomCode.from("https://ironvale.n3el.dev/?join=k7m3qx") == "K7M3QX")
    }

    @Test func notAnInviteLeavesTheMenuAlone() {
        let model = InterfaceModel(settings: SettingsStore(storage: nil), lobby: MockLobby(), storage: nil)
        #expect(!model.pasteInvite("hello"))
        #expect(!model.openInviteURL(URL(string: "https://example.com/?x=1")!))
        #expect(model.activeScreen == .menu)
    }

    @Test func aNativeHostsInviteOpensTheWebLobby() {
        #expect(LobbyText.inviteLink("K7M3QX") == "https://ironvale.n3el.dev/?join=K7M3QX")
        #expect(RoomCode.inviteLink(code: "K7M3QX", page: LobbyText.inviteBase) == "https://ironvale.n3el.dev/?join=K7M3QX")
    }
}
