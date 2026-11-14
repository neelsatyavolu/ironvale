// The M7b logic gate: the Swift bot rules, aim and gun timing, pathfinding and cover choice replay
// native/Contract/nav/ai.json, written by native/Tools/nav-fixtures/ai.test.ts from the web's src/ai.
// Integers, statuses and node ids are exact; float64 maths within 1e-9; path points are Float32 on
// both sides and compared exactly.
import Foundation
import IronvaleAI
import IronvaleContract
import IronvaleCore
import IronvaleMapData
import IronvaleSim
import IronvaleWorld
import Testing

private typealias JSON = [String: Any]

nonisolated(unsafe) private let fixture: JSON = {
    let data = try! Data(contentsOf: navFixturesRoot.appending(path: "ai.json"))
    return try! JSONSerialization.jsonObject(with: data) as! JSON
}()

private func d(_ any: Any?) -> Double { (any as! NSNumber).doubleValue }
private func i(_ any: Any?) -> Int { (any as! NSNumber).intValue }
private func b(_ any: Any?) -> Bool { (any as! NSNumber).boolValue }
private func v3(_ any: Any?) -> Vec3 { let a = (any as! [Any]).map(d); return Vec3(a[0], a[1], a[2]) }
private func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) <= 1e-9 * max(1, abs(b)) }

private var pure: JSON { fixture["pure"] as! JSON }
private var traces: JSON { fixture["traces"] as! JSON }
private let data = SimData.shared

@Test func rolesAndNamesMatchTheWeb() {
    for (count, roles) in (pure["roles"] as! [[String]]).enumerated() {
        #expect(assignRoles(count).map(\.rawValue) == roles, "assignRoles(\(count))")
    }
    for (index, name) in (pure["names"] as! [String]).enumerated() {
        #expect(botName(index) == name, "botName(\(index))")
    }
}

@Test func spawnOrderMatchesTheWeb() {
    for (n, c) in (pure["spawnCases"] as! [JSON]).enumerated() {
        let spawns = (c["spawns"] as! [Any]).map(v3)
        let seen = (c["seen"] as! [Any]).map(b)
        let order = orderSpawns(spawns, player: v3(c["player"])) { seen[$0] }
        #expect(order.indices == (c["indices"] as! [Any]).map(i), "case \(n) order")
        #expect(order.hidden == i(c["hidden"]), "case \(n) hidden")
        let picks = assignSpawns(i(c["count"]), order, capacity: i(c["capacity"]))
        #expect(picks == (c["picks"] as! [Any]).map(i), "case \(n) picks")
    }
    for c in pure["viewCone"] as! [JSON] {
        #expect(inViewCone(player: v3(c["player"]), yaw: d(c["yaw"]), point: v3(c["point"]), halfAngle: d(c["half"])) == b(c["inView"]))
    }
}

