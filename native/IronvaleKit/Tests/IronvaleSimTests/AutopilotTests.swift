// The M4 exit scenario headless: native/ci/m4-autopilot.json played into the offline Game on Range,
// Railyard and Headworks. The app runs the same script with --autopilot (native/ci/check-m4.sh).
import Foundation
import IronvaleMapData
@testable import IronvaleSim
import Testing

let autopilotScript = simData.contract.directory.deletingLastPathComponent().appending(path: "ci/m4-autopilot.json")

@Test(arguments: ["range", "railyard", "headworks"])
func autopilotPlaysTheExitScenario(_ mapId: String) throws {
    let script = try AutopilotScript.load(autopilotScript)
    let package = try MapPackage.load(directory: packagesRoot.appending(path: mapId))
    let settings = PlayerSettings.defaults(script.preset ?? "mouse")
    let input = BoundInput(settings: settings)
    let game = Game(input: input, settings: settings, random: SeededRandomSource(seed: 7))
    let log = try EventLog(path: nil)
    let runner = AutopilotRunner(script: script, game: game, input: input, log: log)
    game.start(map: package, config: MatchConfig(mapId: mapId, mode: .skirmish, difficulty: script.difficulty ?? "veteran", botCount: 0))
    var frames = 0
    while !runner.finished, frames < 120 * 120 {
        runner.frame(1.0 / 120)
        frames += 1
    }
    let weapons = simData.contract.weapons.weaponIds
    let missing = AutopilotRunner.missing(in: log.lines, weapons: weapons)
    #expect(runner.finished)
    #expect(missing.isEmpty, "\(mapId): missing \(missing)\n\(log.lines.filter { !$0.contains("bulletTrace") && !$0.contains("casing") && !$0.contains("bulletImpact") }.joined(separator: "\n"))")
    #expect(game.phase == .playing)
    #expect(game.deaths == 1)
    #expect(game.player.alive)
}
