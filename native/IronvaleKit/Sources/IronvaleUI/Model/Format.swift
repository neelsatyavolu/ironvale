// Ported from src/ui/format.ts and the wording in src/ui/screens/end.ts, menu.ts and src/ui/index.ts at cbe0add.
import Foundation

public enum MatchMode: String, Sendable { case skirmish, survival, coop, duel }

public enum Format {
    /// Seconds as `m:ss`.
    public static func clock(_ seconds: Double) -> String {
        let total = seconds.isFinite && seconds > 0 ? Int(seconds.rounded(.down)) : 0
        return "\(total / 60):" + String(format: "%02d", total % 60)
    }

    /// Share of projectiles that hit, as a whole percentage. Nil before the first shot.
    public static func accuracyPercent(hits: Int, projectiles: Int) -> Int? {
        guard projectiles > 0 else { return nil }
        return min(100, Int((Double(hits) / Double(projectiles) * 100 + 0.5).rounded(.down)))
    }

    public static func modeName(_ mode: MatchMode) -> String {
        switch mode {
        case .skirmish: "Skirmish"
        case .survival: "Survival"
        case .coop: "Co-op"
        case .duel: "Duel"
        }
    }
}

/// What the end screen shows (src/ui/screens/end.ts `MatchResult`).
public struct MatchResult: Equatable, Sendable {
    public struct Friend: Equatable, Sendable {
        public var name: String
        public var kills: Int
        public var killTarget: Int
        public var connected: Bool
        public init(name: String, kills: Int, killTarget: Int, connected: Bool) {
            self.name = name
            self.kills = kills
            self.killTarget = killTarget
            self.connected = connected
        }
    }

    public var won: Bool
    public var mode: MatchMode
    public var mapName: String
    public var kills: Int
    public var deaths: Int
    public var elapsed: Double
    public var wave: Int
    public var accuracy: Int?
    public var rules: NetRules?
    public var friend: Friend?

    public init(won: Bool, mode: MatchMode, mapName: String, kills: Int, deaths: Int, elapsed: Double, wave: Int,
                accuracy: Int?, rules: NetRules? = nil, friend: Friend? = nil) {
        self.won = won
        self.mode = mode
        self.mapName = mapName
        self.kills = kills
        self.deaths = deaths
        self.elapsed = elapsed
        self.wave = wave
        self.accuracy = accuracy
        self.rules = rules
        self.friend = friend
    }

    private var survival: Bool { (mode == .coop ? rules?.rawValue : mode.rawValue) == "survival" }

    public var headline: String {
        if mode == .duel {
            let name = friend?.name ?? "Your friend"
            guard friend?.connected == true else { return "\(name) disconnected" }
            return won ? "You won the duel" : "\(name) won the duel"
        }
        if won { return "\(mapName) is clear" }
        if survival {
            return wave > 1 ? "You held for \(wave - 1) \(wave == 2 ? "wave" : "waves")" : "You fell in the first wave"
        }
        return "Out of lives"
    }

    public var modeLine: String {
        if mode == .duel { return "Duel · first to \(friend?.killTarget ?? 10)" }
        let rulesName = survival ? "Survival" : "Skirmish"
        return mode == .coop ? "Co-op · \(rulesName)" : rulesName
    }

    /// Back to the lobby together rather than playing again alone.
    public var together: Bool { friend?.connected == true }
}

/// Menu wording (src/ui/screens/menu.ts).
public enum MenuText {
    public static func lives(_ mode: MenuChoices.Mode) -> String { mode == .skirmish ? "Three lives" : "Two lives" }

    public static func modeNote(_ mode: MenuChoices.Mode) -> String {
        mode == .skirmish
            ? "Clear every enemy on the map before you run out of lives."
            : "Waves keep coming and each is larger than the last. See how long you hold."
    }

    public static func difficultyNote(_ difficulty: Difficulty) -> String {
        switch difficulty {
        case .recruit: "Slow to notice you and wide of the mark. Good for a first game."
        case .regular: "A fair fight. They aim steadily and use cover."
        case .veteran: "Quick to react and accurate at range."
        case .elite: "They notice you in a quarter of a second. Stay out of the open."
        }
    }

    /// Enemies added per wave in Survival (src/game/game.ts).
    public static let waveGrowth = 2

    public static func countNote(_ mode: MenuChoices.Mode) -> String {
        mode == .survival ? "The first wave. Each wave after it adds \(waveGrowth) more." : "How many you have to clear to win."
    }
}