@Test func perceptionMatchesTheWeb() {
    for c in pure["visionRange"] as! [JSON] {
        let got = effectiveVisionRange(d(c["base"]), fogDensity: d(c["fog"]), targetCrouching: b(c["crouching"]), targetSpeed: d(c["speed"]))
        #expect(close(got, d(c["range"])), "\(c)")
    }
    for c in pure["visionCone"] as! [JSON] {
        let e = v3(c["eye"]), t = v3(c["target"])
        let got = inVisionCone(eye: (e.x, e.y, e.z), yaw: d(c["yaw"]), target: (t.x, t.y, t.z), halfAngle: d(c["half"]), range: d(c["range"]))
        #expect(got == b(c["inView"]), "\(c)")
    }
    for c in pure["hearing"] as! [JSON] {
        let kind = NoiseKind(rawValue: c["kind"] as! String)!
        #expect(close(hearingRadius(kind, loudness: d(c["loudness"]), scale: d(c["scale"])), d(c["radius"])), "\(c)")
    }
    for c in pure["aimError"] as! [JSON] { #expect(close(aimErrorDegrees(d(c["metres"])), d(c["degrees"]))) }
}

@Test func marksmanAndDifficultyScalingMatchTheWeb() {
    for c in pure["marksman"] as! [JSON] {
        let def = data.def(c["weapon"] as! String)!
        if c["kind"] as! String == "ready" {
            #expect(readyToFire(def, sightedTime: d(c["sighted"]), reactionTime: d(c["reaction"])) == b(c["ready"]), "\(c)")
        } else {
            let got = botShotSpread(def, aimSpread: d(c["aim"]), distance: d(c["distance"]), minRange: d(c["minRange"]))
            #expect(close(got, d(c["spread"])), "\(c)")
        }
    }
    for c in pure["scaled"] as! [JSON] {
        let profile = data.contract.ai.difficulty[c["difficulty"] as! String]!
        let def = scaledWeapon(data.def(c["weapon"] as! String)!, multiplier: profile.damageMultiplier)
        #expect(close(def.damage, d(c["damage"])), "\(c)")
    }
}

@Test func aimModelTracesMatchTheWeb() {
    for trace in traces["aim"] as! [JSON] {
        let difficulty = trace["difficulty"] as! String
        var model = AimModel(profile: data.contract.ai.difficulty[difficulty]!)
        for (n, s) in (trace["steps"] as! [JSON]).enumerated() {
            if b(s["reset"]) { model.reset() }
            if d(s["disturb"]) > 0 { model.disturb(d(s["disturb"])) }
            model.update(d(s["dt"]), tracking: b(s["tracking"]))
            let got = model.spread(targetAngularSpeed: d(s["angular"]), moving: b(s["moving"]))
            #expect(close(got, d(s["spread"])), "\(difficulty) step \(n)")
            if !close(got, d(s["spread"])) { break }
        }
    }
}

@Test func botWeaponTracesMatchTheWeb() {
    for trace in traces["weapons"] as! [JSON] {
        let role = data.contract.ai.roles[trace["role"] as! String]!
        let difficulty = trace["difficulty"] as! String
        let def = scaledWeapon(data.def(role.weapon)!, multiplier: data.contract.ai.difficulty[difficulty]!.damageMultiplier)
        let seed = UInt32(i(trace["seed"]))
        var gunRandom = SeededRandom(seed: seed)
        var script = SeededRandom(seed: seed ^ 0x5BD1_E995)
        var weapon = BotWeapon(def: def, timing: BurstTiming(burstMin: role.burstMin, burstMax: role.burstMax, pauseMin: role.pauseMin,
                                                             pauseMax: role.pauseMax), random: { gunRandom.next() })
        var mismatch: String?
        for (n, step) in (trace["steps"] as! [[Any]]).enumerated() {
            let dt = 1.0 / 120 + script.next() * (1.0 / 30)
            let trigger = script.next() < 0.8
            if script.next() < 0.004 { weapon.startReload() }
            let fired = weapon.update(dt, trigger: trigger)
            let got = [fired ? 1 : 0, weapon.magazine, weapon.reloading ? 1 : 0, weapon.reloadStarted ? 1 : 0, weapon.reloadFinished ? 1 : 0]
            let want = step[2...].map(i)
            if !close(dt, d(step[0])) || got != want {
                mismatch = "step \(n): got \(got), want \(want)"
                break
            }
        }
        #expect(mismatch == nil, "\(trace["role"]!) \(difficulty): \(mismatch ?? "")")
    }
}

private func navGrid(_ mapId: String) throws -> NavGrid {
    let package = try MapPackage.load(directory: packagesRoot.appending(path: mapId))
    let seeds = (package.meta.spawns.enemy + package.meta.spawns.player).map(\.point)
    return NavGridBuilder.build(world: package.world, bounds: package.meta.bounds.box, seeds: seeds)
}

private func mapFixture(_ mapId: String) -> JSON {
    (fixture["maps"] as! [JSON]).first { $0["map"] as! String == mapId }!
}

@Test(arguments: ["range", "railyard", "headworks", "harbor"])
func pathsMatchTheWeb(_ mapId: String) throws {
    let grid = try navGrid(mapId)
    let cases = mapFixture(mapId)["paths"] as! [JSON]
    let queue = PathQueue(grid: grid)
    let handles = cases.map { _ in PathHandle() }
    for (c, handle) in zip(cases, handles) {
        let s = v3(c["start"]), g = v3(c["goal"])
        let avoid = (c["avoid"] as? JSON).map { PathAvoid(x: d($0["x"]), z: d($0["z"]), radius: d($0["radius"]), cost: d($0["cost"])) }
        queue.request(handle, start: (s.x, s.y, s.z), goal: (g.x, g.y, g.z), avoid: avoid)
    }
    var doneAt = handles.map { _ in -1 }
    var frame = 0
    while frame < 5000, doneAt.contains(-1) {
        queue.update(350)
        for (n, h) in handles.enumerated() where doneAt[n] == -1 && (h.status == .ready || h.status == .failed) { doneAt[n] = frame }
        frame += 1
    }
    for (n, (c, h)) in zip(cases, handles).enumerated() {
        let status = h.status == .ready ? "ready" : h.status == .failed ? "failed" : "\(h.status)"
        #expect(status == c["status"] as! String, "path \(n) status")
        #expect(doneAt[n] == i(c["doneAt"]), "path \(n) finished on frame \(doneAt[n]), web \(i(c["doneAt"]))")
        #expect(h.count == i(c["count"]) && h.partial == b(c["partial"]), "path \(n) count/partial")
        let points = (c["points"] as! [Any]).map { Float(d($0)) }
        #expect(Array(h.points.prefix(h.count * 3)) == points, "path \(n) points")
    }
}

@Test(arguments: ["range", "railyard", "headworks", "harbor"])
func coverMatchesTheWeb(_ mapId: String) throws {
    let grid = try navGrid(mapId)
    let map = mapFixture(mapId)
    for (n, c) in (map["cover"] as! [JSON]).enumerated() {
        let q = c["query"] as! JSON
        var query = CoverQuery()
        query.x = d(q["x"]); query.y = d(q["y"]); query.z = d(q["z"])
        query.threatX = d(q["threatX"]); query.threatZ = d(q["threatZ"])
        query.radius = d(q["radius"])
        query.minThreatDistance = q["minThreatDistance"].map(d)
        query.idealThreatDistance = q["idealThreatDistance"].map(d)
        query.exclude = q["exclude"].map(i)
        query.taken = (q["taken"] as? [Any])?.map(i)
        query.skip = (q["skip"] as? [Any])?.map(i)
        let found = findCover(grid, query)
        #expect(found == i(c["found"]), "cover \(n)")
        if found >= 0 {
            query.skip = (query.skip ?? []) + [found]
            #expect(findCover(grid, query) == i(c["again"]), "cover \(n) second pick")
        }
    }
    for row in map["against"] as! [[Any]] {
        #expect(coverAgainst(grid, i(row[0]), d(row[1]), d(row[2])) == i(row[3]), "coverAgainst node \(i(row[0]))")
    }
}
