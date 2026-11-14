// Ported from tests/weapons/machine.test.ts at commit 185029e, plus the WeaponMachine traces that
// native/Tools/sim-fixtures records from the TypeScript (every sink call and the ammo state, per frame).
import Foundation
import IronvaleContract
@testable import IronvaleSim
import Testing

private let DT = 1.0 / 120
private let IDLE = TriggerInput(fireHeld: false, firePressed: false, reloadPressed: false, ready: true)
private let HOLD = TriggerInput(fireHeld: true, firePressed: false, reloadPressed: false, ready: true)
private let PRESS = TriggerInput(fireHeld: true, firePressed: true, reloadPressed: false, ready: true)
private let RELOAD = TriggerInput(fireHeld: false, firePressed: false, reloadPressed: true, ready: true)
private let SEMI = variant(def("m4a1"), ["fireMode": "semi", "roundsPerMinute": 320])
private let SEMI_FAST = variant(SEMI, ["roundsPerMinute": 380])

private final class Rig: MachineSink {
    var time = 0.0
    var shots: [Double] = []
    var dry: [Double] = []
    var stageLog: [(stage: String, time: Double)] = []
    var ejects: [Double] = []
    var lastRound: [Bool] = []
    let machine: WeaponMachine

    init(_ weapon: WeaponDef) { machine = WeaponMachine(def: weapon) }
    convenience init(_ id: String) { self.init(def(id)) }

    func fire(lastRound last: Bool) {
        shots.append(time)
        lastRound.append(last)
    }
    func dryFire() { dry.append(time) }
    func stage(_ stage: String) { stageLog.append((stage, time)) }
    func eject() { ejects.append(time) }

    func step(_ input: TriggerInput, _ dt: Double = DT) {
        machine.step(dt: dt, input: input, sink: self)
        time += dt
    }

    func run(_ seconds: Double, _ input: TriggerInput = IDLE, _ dt: Double = DT) {
        let steps = Int((seconds / dt).rounded())
        for _ in 0 ..< max(0, steps) { step(input, dt) }
    }

    func tap() {
        step(PRESS)
        step(IDLE)
    }

    var stages: [String] { stageLog.map(\.stage) }

    func settle() {
        var i = 0
        while i < 4000, machine.busy || machine.reloading {
            step(IDLE)
            i += 1
        }
    }
}

@Suite struct AutomaticFire {
    @Test func firesAtTheRateOfFire() {
        for dt in [1.0 / 240, 1.0 / 60, 1.0 / 30] {
            let rig = Rig("m4a1")
            rig.step(PRESS, dt)
            rig.run(1.02 - dt, HOLD, dt)
            #expect(rig.shots.count == 14, "dt \(dt)")
        }
    }

    @Test func spacesShotsByTheInterval() {
        let rig = Rig("m4a1")
        rig.step(PRESS)
        rig.run(0.5, HOLD)
        let interval = WeaponMath.shotInterval(def("m4a1").roundsPerMinute)
        for i in 1 ..< rig.shots.count {
            #expect(rig.shots[i] - rig.shots[i - 1] > interval - DT * 1.01)
            #expect(rig.shots[i] - rig.shots[i - 1] < interval + DT * 1.01)
        }
    }

    @Test func quickTapFiresOne() {
        let rig = Rig("m4a1")
        rig.tap()
        rig.run(0.5)
        #expect(rig.shots.count == 1)
        #expect(rig.machine.magazine == 29)
    }

    @Test func ejectsWithEveryShot() {
        let rig = Rig("mp5")
        rig.step(PRESS)
        rig.run(0.3, HOLD)
        #expect(rig.ejects.count == rig.shots.count)
    }

    @Test func noCatchUpBurstAfterAPause() {
        let rig = Rig("m4a1")
        rig.run(2)
        rig.step(PRESS)
        rig.step(HOLD)
        rig.step(HOLD)
        #expect(rig.shots.count == 1)
    }
}

