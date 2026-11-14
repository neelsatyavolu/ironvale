// The web's solo skirmish, measured: native/Contract/nav/skirmish.json, written by
// native/Tools/nav-fixtures/skirmish.test.ts, which plays the real src/ai BotManager, Combat and
// ballistics headless (8 veteran bots against a player standing at the first spawn) for 16 matches per
// map. The native skirmish gate holds native runs to the range the web itself shows, instead of a
// number picked by hand: on Headworks the web's own squads have between 2 and 6 of 8 soldiers fire
// before the player's third death (the marksman and gunner hold their spots and rarely get a line).
import Foundation

public struct SkirmishReference: Decodable, Sendable {
    public struct Range: Decodable, Sendable {
        public let min: Double
        public let max: Double
    }

    public struct Map: Decodable, Sendable {
        public let matches: Int
        public let botsThatFired: Range
        public let firstShotSeconds: Range
        public let endSeconds: Range
        public let hitsOnPlayer: Range
        public let rolesFired: [String: Int]

        /// Distinct bots that fired in a web match on this map, lowest to highest seen.
        public var firedRange: ClosedRange<Int> { Int(botsThatFired.min) ... Int(botsThatFired.max) }
    }

    public let bots: Int
    public let difficulty: String
    public let maps: [String: Map]

    public static func load(contractRoot: URL) throws -> SkirmishReference {
        try JSONDecoder().decode(SkirmishReference.self, from: Data(contentsOf: contractRoot.appending(path: "nav/skirmish.json")))
    }

    /// The web's range of bots that fired for `bots` soldiers on `mapId`, or nil when the reference has no such match.
    public func firedRange(mapId: String, bots count: Int) -> ClosedRange<Int>? {
        count == bots ? maps[mapId]?.firedRange : nil
    }
}
