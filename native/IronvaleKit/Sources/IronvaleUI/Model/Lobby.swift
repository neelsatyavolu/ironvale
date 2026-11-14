// Ported from src/net/api.ts (LobbyState and its enums), src/net/protocol.ts (NetMatchConfig) and the
// lobby wording in src/ui/screens/friend.ts at cbe0add. The real session arrives with IronvaleNet (M5);
// until then the screens run against `MockLobby`.
import Foundation
import Observation

public enum NetRole: String, Sendable { case host, guest }
public enum NetMethod: String, Sendable { case room, manual }
public enum LobbyStep: String, Sendable { case idle, opening, waiting, reply, connecting, connected }
public enum NetMode: String, Sendable, CaseIterable { case coop, duel }
public enum NetRules: String, Sendable, CaseIterable { case skirmish, survival }
public enum DuelBot: String, Sendable, CaseIterable { case none, host, guest }

public enum NetErrorCode: String, Sendable, CaseIterable {
    case signalUnreachable = "signal-unreachable"
    case noRoom = "no-room"
    case roomFull = "room-full"
    case roomExpired = "room-expired"
    case rateLimited = "rate-limited"
    case badCode = "bad-code"
    case wrongCodeKind = "wrong-code-kind"
    case codeTooLong = "code-too-long"
    case connectFailed = "connect-failed"
    case version
    case unknownMap = "unknown-map"
    case loadFailed = "load-failed"
    case peerLeft = "peer-left"
    case peerTimeout = "peer-timeout"
}

public struct NetMatchConfig: Equatable, Sendable {
    public var mapId: String
    public var mode: NetMode
    public var rules: NetRules
    public var difficulty: Difficulty
    public var botCount: Int
    public var killTarget: Int
    public var duelBot: DuelBot

    public init(mapId: String, mode: NetMode = .coop, rules: NetRules = .skirmish, difficulty: Difficulty = .regular,
                botCount: Int = 8, killTarget: Int = 10, duelBot: DuelBot = .none) {
        self.mapId = mapId
        self.mode = mode
        self.rules = rules
        self.difficulty = difficulty
        self.botCount = botCount
        self.killTarget = killTarget
        self.duelBot = duelBot
    }

    public static let botRange = 4...16
    public static let killRange = 3...30
}

public struct LobbyState: Equatable, Sendable {
    public var step: LobbyStep = .idle
    public var role: NetRole?
    public var method: NetMethod?
    /// The code to pass to the friend: a room code, an invite or a reply. Empty until there is one.
    public var code = ""
    public var error: NetErrorCode?
    public var localName = "Player"
    public var peerName = ""
    public var localReady = false
    public var peerReady = false
    public var config: NetMatchConfig
    /// Round trip in milliseconds, or -1 when not known.
    public var rttMs = -1
    public var inMatch = false

    public init(config: NetMatchConfig) { self.config = config }
}

/// What the lobby screen asks of the network session. IronvaleNet's session will conform to this at M5.
@MainActor
public protocol LobbyController: AnyObject, Observable {
    var state: LobbyState { get }
    func roomCodesAvailable() async -> Bool
    func setName(_ name: String)
    func host(_ method: NetMethod)
    func join(_ method: NetMethod, code: String)
    func acceptReply(_ reply: String)
    func setConfig(_ change: (inout NetMatchConfig) -> Void)
    func setReady(_ ready: Bool)
    func start()
    func leave()
}

public enum LobbyText {
    public static let nameLength = 16
    /// Base of a native host's invite link: the web lobby, so a friend can open it in a browser (PLAN.md M10).
    public static let inviteBase = "https://ironvale.n3el.dev/"

    public static func inviteLink(_ code: String) -> String {
        var parts = URLComponents(string: inviteBase)!
        parts.queryItems = [URLQueryItem(name: "join", value: code)]
        return parts.string ?? inviteBase
    }

