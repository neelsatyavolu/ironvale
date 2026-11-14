// Ported from tests/weapons/switching.test.ts, tests/weapons/recoil.test.ts (RecoilModel) and the
// AimState cases of tests/weapons/aim.test.ts at commit 185029e.
import Foundation
import IronvaleCore
@testable import IronvaleSim
import Testing

private let DT = 1.0 / 120
private let TIMES = [
    SimConstants.SwitchTimes(lowerTime: 0.2, raiseTime: 0.3),
    SimConstants.SwitchTimes(lowerTime: 0.4, raiseTime: 0.6),
    SimConstants.SwitchTimes(lowerTime: 0.1, raiseTime: 0.1),
]

private func switchRig() -> (WeaponSwitch, () -> [Int], (Double) -> Void) {
    let swap = WeaponSwitch(count: TIMES.count) { TIMES[$0] }
    var changes: [Int] = []
    let run = { (seconds: Double) in
        for _ in 0 ..< Int((seconds / DT).rounded()) where swap.update(DT) { changes.append(swap.index) }
    }
    return (swap, { changes }, run)
}

@Suite struct WeaponSwitchTests {
    @Test func lowersThenRaises() {
        let (swap, changes, run) = switchRig()
        #expect(swap.request(1))
        #expect(swap.switching)
        run(0.1)
        #expect(swap.index == 0)
        #expect(approx(swap.lowered, 0.5, 1))
        run(0.11)
        #expect(changes() == [1])
        #expect(swap.index == 1)
        #expect(swap.lowered > 0.9)
        run(0.3)
        #expect(swap.switching)
        #expect(approx(swap.lowered, 0.5, 1))
        run(0.31)
        #expect(!swap.switching)
        #expect(swap.lowered == 0)
    }

    @Test func ignoresTheGunInHandAndBadSlots() {
        let (swap, _, _) = switchRig()
        #expect(!swap.request(0))
        #expect(!swap.request(-1))
        #expect(!swap.request(7))
        #expect(!swap.switching)
    }

    @Test func retargetsWhileLowering() {
        let (swap, changes, run) = switchRig()
        swap.request(1)
        run(0.1)
        #expect(!swap.request(2))
        #expect(swap.pending == 2)
        run(0.11)
        #expect(changes() == [2])
    }

    @Test func takenBackMidLower() {
        let (swap, changes, run) = switchRig()
        swap.request(1)
        run(0.1)
        swap.request(0)
        run(1)
        #expect(changes().isEmpty)
        #expect(swap.index == 0)
        #expect(!swap.switching)
    }

    @Test func turnsRoundPartWayThroughRaising() {
        let (swap, changes, run) = switchRig()
        swap.request(1)
        run(0.21)
        run(0.3)
        #expect(swap.request(2))
        run(0.15)
        #expect(swap.index == 1)
        run(0.1)
        #expect(changes() == [1, 2])
    }

    @Test func resetAndHold() {
        let (swap, _, run) = switchRig()
        swap.request(1)
        run(0.1)
        swap.reset()
        #expect(!swap.switching)
        #expect(swap.index == 0)
        #expect(swap.pending == 0)
        swap.request(1)
        run(0.1)
        swap.hold(2)
        #expect(swap.index == 2)
        #expect(swap.pending == 2)
        #expect(!swap.switching)
        swap.hold(9)
        #expect(swap.index == 2)
    }
}

private let STANDING = Stance()
private func seeded(_ seed: UInt32) -> () -> Double {
    var random = SeededRandom(seed: seed)
    return { random.next() }
}

@Suite struct RecoilTests {
    let m4 = def("m4a1")

    @Test func firstShotKick() {
        let recoil = RecoilModel(random: seeded(1))
        recoil.shot(m4, STANDING)
        #expect(approx(recoil.kickPitch, m4.recoil.vertical, 6))
        #expect(abs(recoil.kickYaw) <= m4.recoil.horizontal)
    }

    @Test func growsOverABurstAndSettles() {
        let recoil = RecoilModel(random: seeded(1))
        recoil.shot(m4, STANDING)
        let first = recoil.kickPitch
        for _ in 0 ..< 12 {
            recoil.update(0.075)
            recoil.shot(m4, STANDING)
        }
        #expect(recoil.kickPitch > first * 1.15)
        #expect(recoil.kickPitch < first * 1.6)
        for _ in 0 ..< 60 { recoil.update(1.0 / 60) }
        recoil.shot(m4, STANDING)
        #expect(approx(recoil.kickPitch, m4.recoil.vertical, 6))
    }

