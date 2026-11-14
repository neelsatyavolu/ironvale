// M9 view-model gate, part 1: the native rig reproduces the web's rig poses. The fixtures
// (native/Contract/fixtures/viewmodel-poses.json, native/Tools/viewmodel-export) ran the web's ViewRig,
// GunView, PartsAnimator and first-person arms IK on every gun-export model and the real arms model
// for idle, ADS, fire, reload, sprint and a move/jump/switch/wall scenario. Each frame's inputs, the
// weapon machine's state and its events are replayed here; at the sampled frames the holder pose, the
// depth scale, every animated part, the hand targets, the muzzle and ejection port and every arm bone's
// local transform must match within 1e-4.
import Foundation
import IronvaleContract
@testable import IronvaleViewModel
import Testing

private let tolerance = 1e-4

struct RigFixtureContext {
    let tables: ViewModelTables
    let fixtures: [String: Any]
    let baked: URL
    let manifest: ViewModelManifest
    let gunsMeta: URL

    static func load() throws -> RigFixtureContext {
        let contract = try Contract.load()
        let repo = contract.directory.deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: contract.directory.appending(path: "fixtures/viewmodel-poses.json"))
        let fixtures = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let baked = ViewModelAssets.bakedDirectory(repositoryRoot: repo)
        return RigFixtureContext(tables: try ViewModelTables.load(contractDirectory: contract.directory), fixtures: fixtures,
                                 baked: baked, manifest: try ViewModelAssets.manifest(baked),
                                 gunsMeta: repo.appending(path: "native/MapPackages/guns"))
    }
}

private func doubles(_ value: Any?) -> [Double] { (value as? [Any])?.compactMap { ($0 as? NSNumber)?.doubleValue } ?? [] }

private func action(_ value: Any?) -> ViewAction? {
    guard let a = value as? [String: Any] else { return nil }
    let marks = (a["marks"] as? [[String: Any]] ?? []).map { (stage: $0["stage"] as? String, time: ($0["time"] as! NSNumber).doubleValue) }
    return ViewAction(kind: a["kind"] as! String, duration: (a["duration"] as! NSNumber).doubleValue,
                      handsFrom: (a["handsFrom"] as! NSNumber).doubleValue, handsTo: (a["handsTo"] as! NSNumber).doubleValue, marks: marks)
}

/// Largest absolute difference, comparing quaternions up to sign.
private func difference(_ a: [Double], _ b: [Double], quaternion: Bool = false) -> Double {
    guard a.count == b.count else { return .infinity }
    let direct = zip(a, b).map { abs($0 - $1) }.max() ?? 0
    if !quaternion { return direct }
    return min(direct, zip(a, b).map { abs($0 + $1) }.max() ?? 0)
}

private func vec(_ v: RVec3) -> [Double] { [v.x, v.y, v.z] }
private func quat(_ q: RQuat) -> [Double] { [q.x, q.y, q.z, q.w] }

