// The scripted scenes of native/Contract/fx/scenes.json replayed through the Swift port: after every
// step, every buffer the web's modules wrote for the GPU (both particle pools, rings, tracers, decal
// and muzzle-flash instances, casings, flash lights, weather state, roof mask), the effect clock and
// the number of random draws must equal the TypeScript's.
import Foundation
import IronvaleContract
@testable import IronvaleFX
import IronvaleSim
import IronvaleWorld
import Testing

nonisolated(unsafe) private let scenesJSON = try! fixture("scenes.json") as! [String: Any]
nonisolated(unsafe) private let sceneList = scenesJSON["scenes"] as! [[String: Any]]
private let sceneNames = sceneList.map { ($0["scene"] as! [String: Any])["name"] as! String }

/// Full state by key, rebuilt from the fixture's per-frame diffs.
private struct Expected {
    var rows: [String: [Int: [Double]]] = [:]
    var values: [String: Any] = [:]

    mutating func apply(_ frame: [String: Any]) {
        for (key, value) in frame {
            if let list = value as? [Any], let first = list.first as? [Any], first.count > 1, key != "lights", key != "landed", key != "shake" {
                for row in list {
                    let r = doubles(row)
                    let slot = Int(r[0])
                    let rest = Array(r.dropFirst())
                    if rest.allSatisfy({ $0 == 0 }) { rows[key, default: [:]][slot] = nil } else { rows[key, default: [:]][slot] = rest }
                }
                if rows[key] == nil { rows[key] = [:] }
            } else {
                values[key] = value
            }
        }
    }
}

private func nativeRows(_ store: FloatStore, _ stride: Int, _ count: Int) -> [Int: [Double]] {
    var out: [Int: [Double]] = [:]
    for slot in 0..<count {
        let row = (0..<stride).map { Double(store[slot * stride + $0]) }
        if row.contains(where: { $0 != 0 }) { out[slot] = row }
    }
    return out
}

private func compareRows(_ key: String, _ expected: [Int: [Double]], _ actual: [Int: [Double]], _ where_: String) -> [String] {
    var problems: [String] = []
    for slot in Set(expected.keys).union(actual.keys).sorted() {
        let e = expected[slot] ?? [], a = actual[slot] ?? []
        let width = max(e.count, a.count)
        let ee = e.isEmpty ? [Double](repeating: 0, count: width) : e
        let aa = a.isEmpty ? [Double](repeating: 0, count: width) : a
        if zip(ee, aa).contains(where: { !close($0, $1) }) {
            problems.append("\(where_) \(key)[\(slot)]: web \(ee) native \(aa)")
            if problems.count > 3 { break }
        }
    }
    return problems
}

private func weapon(_ json: Any?) -> FXWeapon {
    let w = json as? [String: Any] ?? [:]
    let def = contract.weapons.def(w["id"] as? String ?? "m4a1")!
    return FXWeapon(weaponClass: WeaponClass(rawValue: (w["weaponClass"] as? String) ?? def.weaponClass)!,
                    pellets: Int((w["pellets"] as? Double) ?? def.pellets),
                    muzzleVelocity: (w["muzzleVelocity"] as? Double) ?? def.muzzleVelocity)
}

private func emit(_ e: [String: Any], into fx: Effects) {
    let local = e["local"] as? Bool ?? false
    switch e["type"] as! String {
    case "shotFired": fx.shotFired(weapon: weapon(e["weapon"]), muzzle: d3(e["a"]), direction: d3(e["b"]), local: local)
    case "bulletTrace": fx.bulletTrace(weapon: weapon(e["weapon"]), from: d3(e["a"]), to: d3(e["b"]), local: local)
    case "bulletImpact":
        fx.bulletImpact(weapon: weapon(e["weapon"]), point: d3(e["a"]), normal: d3(e["normal"]),
                        surface: Surface.allCases.first { $0.name == (e["surface"] as? String ?? "concrete") }!)
    case "combatantHit":
        fx.combatantHit(targetId: Int((e["targetId"] as? Double) ?? 3), point: d3(e["a"]), direction: d3(e["b"]), fatal: e["fatal"] as? Bool ?? false)
    case "nearMiss": fx.nearMiss(point: d3(e["a"]))
    case "casingEjected": fx.casingEjected(kind: CasingKind(rawValue: e["kind"] as? String ?? "rifle")!, position: d3(e["a"]), velocity: d3(e["b"]))
    case "grenadeExploded": fx.grenadeExploded(position: d3(e["a"]))
    default: Issue.record("unknown event \(e)")
    }
}