@Suite struct SemiAutomaticFire {
    @Test func oncePerPress() {
        let rig = Rig(SEMI)
        rig.step(PRESS)
        rig.run(1, HOLD)
        #expect(rig.shots.count == 1)
    }

    @Test func buffersAPressDuringCooldown() {
        let rig = Rig(SEMI)
        let interval = WeaponMath.shotInterval(SEMI.roundsPerMinute)
        rig.tap()
        rig.run(0.06)
        rig.tap()
        rig.run(0.5)
        #expect(rig.shots.count == 2)
        #expect(rig.shots[1] >= interval - DT)
        #expect(rig.shots[1] < interval + 2 * DT)
    }

    @Test func doesNotEatFastTaps() {
        let rig = Rig(SEMI_FAST)
        for _ in 0 ..< 7 {
            rig.tap()
            rig.run(0.1 - 2 * DT)
        }
        rig.run(0.4)
        let interval = WeaponMath.shotInterval(SEMI_FAST.roundsPerMinute)
        #expect(rig.shots.count == 5)
        for i in 1 ..< rig.shots.count { #expect(rig.shots[i] - rig.shots[i - 1] > interval - DT * 1.01) }
    }

    @Test func keepsOneShotInTheBuffer() {
        let rig = Rig(SEMI)
        rig.tap(); rig.tap(); rig.tap(); rig.tap()
        rig.run(1)
        #expect(rig.shots.count == 2)
    }

    @Test func bufferedPressLapses() {
        let rig = Rig("m24")
        rig.tap()
        rig.run(0.3)
        rig.tap()
        rig.run(3)
        #expect(rig.shots.count == 1)
    }

    @Test func holdsAPressWhileNotReady() {
        let rig = Rig(SEMI)
        var press = PRESS
        press.ready = false
        var idle = IDLE
        idle.ready = false
        rig.step(press)
        rig.run(0.4, idle)
        #expect(rig.shots.isEmpty)
        rig.step(IDLE)
        #expect(rig.shots.count == 1)
    }
}

@Suite struct DryFireAndAutoReload {
    @Test func clicksOncePerPressWithNoReserve() {
        let rig = Rig(SEMI)
        rig.machine.setAmmo(rounds: 0, reserve: 0)
        rig.step(PRESS)
        rig.run(0.5, HOLD)
        #expect(rig.dry.count == 1)
        rig.tap()
        #expect(rig.dry.count == 2)
        #expect(rig.shots.isEmpty)
        #expect(!rig.machine.reloading)
    }

    @Test func clicksAndReloadsWithReserve() {
        let rig = Rig("m4a1")
        rig.machine.setAmmo(rounds: 0, reserve: 60)
        rig.tap()
        #expect(rig.dry.count == 1)
        #expect(rig.machine.reloading)
    }

    @Test func noClickWhenRunningDryMidBurst() {
        let rig = Rig("m4a1")
        rig.machine.setAmmo(rounds: 3, reserve: 0)
        rig.step(PRESS)
        rig.run(1, HOLD)
        #expect(rig.shots.count == 3)
        #expect(rig.dry.isEmpty)
    }
}

@Suite struct MagazineReload {
    @Test func keepsTheChamberedRound() {
        let rig = Rig("m4a1")
        rig.machine.setAmmo(rounds: 12, reserve: 150)
        rig.step(RELOAD)
        #expect(rig.machine.reloading)
        rig.settle()
        #expect(rig.stages == ["magOut", "magIn"])
        #expect(rig.machine.magazine == 31)
        #expect(rig.machine.reserve == 150 - 19)
        #expect(rig.time < def("m4a1").reloadTime)
    }

    @Test func releasesTheBoltOnlyWhenEmpty() {
        let rig = Rig("m4a1")
        rig.machine.setAmmo(rounds: 0, reserve: 150)
        rig.step(RELOAD)
        rig.settle()
        #expect(rig.stages == ["magOut", "magIn", "boltForward"])
        #expect(rig.machine.magazine == 30)
        #expect(rig.machine.reserve == 120)
        #expect(approx(rig.time, def("m4a1").reloadTime, 1))
    }