/// Replays one scenario and returns every mismatch above the tolerance (empty when it matches).
func replay(weapon: String, scenario: String, context: RigFixtureContext) throws -> (mismatches: [String], worst: Double, samples: Int) {
    let tables = context.tables
    let fixture = try #require((context.fixtures[weapon] as? [String: Any])?[scenario] as? [String: Any])
    let armsModel = try ViewModelAssets.model("arms", directory: context.baked, manifest: context.manifest)
    let arms = try FirstPersonArms(scene: armsModel.scene, tables: tables.arms)
    let gunModel = try ViewModelAssets.gun(try ViewModelAssets.model(weapon, directory: context.baked, manifest: context.manifest),
                                            metaDirectory: context.gunsMeta)
    let def = try #require(tables.weapons[weapon])
    let rig = ViewRig(tables: tables, arms: arms)
    let gun = GunView(model: gunModel, def: def, tables: tables)
    rig.show(gun)

    let joints = Set(armsModel.ivm.skins.flatMap(\.joints))
    var bones: [RigNode] = []
    arms.root.traverse { node in
        if let source = node.source, joints.contains(source), armsModel.nodes[source] === node { bones.append(node) }
    }
    let boneNames = fixture["boneNames"] as? [String] ?? []
    var mismatches: [String] = []
    if bones.isEmpty || boneNames.isEmpty { mismatches.append("no arm bones to compare") }
    if bones.map(\.name) != boneNames { mismatches.append("bone order differs: \(bones.map(\.name).prefix(5)) vs \(boneNames.prefix(5))") }
    if let bind = fixture["bindMatrix"] as? [Any], difference(doubles(bind), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) > 0 {
        mismatches.append("the arms' bind matrix is not the identity; ViewModelRenderer assumes it is")
    }

    let inputs = fixture["inputs"] as? [[String: Any]] ?? []
    var samples = (fixture["samples"] as? [[String: Any]] ?? []).makeIterator()
    var nextSample = samples.next()
    let dt = (fixture["dt"] as! NSNumber).doubleValue
    var worst = 0.0
    var compared = 0
    for (index, step) in inputs.enumerated() {
        let n = { (key: String) in (step[key] as! NSNumber).doubleValue }
        for event in step["events"] as? [[String: Any]] ?? [] {
            if let fired = event["fired"] as? [String: Any] {
                rig.fired(aim: (fired["aim"] as! NSNumber).doubleValue, side: (fired["side"] as! NSNumber).doubleValue)
            } else if let stage = event["stage"] as? String {
                rig.stage(stage)
            } else if let landed = event["landed"] as? NSNumber {
                rig.landed(speed: landed.doubleValue)
            }
        }
        rig.fovDegrees = n("fov")
        let wall = n("wall")
        let m = step["machine"] as! [String: Any]
        let machine = MachineView(action: action(m["action"]), actionTime: (m["actionTime"] as! NSNumber).doubleValue,
                                  chambered: m["chambered"] as! Bool, magazine: (m["magazine"] as! NSNumber).intValue)
        let frame = ViewFrame(dt: dt, machine: machine, aim: n("aim"), sprint: n("sprint"), lowered: n("lowered"), speed: n("speed"),
                              verticalSpeed: n("verticalSpeed"), onGround: step["onGround"] as! Bool, lookYaw: n("lookYaw"),
                              lookPitch: n("lookPitch"))
        rig.update(frame, wall: { _, _, far in wall > 0 && wall <= far ? wall : nil })

        guard let expected = nextSample, (expected["frame"] as! NSNumber).intValue == index else { continue }
        nextSample = samples.next()
        compared += 1
        func check(_ label: String, _ got: [Double], _ want: Any?, quaternion: Bool = false) {
            let d = difference(got, doubles(want), quaternion: quaternion)
            worst = max(worst, d)
            if d > tolerance { mismatches.append("frame \(index) \(label): \(got) vs \(doubles(want)) (diff \(d))") }
        }
        let holder = expected["holder"] as! [String: Any]
        check("holder.position", vec(rig.holder.position), holder["position"])
        check("holder.quaternion", quat(rig.holder.quaternion), holder["quaternion"], quaternion: true)
        check("root.scale.z", [rig.root.scale.z], [expected["rootScaleZ"]!])
        for key in ["tilt", "work", "seat", "supportAway", "triggerAway", "magazineOut"] {
            let got: Double = switch key {
            case "tilt": gun.parts.tilt
            case "work": gun.parts.work
            case "seat": gun.parts.seat
            case "supportAway": gun.parts.supportAway
            case "triggerAway": gun.parts.triggerAway
            default: gun.parts.magazineOut
            }
            check(key, [got], [expected[key]!])
        }
        for (name, value) in expected["parts"] as? [String: Any] ?? [:] {
            guard let part = gunModel.parts[name], let want = value as? [String: Any] else {
                mismatches.append("frame \(index): part \(name) is missing")
                continue
            }
            check("part \(name).position", vec(part.position), want["position"])
            check("part \(name).quaternion", quat(part.quaternion), want["quaternion"], quaternion: true)
            if part.visible != (want["visible"] as? Bool) { mismatches.append("frame \(index): part \(name) visibility") }
        }
        for (label, node) in [("triggerTarget", gun.triggerTarget), ("supportTarget", gun.supportTarget)] {
            let want = expected[label] as! [String: Any]
            check("\(label).position", vec(node.position), want["position"])
            check("\(label).quaternion", quat(node.quaternion), want["quaternion"], quaternion: true)
        }
        check("muzzle", vec(rig.muzzleWorld), expected["muzzle"])
        let ejection = expected["ejection"] as! [String: Any]
        check("ejection.position", vec(rig.ejectionWorld.position), ejection["position"])
        check("ejection.direction", vec(rig.ejectionWorld.direction), ejection["direction"])
        let wantBones = expected["bones"] as? [[Any]] ?? []
        if wantBones.count != bones.count { mismatches.append("frame \(index): \(bones.count) bones vs \(wantBones.count)") }
        for (bone, want) in zip(bones, wantBones) {
            let values = doubles(want)
            check("bone \(bone.name).position", vec(bone.position), Array(values[0..<3]))
            check("bone \(bone.name).quaternion", quat(bone.quaternion), Array(values[3..<7]), quaternion: true)
        }
    }
    if nextSample != nil { mismatches.append("not every sample frame was reached") }
    return (mismatches, worst, compared)
}

@Suite struct RigPoseFixtureTests {
    /// Guards against a vacuous replay: a rig with a 1 degree wider view-model lens must not match.
    @Test func perturbedRigFails() throws {
        let context = try RigFixtureContext.load()
        let url = try Contract.load().directory.appending(path: "viewmodel.json")
        var json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var rig = try #require(json["rig"] as? [String: Any])
        rig["VIEW_MODEL_FOV"] = 55
        json["rig"] = rig
        let bumped = try JSONDecoder().decode(ViewModelTables.self, from: JSONSerialization.data(withJSONObject: json))
        let result = try replay(weapon: "m4a1", scenario: "idle",
                                context: RigFixtureContext(tables: bumped, fixtures: context.fixtures, baked: context.baked,
                                                           manifest: context.manifest, gunsMeta: context.gunsMeta))
        #expect(!result.mismatches.isEmpty)
    }

    static let weapons = ["m4a1", "mp5", "m24", "m249", "m7", "scarh"]
    static let scenarios = ["idle", "ads", "fire", "reload", "sprint", "move"]

    @Test(arguments: weapons)
    func rigMatchesTheWeb(weapon: String) throws {
        let context = try RigFixtureContext.load()
        for scenario in Self.scenarios {
            let result = try replay(weapon: weapon, scenario: scenario, context: context)
            #expect(result.samples > 0, "\(weapon) \(scenario): no samples compared")
            #expect(result.mismatches.isEmpty, "\(weapon) \(scenario): worst \(result.worst)\n\(result.mismatches.prefix(8).joined(separator: "\n"))")
            print("viewmodel rig \(weapon) \(scenario): \(result.samples) samples, worst difference \(result.worst)")
        }
    }

    @Test func everyWeaponHasTables() throws {
        let context = try RigFixtureContext.load()
        #expect(Set(context.tables.weapons.keys) == Set(Self.weapons))
        #expect(Set(context.fixtures.keys) == Set(Self.weapons))
    }
}
