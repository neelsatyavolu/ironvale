// The web's tests/characters cases (pose, locomotion, death, reactions, lod, ik, gun-hold), run as
// input -> output fixtures generated from src/characters at commit f14381f.
import Foundation
import IronvaleCore
import Testing
@testable import IronvaleCharacters

@Suite("characters: pure modules against TS fixtures")
struct PureModuleTests {
    let tables = CharacterTables.shared

    @Test func constantsMatchTheExtractedTables() throws {
        #expect(tables.clipBones.count == 22)
        #expect(tables.teamTint["alpha"]?.color == 0x8f7d5e)
        #expect(tables.teamTint["bravo"]?.color == 0x4f5a34)
        #expect(tables.clipMeta.count == 9)
    }

    @Test func syntheticClipSampling() throws {
        let f = try Fixtures.characters().at("pose").at("synthetic")
        for c in try f.list("cases") {
            let loop = try c.flag("loop")
            let rotations = try f.nums("rotations").map(Float.init)
            let hips = try f.nums("hips").map(Float.init)
            let clip = ClipData(bones: 2, frames: hips.count / 3, fps: try f.num("fps"), loop: loop, rotations: rotations, hips: hips)
            expectClose(clip.duration, try c.num("duration"), 1e-12, "duration")
            var pose = Pose(bones: 2)
            sampleClip(clip, try c.num("time"), &pose)
            expectClose(pose.rotations.map(Double.init), try c.nums("rotations"), 0, "rotations loop=\(loop) t=\(try c.num("time"))")
            expectClose(pose.hips.map(Double.init), try c.nums("hips"), 0, "hips")
        }
    }

    @Test func realClipSamplingBlendAndSteer() throws {
        let rig = try Fixtures.rig()
        let f = try Fixtures.characters().at("pose")
        for c in try f.list("sampled") {
            var pose = Pose(bones: 22)
            let name = try c.text("clip")
            sampleClip(try need(rig.clips[name], name), try c.num("time"), &pose)
            expectClose(pose.rotations.map(Double.init), try c.nums("rotations"), 0, "\(name) at \(try c.num("time"))")
            expectClose(pose.hips.map(Double.init), try c.nums("hips"), 0, "\(name) hips")
        }
        for c in try f.list("blends") {
            var out = Pose(bones: 22), other = Pose(bones: 22)
            sampleClip(rig.clips[try c.text("a")]!, try c.num("timeA"), &out)
            sampleClip(rig.clips[try c.text("b")]!, try c.num("timeB"), &other)
            blendPose(&out, other, try c.num("weight"))
            expectClose(out.rotations.map(Double.init), try c.nums("rotations"), 0, "blend")
            expectClose(out.hips.map(Double.init), try c.nums("hips"), 0, "blend hips")
        }
        for c in try f.list("steer") {
            var pose = Pose(bones: 2)
            let a = [0, sin(0.5), 0, cos(0.5)], b = [0, sin(-1.25), 0, cos(-1.25)]
            pose.rotations = (a + b).map(Float.init)
            steerBone(&pose, 1, Quat(0.1, -0.2, 0.3, -0.9), try c.num("weight"))
            expectClose(pose.rotations.map(Double.init), try c.nums("rotations"), 0, "steer")
        }
    }