    @Test func loadsWhatIsLeft() {
        let rig = Rig("m4a1")
        rig.machine.setAmmo(rounds: 5, reserve: 10)
        rig.step(RELOAD)
        rig.settle()
        #expect(rig.machine.magazine == 15)
        #expect(rig.machine.reserve == 0)
    }

    @Test func refusesWhenFullOrDry() {
        let full = Rig("m4a1")
        full.machine.setAmmo(rounds: 31, reserve: 100)
        full.step(RELOAD)
        #expect(!full.machine.reloading)
        let dry = Rig("m4a1")
        dry.machine.setAmmo(rounds: 4, reserve: 0)
        dry.step(RELOAD)
        #expect(!dry.machine.reloading)
    }

    @Test func blocksFireUntilDone() {
        let rig = Rig("m4a1")
        rig.machine.setAmmo(rounds: 12, reserve: 150)
        rig.step(RELOAD)
        rig.step(PRESS)
        rig.run(0.5, HOLD)
        #expect(rig.shots.isEmpty)
        rig.settle()
        rig.step(PRESS)
        #expect(rig.shots.count == 1)
    }

    @Test func cancelBeforeMagInLeavesAmmo() {
        let rig = Rig("m4a1")
        rig.machine.setAmmo(rounds: 12, reserve: 150)
        rig.step(RELOAD)
        rig.run(0.3)
        rig.machine.cancel()
        #expect(!rig.machine.reloading)
        #expect(rig.machine.magazine == 12)
        #expect(rig.machine.reserve == 150)
    }

    @Test func cancelAfterMagInKeepsTheMagazine() {
        let rig = Rig("m4a1")
        rig.machine.setAmmo(rounds: 0, reserve: 150)
        rig.step(RELOAD)
        while !rig.stages.contains("magIn") { rig.run(DT) }
        rig.machine.cancel()
        #expect(rig.machine.magazine == 30)
        rig.step(IDLE)
        #expect(rig.machine.busy)
    }
}

@Suite struct BoltAction {
    @Test func cyclesAndEjects() {
        let rig = Rig("m24")
        rig.tap()
        rig.run(2)
        #expect(rig.stages == ["boltLift", "boltBack", "boltForward", "boltClose"])
        #expect(rig.ejects.count == 1)
        #expect(approx(rig.ejects[0], rig.stageLog[1].time, 5))
    }

    @Test func reportsTheCycle() {
        let rig = Rig("m24")
        rig.tap()
        rig.run(0.6)
        #expect(rig.machine.cycling)
        rig.run(1.5)
        #expect(!rig.machine.cycling)
    }

    @Test func firesAgainOnlyAfterTheFullCycle() {
        let rig = Rig("m24")
        let interval = WeaponMath.shotInterval(def("m24").roundsPerMinute)
        rig.step(PRESS)
        rig.run(interval - 0.1)
        rig.step(PRESS)
        rig.run(0.3)
        #expect(rig.shots.count == 2)
        #expect(rig.shots[1] >= interval - DT)
    }

    @Test func lastRoundLeavesTheBoltClosed() {
        let rig = Rig("m24")
        rig.machine.setAmmo(rounds: 1, reserve: 30)
        rig.tap()
        rig.run(2)
        #expect(rig.stages.isEmpty)
        rig.step(RELOAD)
        rig.settle()
        #expect(rig.stages == ["magOut", "magIn", "boltLift", "boltBack", "boltForward", "boltClose"])
        #expect(rig.ejects.count == 1)
        #expect(rig.machine.magazine == 5)
    }

    @Test func topsUpWithARoundChambered() {
        let rig = Rig("m24")
        rig.tap()
        rig.run(2)
        rig.step(RELOAD)
        rig.settle()
        #expect(Array(rig.stages.dropFirst(4)) == ["magOut", "magIn"])
        #expect(rig.machine.magazine == 6)
        #expect(rig.machine.reserve == 28)
    }

