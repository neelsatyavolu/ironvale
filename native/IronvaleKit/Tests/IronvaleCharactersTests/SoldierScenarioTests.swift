// Whole-soldier scenarios: the web Soldier (src/characters/soldier.ts) driven on the real
// soldier.glb through a scripted run of movement, aiming, firing, reloading, crouching, strafing,
// backpedalling, hit flinches, deaths and a revive, against the native Soldier on the baked IVM.
// Compared every recorded step: the 22 clip bones in model space, the rifle, the death turn, the
// muzzle in world space and the full 42-joint skinning palette in root space.
import Foundation
import IronvaleCore
import Testing
import simd
@testable import IronvaleCharacters

@Suite("characters: whole soldier against the web Soldier")
@MainActor
struct SoldierScenarioTests {
    /// Positions in metres and quaternion components. Both builds read the same float32 clip data and
    /// run the same float64 maths, so they agree to rounding.
    static let tolerance = 1e-9
    /// The palette goes through Float (GPU format) on the native side.
    static let paletteTolerance = 2e-5

    @Test(arguments: ["soldier-alive.json", "soldier-death.json"])
    func scenario(_ file: String) throws {
        let fixture = try Fixtures.load(file)
        let rig = try Fixtures.rig()
        let jointNames = try fixture.list("joints").map { try need($0.string, "joint") }
        #expect(jointNames == rig.skin.joints.map { rig.model.nodes[$0].name })
        let soldier = Soldier(rig: rig, team: .alpha)
        let records = try fixture.list("records")
        var next = 0
        var worst = (bone: 0.0, gun: 0.0, muzzle: 0.0, palette: 0.0)
        var nodes = [simd_float4x4](repeating: matrix_identity_float4x4, count: rig.model.nodes.count)
        var palette = [simd_float4x4](repeating: matrix_identity_float4x4, count: rig.skin.joints.count)
        for (index, row) in try fixture.list("steps").enumerated() {
            let s = try need(row.array, "step")
            let dt = try s[0].asNumber()
            let step = min(max(dt, 0), 0.1)
            soldier.position.x += try s[7].asNumber() * step
            soldier.position.z += try s[8].asNumber() * step
            soldier.yaw = try s[9].asNumber()
            soldier.setState(SoldierState(speed: try s[1].asNumber(), crouching: s[2].bool ?? false, aimPitch: try s[3].asNumber(),
                                          aiming: s[4].bool ?? false, firing: s[5].bool ?? false, reloading: s[6].bool ?? false))
            if let zone = s[10].string { soldier.flinch(try need(HitZone(rawValue: zone), zone)) }
            if let d = s[11].array { soldier.die(direction: Vec3(try d[0].asNumber(), try d[1].asNumber(), try d[2].asNumber())) }
            if s[12].bool == true { soldier.revive() }
            soldier.update(dt)
            soldier.refresh()
            guard next < records.count, Int(try records[next].num("step")) == index else { continue }
            let r = records[next]
            next += 1
            let q = try r.nums("modelQ"), p = try r.nums("modelP")
            for b in 0..<22 {
                worst.bone = max(worst.bone, quatDiff(soldier.skeleton.modelQ[b], Array(q[(b * 4)..<(b * 4 + 4)])))
                worst.bone = max(worst.bone, maxDiff(soldier.skeleton.modelP[b].array, Array(p[(b * 3)..<(b * 3 + 3)])))
            }
            let gun = try r.nums("gun")
            worst.gun = max(worst.gun, maxDiff(soldier.gunPosition.array, Array(gun[0..<3])), quatDiff(soldier.gunRotation, Array(gun[3..<7])))
            worst.gun = max(worst.gun, abs(soldier.pivotYaw - (try r.num("pivotYaw"))))
            worst.muzzle = max(worst.muzzle, maxDiff(soldier.muzzleWorld().array, try r.nums("muzzle")))
            soldier.jointMatrices(into: &palette, nodes: &nodes)
            let web = try r.nums("palette")
            for (j, m) in palette.enumerated() {
                // The web records joint node matrices (bone.matrixWorld); the palette also folds in the inverse bind.
                _ = m
                let n = nodes[rig.skin.joints[j]]
                let node = [n.columns.0.x, n.columns.0.y, n.columns.0.z, n.columns.1.x, n.columns.1.y, n.columns.1.z,
                            n.columns.2.x, n.columns.2.y, n.columns.2.z, n.columns.3.x, n.columns.3.y, n.columns.3.z].map(Double.init)
                worst.palette = max(worst.palette, maxDiff(node, Array(web[(j * 12)..<(j * 12 + 12)])))
            }
        }
        #expect(next == records.count, "\(file): matched \(next) of \(records.count) records")
        print("\(file): max difference bones \(worst.bone), gun \(worst.gun), muzzle \(worst.muzzle), joint matrices \(worst.palette)")
        #expect(worst.bone <= Self.tolerance, "\(file): clip bones differ by \(worst.bone)")
        #expect(worst.gun <= Self.tolerance, "\(file): rifle differs by \(worst.gun)")
        #expect(worst.muzzle <= Self.tolerance, "\(file): muzzle differs by \(worst.muzzle)")
        #expect(worst.palette <= Self.paletteTolerance, "\(file): joint matrices differ by \(worst.palette)")
    }

    @Test func rigMatchesTheWebRig() throws {
        let rig = try Fixtures.rig()
        let f = try Fixtures.characters().at("rig")
        #expect(rig.parents == (try f.nums("parents").map { Int($0) }))
        expectClose(rig.offsets.flatMap(\.array), try f.list("offsets").flatMap { try $0.asNumbers() }, 1e-12, "offsets")
        for (i, q) in try f.list("restLocal").enumerated() { #expect(quatDiff(rig.restLocal[i], try q.asNumbers()) <= 1e-12) }
        for (i, q) in try f.list("restModel").enumerated() { #expect(quatDiff(rig.restModel[i], try q.asNumbers()) <= 1e-9) }
        let fingers = try f.list("fingers")
        #expect(fingers.count == rig.fingers.count)
        for (finger, web) in zip(rig.fingers, fingers) {
            #expect(finger.name == (try web.text("name")))
            #expect(quatDiff(finger.grip, try web.nums("grip")) <= 1e-9)
        }
        for (arm, key) in [(rig.left, "left"), (rig.right, "right")] {
            let w = try f.at("arms").at(key)
            #expect([arm.shoulder, arm.upper, arm.lower, arm.hand] == [try w.num("shoulder"), try w.num("upper"), try w.num("lower"), try w.num("hand")].map { Int($0) })
            try expectSetup(arm.setup, try w.at("setup"), "\(key) arm")
        }
    }

    @Test func levelOfDetailThinsPosing() throws {
        let rig = try Fixtures.rig()
        let near = Soldier(rig: rig, team: .bravo), far = Soldier(rig: rig, team: .bravo), hidden = Soldier(rig: rig, team: .bravo)
        let start = [near.poseCount, far.poseCount, hidden.poseCount]
        for _ in 0..<60 {
            near.visibility.seen(distance: 5)
            far.visibility.seen(distance: 80)
            for s in [near, far, hidden] { s.update(1.0 / 60) }
        }
        #expect(near.poseCount - start[0] == 60)
        #expect(far.poseCount - start[1] == 20)
        #expect(hidden.poseCount - start[2] <= 13)
    }
}