    @Test func locomotion() throws {
        let f = try Fixtures.characters().at("locomotion")
        let names = try f.list("clips").map { try need($0.string, "clip") }
        #expect(names == GaitClip.allCases.map(\.name))
        for c in try f.list("weights") {
            let w = Locomotion.gaitWeights(speed: try c.num("speed"), crouch: try c.num("crouch"))
            expectClose(w.values, try c.nums("weights"), 1e-15, "weights at \(try c.num("speed"))")
            expectClose(Locomotion.cycleLength(w), try c.at("cycle").asNumber(), 1e-12, "cycle")
        }
        for c in try f.list("phases") {
            let w = Locomotion.gaitWeights(speed: try c.num("speed"), crouch: try c.num("crouch"))
            let out = Locomotion.advancePhase(try c.num("phase"), speed: try c.num("speed"), weights: w, dt: try c.num("dt"), reverse: try c.flag("reverse"))
            expectClose(out, try c.num("out"), 1e-15, "phase")
        }
        for c in try f.list("clipTimes") {
            let clip = try need(GaitClip.allCases.first { $0.name == (c["clip"]?.string ?? "") }, "clip")
            expectClose(Locomotion.clipTime(clip, phase: try c.num("phase")), try c.num("time"), 1e-15, "clip time")
        }
        for c in try f.list("headings") {
            let h = Locomotion.resolveHeading(try c.num("angle"), wasReverse: try c.flag("wasReverse"))
            #expect(h.reverse == (try c.flag("reverse")))
            expectClose(h.hipYaw, try c.num("hipYaw"), 1e-15, "hip yaw at \(try c.num("angle"))")
        }
    }

    @Test func death() throws {
        let f = try Fixtures.characters().at("death")
        for c in try f.list("plans") {
            let plan = Death.plan(x: try c.num("x"), z: try c.num("z"))
            #expect(plan.variant.rawValue == (try c.text("variant")))
            expectClose(plan.turn, try c.num("turn"), 1e-15, "turn")
        }
        for c in try f.list("frames") {
            let v = try need(DeathVariant(rawValue: try c.text("variant")), "variant")
            let out = Death.frame(v, elapsed: try c.num("elapsed"))
            expectClose([out.clipTime, out.blend, out.ikWeight, out.turn],
                        [try c.num("clipTime"), try c.num("blend"), try c.num("ikWeight"), try c.num("turn")], 1e-15, "death frame")
            #expect(out.settled == (try c.flag("settled")))
        }
    }

    @Test func reactions() throws {
        let f = try Fixtures.characters().at("reactions")
        for c in try f.list("envelope") {
            expectClose(Flinch.envelope(try c.num("time")), try c.num("value"), 1e-15, "envelope")
        }
        for c in try f.list("flinches") {
            let zone = try need(HitZone(rawValue: try c.text("zone")), "zone")
            let hits = try c.nums("hits").map { Int($0) }
            var flinch = Flinch()
            for (i, step) in try c.list("steps").enumerated() {
                if hits.contains(i) { flinch.hit(zone) }
                flinch.update(i % 9 == 0 ? 1.0 / 30 : 1.0 / 60)
                let values = try (0..<7).map { try step.index($0).asNumber() }
                expectClose([flinch.headPitch, flinch.headYaw, flinch.torsoPitch, flinch.torsoYaw, flinch.hipsPitch, flinch.hipsRoll, flinch.gunDip],
                            values, 1e-15, "\(zone) flinch step \(i)")
                #expect(flinch.active == (try step.index(7).bool))
            }
        }
        var recoil = Recoil()
        for c in try f.list("recoil") {
            recoil.update(try c.num("dt"), firing: try c.flag("firing"))
            expectClose([recoil.value, recoil.side], [try c.num("value"), try c.num("side")], 1e-15, "recoil")
        }
    }

    @Test func levelOfDetail() throws {
        let f = try Fixtures.characters().at("lod")
        for c in try f.list("intervals") {
            #expect(PoseLOD.interval(visible: try c.flag("visible"), distance: try c.num("distance")) == Int(try c.num("interval")))
        }
        for c in try f.list("should") {
            let v = try need(c.array, "row")
            #expect(PoseLOD.shouldPose(frame: Int(try v[0].asNumber()), slot: Int(try v[1].asNumber()), interval: Int(try v[2].asNumber())) == v[3].bool)
        }
        var tracker = VisibilityTracker()
        for (i, row) in try f.list("visibility").enumerated() {
            if i == 2 || i == 9 { tracker.seen(distance: Double(10 + i)) }
            tracker.tick()
            #expect(tracker.visible == (try row.index(0).bool))
            #expect(tracker.distance == (try row.index(1).asNumber()))
        }
    }