    /// The mock lobby's stand-in for `sanitizeName` (src/net/limits.ts). The real one belongs to IronvaleWire
    /// and replaces this when the session lands; the screen only shows whatever name the session reports.
    public static func mockSanitizeName(_ raw: String) -> String {
        let kept = raw.unicodeScalars.filter { CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) || " _.'-".unicodeScalars.contains($0) || CharacterSet.whitespaces.contains($0) }
        let collapsed = String(String.UnicodeScalarView(kept)).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let cut = String(collapsed.prefix(nameLength)).trimmingCharacters(in: .whitespaces)
        return cut.isEmpty ? "Player" : cut
    }

    public static func modeNote(_ mode: NetMode) -> String {
        switch mode {
        case .coop: "The two of you against the enemy. The enemies run on the host's machine."
        case .duel: "One against one, or with a bot on one side. Each kill is a point and you come back as far from your opponent as the map allows."
        }
    }

    public static let duelBotNote = "A bot fights for one of you and its kills count for its side. Killing it scores nothing; it comes back after a few seconds."

    public static func rulesNote(_ rules: NetRules) -> String {
        switch rules {
        case .skirmish: "Three lives each. Clear every enemy to win."
        case .survival: "One life each per wave. Whoever falls comes back when the next wave starts."
        }
    }

    /// What went wrong and what to do next, in plain words.
    public static func errorText(_ error: NetErrorCode, state: LobbyState, wasHost: Bool) -> String {
        switch error {
        case .signalUnreachable: "Could not reach the room service. Check your connection and try again, or use copy-and-paste codes instead."
        case .noRoom: "No game is waiting under that code. Check it with your friend, or ask them to host again."
        case .roomFull: "That game already has two players. Ask your friend to host again and send the new code."
        case .roomExpired: "That code has expired. Host again to get a new one."
        case .rateLimited: "Too many attempts. Wait a minute, then try again."
        case .badCode: "That is not a complete code. Copy the whole code and paste it again."
        case .wrongCodeKind:
            wasHost
                ? "That is an invite, not a reply. Paste the reply your friend sent back."
                : "That is a reply code. Paste the invite the host sent you."
        case .codeTooLong: "That text is too long to be a code. Copy only the code and paste it again."
        case .connectFailed: "Could not connect to your friend. One of your networks may block direct connections. Try again, or try from another network."
        case .version: "You and your friend have different versions of the game. Both of you update or reload the game, then try again."
        case .unknownMap: "The host chose a map this copy of the game does not have. Both of you update or reload the game, then try again."
        case .loadFailed: "The map could not be loaded. Check your connection, then host or join again."
        case .peerLeft: "\(state.peerName) disconnected. Host or join again to play another match."
        case .peerTimeout: "The connection to \(state.peerName) was lost. Host or join again to play another match."
        }
    }

    /// The status line while codes go back and forth.
    public static func linkText(_ state: LobbyState) -> String {
        let manual = state.method == .manual
        switch state.step {
        case .opening:
            if state.role == .host { return manual ? "Preparing your invite. This takes a few seconds." : "Opening a room" }
            return manual ? "Reading the invite and preparing your reply" : "Looking for the game"
        case .waiting:
            return manual
                ? "Send the invite to your friend, then paste the reply they send back."
                : "Send this link to your friend. They open it, pick a name and join. It works for ten minutes."
        case .reply:
            return "Send this reply to the host. The game connects when they paste it."
        default:
            return "Connecting to your friend"
        }
    }

    public static func difficultyName(_ difficulty: Difficulty) -> String {
        difficulty.rawValue.prefix(1).uppercased() + difficulty.rawValue.dropFirst()
    }
}

/// Which part of the friend screen shows, from the lobby step and whether an invite link opened it.
public enum FriendViewKind: Equatable, Sendable {
    case invited, idle, link, lobby

    public static func of(_ state: LobbyState, invited: String) -> FriendViewKind {
        switch state.step {
        case .idle: invited.isEmpty ? .idle : .invited
        case .connected: .lobby
        default: .link
        }
    }
}