    @Test func finishesAnInterruptedCycle() {
        let rig = Rig("m24")
        rig.tap()
        rig.run(0.2)
        rig.machine.cancel()
        rig.step(PRESS)
        rig.run(0.2)
        #expect(rig.shots.count == 1)
        #expect(rig.machine.cycling)
        rig.run(2)
        #expect(rig.ejects.count == 1)
    }
}

@Suite struct BeltReload {
    @Test func opensChangesCloses() {
        let rig = Rig("m249")
        rig.machine.setAmmo(rounds: 40, reserve: 200)
        rig.step(RELOAD)
        rig.settle()
        #expect(rig.stages == ["beltOpen", "magOut", "magIn", "beltClose"])
        #expect(rig.machine.magazine == 100)
        #expect(rig.machine.reserve == 140)
        #expect(approx(rig.time, def("m249").reloadTime, 1))
    }

    @Test func chargesWhenDry() {
        let rig = Rig("m249")
        rig.machine.setAmmo(rounds: 0, reserve: 60)
        rig.step(RELOAD)
        rig.settle()
        #expect(rig.stages == ["beltOpen", "magOut", "magIn", "beltClose", "boltBack"])
        #expect(rig.machine.magazine == 60)
        #expect(rig.machine.reserve == 0)
    }
}

@Test func refillRestoresEverything() {
    let rig = Rig("m4a1")
    rig.machine.setAmmo(rounds: 0, reserve: 10)
    rig.step(RELOAD)
    rig.run(0.2)
    rig.machine.refill()
    #expect(!rig.machine.reloading)
    #expect(rig.machine.magazine == 30)
    #expect(rig.machine.reserve == 150)
}

/// Every weapon's machine against the TypeScript trace: identical sink calls and ammo state every frame.
@Test func machineMatchesTypeScriptTraces() throws {
    let root = try fixture("weapons.json") as! [String: Any]
    var frames = 0
    for trace in root["machine"] as! [[String: Any]] {
        let id = trace["weapon"] as! String
        final class Sink: MachineSink {
            var calls: [String] = []
            func fire(lastRound: Bool) { calls.append("fire:\(lastRound ? 1 : 0)") }
            func dryFire() { calls.append("dry") }
            func stage(_ stage: String) { calls.append("stage:\(stage)") }
            func eject() { calls.append("eject") }
        }
        let sink = Sink()
        let machine = WeaponMachine(def: def(id))
        let records = trace["records"] as! [[Any]]
        for (i, raw) in (trace["frames"] as! [[Any]]).enumerated() {
            if raw.count > 5, let command = raw[5] as? [Any] {
                switch command[0] as! String {
                case "setAmmo": machine.setAmmo(rounds: double(command[1]), reserve: double(command[2]))
                case "cancel": machine.cancel()
                default: machine.refill()
                }
            }
            sink.calls.removeAll()
            let input = TriggerInput(fireHeld: double(raw[1]) == 1, firePressed: double(raw[2]) == 1,
                                     reloadPressed: double(raw[3]) == 1, ready: double(raw[4]) == 1)
            machine.step(dt: double(raw[0]), input: input, sink: sink)
            let r = records[i]
            let state = [Double(machine.magazine), Double(machine.reserve), machine.reloading ? 1 : 0, machine.busy ? 1 : 0,
                         machine.cycling ? 1 : 0, machine.chambered ? 1 : 0]
            #expect(state == r[0 ..< 6].map(double), "\(id) v\(trace["variant"]!) frame \(i)")
            #expect(abs(machine.actionTime - double(r[6])) < 1e-9, "\(id) frame \(i) actionTime")
            #expect(sink.calls == r[7] as! [String], "\(id) v\(trace["variant"]!) frame \(i)")
            frames += 1
        }
    }
    #expect(frames == 6 * 3 * 600)
}