    @Test func armIK() throws {
        let f = try Fixtures.characters().at("ik")
        for c in try f.list("bases") {
            let q = ArmIK.quatFromBasis(Vec3(array: try c.nums("x")), Vec3(array: try c.nums("y")))
            expectClose(q.array, try c.nums("q"), 1e-15, "quatFromBasis")
        }
        for arm in try f.list("arms") {
            let r = try arm.at("rest")
            func joint(_ key: String) throws -> JointRest {
                let v = try r.nums(key)
                return JointRest(q: Quat(v[0], v[1], v[2], v[3]), p: Vec3(v[4], v[5], v[6]))
            }
            let side = try need(ArmSide(rawValue: try r.text("side")), "side")
            let setup = ArmIK.calibrate(ArmRest(side: side, upper: try joint("upper"), lower: try joint("lower"), hand: try joint("hand"),
                                                fingers: Vec3(array: try r.nums("fingers")), thumb: Vec3(array: try r.nums("thumb"))))
            try expectSetup(setup, try arm.at("setup"), "\(side) arm")
            let shoulder = Vec3(array: try arm.nums("shoulder"))
            for s in try arm.list("solves") {
                let out = ArmIK.solve(setup, shoulder: shoulder, gripPosition: Vec3(array: try s.nums("grip")),
                                      gripRotation: Quat(array: try s.nums("rotation")), pole: Vec3(array: try s.nums("pole")))
                for (q, key) in [(out.upper, "upper"), (out.lower, "lower"), (out.hand, "hand")] {
                    let web = try s.nums(key)
                    #expect(quatDiff(q, web) <= 1e-12, "\(side) \(key): \(q.array) vs \(web)")
                }
                expectClose(out.elbow.array + out.wrist.array, try s.nums("elbow") + s.nums("wrist"), 1e-12, "joints")
            }
        }
    }

    @Test func gunHold() throws {
        let f = try Fixtures.characters().at("gunHold")
        let shoulder = Vec3(array: try f.nums("shoulder"))
        for c in try f.list("cases") {
            let v = try c.nums("input")
            var input = HoldInput()
            (input.aim, input.carry, input.pitch, input.recoil, input.recoilSide, input.reload, input.swayPitch, input.swayYaw) =
                (v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7])
            let eye = try c.at("eye").array.map { try $0.map { try $0.asNumber() } }.map { Vec3(array: $0) }
            var hold = GunHold()
            hold.update(shoulder: shoulder, input: input, eye: eye)
            expectClose(hold.position.array, try c.nums("position"), 1e-12, "gun position \(v)")
            #expect(quatDiff(hold.quaternion, try c.nums("quaternion")) <= 1e-12)
            expectClose(hold.triggerPosition.array + hold.triggerRotation.array, try c.nums("trigger"), 1e-12, "trigger")
            expectClose(hold.supportPosition.array + hold.supportRotation.array, try c.nums("support"), 1e-12, "support")
        }
    }
}

func expectSetup(_ setup: ArmSetup, _ f: JSONValue, _ what: String) throws {
    expectClose([setup.upperLength, setup.lowerLength], [try f.num("upperLength"), try f.num("lowerLength")], 1e-12, "\(what) lengths")
    for (q, key) in [(setup.upperOffset, "upperOffset"), (setup.lowerOffset, "lowerOffset"), (setup.handOffset, "handOffset"), (setup.handRest, "handRest")] {
        #expect(quatDiff(q, try f.nums(key)) <= 1e-12, "\(what) \(key)")
    }
    expectClose(setup.palmLocal.array + setup.lowerAxis.array, try f.nums("palmLocal") + f.nums("lowerAxis"), 1e-12, "\(what) palm/axis")
}
