// DuelRules (ported from src/net/rules.ts at commit cbe0add) against fixtures the web's own
// functions computed (native/Tools/interop/duel-fixtures.test.ts): spawn choice on every map's real
// spawn list, results, and the duel bot's side.
import Foundation
import IronvaleCore
import Testing
@testable import IronvaleNet
import enum IronvaleWire.DuelBot

private let fixtureURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Tools/interop/fixtures/duel-rules.json")

private struct FixtureError: Error { let what: String }

private func fixtures() throws -> JSONValue {
    guard let value = JSONValue.parse(try String(contentsOf: fixtureURL, encoding: .utf8)) else { throw FixtureError(what: "duel-rules.json") }
    return value
}

private func number(_ value: JSONValue?, _ what: String) throws -> Double {
    guard let n = value?.number else { throw FixtureError(what: what) }
    return n
}

private func array(_ value: JSONValue?, _ what: String) throws -> [JSONValue] {
    guard let a = value?.array else { throw FixtureError(what: what) }
    return a
}

private func string(_ value: JSONValue?, _ what: String) throws -> String {
    guard let s = value?.string else { throw FixtureError(what: what) }
    return s
}

private func point(_ value: JSONValue?) throws -> (x: Double, z: Double) {
    let xz = try array(value, "point")
    return (try number(xz[0], "x"), try number(xz[1], "z"))
}

@Test func pickDuelSpawnMatchesWebOnEveryMap() throws {
    let data = try fixtures()
    let maps = try array(data["spawns"], "spawns")
    #expect(maps.count == 4)
    for map in maps {
        let spawns = try array(map["spawns"], "map spawns").map(point)
        let cases = try array(map["cases"], "cases")
        #expect(cases.count > 80)
        for item in cases {
            let opponent = try point(item["opponent"])
            let expected = Int(try number(item["index"], "index"))
            #expect(DuelRules.pickDuelSpawn(spawns, opponent: opponent) == expected, "\(map["map"]?.string ?? "") vs \(opponent)")
        }
    }
    let ties = data["ties"]
    let tieSpawns = try array(ties?["spawns"], "tie spawns").map(point)
    #expect(DuelRules.pickDuelSpawn(tieSpawns, opponent: (0, 0)) == Int(try number(ties?["index"], "tie index")))
    #expect(DuelRules.pickDuelSpawn([], opponent: (0, 0)) == Int(try number(ties?["empty"], "empty index")))
}

@Test func duelResultMatchesWeb() throws {
    let cases = try array(try fixtures()["results"], "results")
    #expect(cases.count == 3 * 12 * 12)
    for item in cases {
        let kills = Int(try number(item["kills"], "kills")), deaths = Int(try number(item["deaths"], "deaths"))
        let target = Int(try number(item["target"], "target"))
        #expect(DuelRules.duelResult(kills: kills, deaths: deaths, killTarget: target)?.rawValue == item["result"]?.string,
                "\(kills)-\(deaths) to \(target)")
    }
}

@Test func duelBotSideMatchesWeb() throws {
    let data = try fixtures()
    for item in try array(data["sides"], "sides") {
        guard let owner = DuelBot(rawValue: try string(item["owner"], "owner")),
              let role = PeerRole(rawValue: try string(item["role"], "role")) else { throw FixtureError(what: "side") }
        let side = DuelRules.duelBotSide(owner: owner, role: role)
        #expect(side.team.rawValue == item["team"]?.string && side.uniform.rawValue == item["uniform"]?.string, "\(owner) on \(role)")
    }
    for item in try array(data["here"], "here") {
        guard let bot = DuelBot(rawValue: try string(item["duelBot"], "duelBot")),
              let role = PeerRole(rawValue: try string(item["role"], "role")) else { throw FixtureError(what: "here") }
        #expect(DuelRules.duelBotsHere(bot, role: role) == Int(try number(item["count"], "count")))
    }
}