    @Test func lighterAimedAndCrouched() {
        let hip = RecoilModel(random: seeded(1)), aimed = RecoilModel(random: seeded(1)), crouched = RecoilModel(random: seeded(1))
        hip.shot(m4, STANDING)
        aimed.shot(m4, Stance(aimBlend: 1))
        crouched.shot(m4, Stance(crouching: true))
        #expect(aimed.kickPitch < hip.kickPitch)
        #expect(crouched.kickPitch < hip.kickPitch)
        #expect(abs(aimed.kickYaw) < abs(hip.kickYaw))
    }

    @Test func sidewaysBothWays() {
        let recoil = RecoilModel(random: seeded(5))
        var sum = 0.0
        var left = 0
        for _ in 0 ..< 2000 {
            recoil.shot(m4, STANDING)
            recoil.update(1)
            sum += recoil.kickYaw
            if recoil.kickYaw < 0 { left += 1 }
        }
        #expect(abs(sum / 2000) < m4.recoil.horizontal * 0.08)
        #expect(Double(left) / 2000 > 0.4 && Double(left) / 2000 < 0.6)
    }

    @Test func spreadFigures() {
        let recoil = RecoilModel(random: seeded(1))
        #expect(approx(recoil.spread(m4, STANDING), m4.spreadHip, 6))
        #expect(approx(recoil.spread(m4, Stance(aimBlend: 1)), m4.spreadAim, 6))
        let slow = recoil.spread(m4, Stance(speed: 2)), fast = recoil.spread(m4, Stance(speed: 6))
        #expect(slow > m4.spreadHip && fast > slow)
        #expect(approx(fast, m4.spreadHip + m4.spreadMoving, 6))
        #expect(recoil.spread(m4, Stance(airborne: true)) > m4.spreadHip * 1.3)
        #expect(recoil.spread(m4, Stance(crouching: true)) < m4.spreadHip)
    }

    @Test func bloomsAndRecovers() {
        let recoil = RecoilModel(random: seeded(1))
        let rest = recoil.spread(m4, STANDING)
        for _ in 0 ..< 10 {
            recoil.shot(m4, STANDING)
            recoil.update(0.075)
        }
        let hot = recoil.spread(m4, STANDING)
        #expect(hot > rest * 1.25 && hot < rest * 2.5)
        for _ in 0 ..< 36 { recoil.update(1.0 / 60) }
        #expect(recoil.spread(m4, STANDING) < rest * 1.05)
        let aimedModel = RecoilModel(random: seeded(1))
        for _ in 0 ..< 10 {
            aimedModel.shot(m4, Stance(aimBlend: 1))
            aimedModel.update(0.075)
        }
        #expect(aimedModel.spread(m4, Stance(aimBlend: 1)) < m4.spreadHip * 0.4)
    }
}

@Suite struct AimStateTests {
    let base = AimInput(held: false, pressed: false, toggle: false, allowed: true, aimTime: 0.24)

    private func run(_ aim: AimState, _ seconds: Double, _ input: AimInput) -> Int {
        var changes = 0
        for _ in 0 ..< Int((seconds / DT).rounded()) where aim.update(DT, input) { changes += 1 }
        return changes
    }

    @Test func raisesAndLowers() {
        let aim = AimState()
        var hold = base
        hold.held = true
        _ = run(aim, 0.12, hold)
        #expect(aim.blend > 0.4 && aim.blend < 0.6)
        _ = run(aim, 0.13, hold)
        #expect(aim.blend == 1)
        _ = run(aim, 0.3, base)
        #expect(aim.blend == 0)
    }

    @Test func reportsEachChangeOnce() {
        let aim = AimState()
        var hold = base
        hold.held = true
        #expect(run(aim, 0.5, hold) == 1)
        #expect(aim.aiming)
        #expect(run(aim, 0.5, base) == 1)
        #expect(!aim.aiming)
    }

    @Test func lowersWhileNotAllowed() {
        let aim = AimState()
        var hold = base
        hold.held = true
        _ = run(aim, 0.5, hold)
        var blocked = hold
        blocked.allowed = false
        _ = run(aim, 0.5, blocked)
        #expect(aim.blend == 0)
        _ = run(aim, 0.5, hold)
        #expect(aim.blend == 1)
    }

    @Test func toggleStaysAimed() {
        let aim = AimState()
        var toggle = base
        toggle.toggle = true
        var press = toggle
        press.pressed = true
        press.held = true
        aim.update(DT, press)
        _ = run(aim, 0.5, toggle)
        #expect(aim.blend == 1)
        aim.update(DT, press)
        _ = run(aim, 0.5, toggle)
        #expect(aim.blend == 0)
    }
}