@Test(arguments: sceneNames)
func sceneMatchesTypeScript(_ name: String) throws {
    let entry = sceneList.first { ($0["scene"] as! [String: Any])["name"] as! String == name }!
    let scene = entry["scene"] as! [String: Any]
    let result = entry["result"] as! [String: Any]
    let world = try fixtureWorld(scenesJSON["world"] as! [String: Any])
    let fx = Effects(weapons: Effects.weapons(from: contract.weapons), grenades: GrenadeMath(),
                     particleDensity: double(scene["particleDensity"]), detailDensity: double(scene["detailDensity"]),
                     random: FXRandom(seed: UInt32(double(scene["seed"]))))
    var landed: [[Double]] = []
    fx.onCasingLanded = { kind, p, _ in landed.append([Double(CasingKind.allCases.firstIndex(of: kind)!), p.x, p.y, p.z]) }
    let lighting = scene["lighting"] as! [String: Any]
    let interiors = (scene["interiors"] as! [[String: Any]]).map { FXBox(min: d3($0["min"]), max: d3($0["max"])) }
    var pose = scene["pose"] as! [String: Any]
    func applyPose() {
        fx.env.camera = FXCamera(position: d3(pose["eye"]), yaw: double(pose["yaw"]), pitch: double(pose["pitch"]))
        fx.env.player.yaw = double(pose["yaw"])
    }
    applyPose()
    fx.env.player.position = d3(scene["feet"])
    fx.enterMap(lighting: FXLighting(sunDirection: d3(lighting["sunDirection"]), sunColor: UInt32(double(lighting["sunColor"])),
                                     sunIntensity: double(lighting["sunIntensity"]), skyIntensity: double(lighting["skyIntensity"]),
                                     fogColor: UInt32(double(lighting["fogColor"]))),
                weather: Weather(rawValue: scene["weather"] as! String)!, interiors: interiors, world: world)

    let env = result["env"] as! [String: Any]
    for (key, value) in [("sunLight", fx.env.sunLight), ("ambientLight", fx.env.ambientLight), ("wind", fx.env.wind), ("sunDirection", fx.env.sunDirection)] {
        let e = doubles(env[key])
        #expect(close(e[0], value.x, 1e-12) && close(e[1], value.y, 1e-12) && close(e[2], value.z, 1e-12), "env.\(key): web \(e) native \(value)")
    }

    var expected = Expected()
    let steps = scene["steps"] as! [[String: Any]]
    let frames = result["frames"] as! [[String: Any]]
    var problems: [String] = []
    for (index, step) in steps.enumerated() where problems.isEmpty {
        if let p = step["pose"] as? [String: Any] { pose = p }
        applyPose()
        if let feet = step["feet"] { fx.env.player.position = d3(feet) }
        if let indoors = step["indoors"] as? Bool { fx.env.player.indoors = indoors }
        for e in step["events"] as! [[String: Any]] { emit(e, into: fx) }
        let aim = (step["aim"] as? [String: Any]).map { (origin: d3($0["origin"]), velocity: d3($0["velocity"])) }
        fx.update(double(step["dt"]), aim: aim)
        expected.apply(frames[index])
        let at = "\(name) step \(index)"

        if !close(double(expected.values["now"]), fx.env.now, 1e-12) { problems.append("\(at) now: web \(expected.values["now"]!) native \(fx.env.now)") }
        if Int(double(expected.values["draws"])) != fx.env.random.draws {
            problems.append("\(at) random draws: web \(expected.values["draws"]!) native \(fx.env.random.draws)")
        }
        let buffers: [(String, FloatStore, Int, Int)] = [
            ("lit", fx.lit.data, ParticlePool.stride, Effects.litCapacity),
            ("glow", fx.glow.data, ParticlePool.stride, Effects.glowCapacity),
            ("rings", fx.rings.data, Rings.stride, Rings.capacity),
            ("tracers", fx.tracers.data, Tracers.stride, Tracers.capacity),
            ("decalMatrices", fx.decals.matrices, 16, Decals.capacity),
            ("decalInfo", fx.decals.info, 4, Decals.capacity),
            ("flashMatrices", fx.muzzle.matrices, 16, Muzzle.maxFlashes * Muzzle.quads),
            ("flashInfo", fx.muzzle.info, 2, Muzzle.maxFlashes * Muzzle.quads),
            ("casingMatrices", fx.casings.matrices, 16, Casings.capacity),
            ("casingHull", fx.casings.hull, 1, Casings.capacity),
        ]
        for (key, store, stride, count) in buffers {
            problems += compareRows(key, expected.rows[key] ?? [:], nativeRows(store, stride, count), at)
        }
        for (i, light) in (expected.values["lights"] as! [Any]).enumerated() {
            let e = doubles(light)
            let n = fx.muzzle.lights[i]
            if !close(e[0], n.intensity) || (e[0] > 0 && !(close(e[1], n.position.x) && close(e[2], n.position.y) && close(e[3], n.position.z))) {
                problems.append("\(at) light \(i): web \(e) native \(n.intensity) \(n.position)")
            }
        }
        if !close(double(expected.values["heat"]), fx.muzzle.heat) { problems.append("\(at) heat") }
        let webLanded = (frames[index]["landed"] as? [Any] ?? []).map { item -> [Double] in
            let l = item as! [String: Any]
            return [Double(CasingKind.allCases.firstIndex(of: CasingKind(rawValue: l["kind"] as! String)!)!)] + doubles(l["position"])
        }
        if webLanded.count != landed.count || zip(webLanded, landed).contains(where: { zip($0, $1).contains { !close($0, $1) } }) {
            problems.append("\(at) casingLanded: web \(webLanded) native \(landed)")
        }
        landed.removeAll()
        let shake = doubles(expected.values["shake"])
        let s = fx.grenade.shakeOffset
        if !(close(shake[0], s.x, 1e-9) && close(shake[1], s.y, 1e-9) && close(shake[2], s.z, 1e-9) && close(shake[3], -s.drop, 1e-9)) {
            problems.append("\(at) shake: web \(shake) native \(s)")
        }
        let w = fx.weather.state
        let rain = expected.values["rain"] as! [String: Any], banks = expected.values["banks"] as! [String: Any], motes = expected.values["motes"] as! [String: Any]
        func same(_ a: Any?, _ b: D3) -> Bool { let v = doubles(a); return close(v[0], b.x, 1e-9) && close(v[1], b.y, 1e-9) && close(v[2], b.z, 1e-9) }
        if (rain["visible"] as! Bool) != w.rainVisible || (w.rainVisible && (Int(double(rain["count"])) != w.rainCount || !same(rain["centre"], w.rainCentre)
            || !same(rain["fall"], w.rainFall) || !close(double(rain["indoors"]), w.rainIndoors, 1e-9))) {
            problems.append("\(at) rain: web \(rain) native \(w)")
        }
        if (banks["visible"] as! Bool) != w.banksVisible || (w.banksVisible && (Int(double(banks["count"])) != w.banksCount
            || !same(banks["centre"], w.banksCentre) || !close(double(banks["indoors"]), w.banksIndoors, 1e-9))) {
            problems.append("\(at) banks: web \(banks) native \(w)")
        }
        if (motes["visible"] as! Bool) != w.motesVisible || (w.motesVisible && (Int(double(motes["count"])) != w.motesCount || !same(motes["centre"], w.motesCentre))) {
            problems.append("\(at) motes: web \(motes) native \(w)")
        }
        if let arc = expected.values["arc"] as? [String: Any] {
            let a = fx.grenade.arc
            let positions = doubles(arc["positions"])
            let marker = doubles(arc["marker"])
            let native = (0..<positions.count).map { Double(a.positions[$0]) }
            // Hidden, only visibility counts (the web parks the pieces under the level to compile them).
            let shown = arc["markerVisible"] as! Bool
            if (arc["ribbonVisible"] as! Bool) != a.ribbonVisible || shown != a.markerVisible
                || (shown && (Int(double(arc["count"])) != a.count || Int(double(arc["drawCount"])) != a.drawCount
                    || zip(positions, native).contains(where: { !close($0, $1) })
                    || !(close(marker[0], a.marker.x) && close(marker[1], a.marker.y) && close(marker[2], a.marker.z) && close(marker[3], a.markerScale)))) {
                problems.append("\(at) grenade arc: web count \(arc["count"]!) visible \(arc["ribbonVisible"]!) draw \(arc["drawCount"]!) marker \(marker); native \(a.count) \(a.ribbonVisible) \(a.drawCount) \(a.marker) \(a.markerScale)")
            }
        }
        let mask = doubles(expected.values["mask"])
        if mask.count != fx.weather.mask.heights.count || zip(mask, fx.weather.mask.heights).contains(where: { !close($0, Double($1), 1e-6) }) {
            problems.append("\(at) roof mask differs")
        }
    }
    #expect(problems.isEmpty, "\(problems.prefix(6).joined(separator: "\n"))")
}
