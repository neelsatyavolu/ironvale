// Ported from src/weapons/view/parts.ts at commit a487033: moves a gun's bolt, slide, magazine,
// feed cover and trigger in time with the weapon machine's action plan, and reports how far the gun
// body and the hands move into their reload and bolt-working poses. Constants: Contract/viewmodel.json.
import Foundation
import IronvaleSim

/// The machine's action plan as the view reads it (src/weapons/plans.ts ActionPlan).
public struct ViewAction: Sendable, Equatable {
    public var kind: String
    public var duration: Double
    public var handsFrom: Double
    public var handsTo: Double
    public var marks: [(stage: String?, time: Double)]

    public init(kind: String, duration: Double, handsFrom: Double, handsTo: Double, marks: [(stage: String?, time: Double)]) {
        self.kind = kind
        self.duration = duration
        self.handsFrom = handsFrom
        self.handsTo = handsTo
        self.marks = marks
    }

    public init(_ plan: ActionPlan) {
        self.init(kind: plan.kind.rawValue, duration: plan.duration, handsFrom: plan.handsFrom, handsTo: plan.handsTo,
                  marks: plan.marks.map { ($0.stage, $0.time) })
    }

    /// plans.ts markTime: the first mark with `stage`, or -1.
    public func markTime(_ stage: String) -> Double { marks.first { $0.stage == stage }?.time ?? -1 }

    public static func == (a: ViewAction, b: ViewAction) -> Bool {
        a.kind == b.kind && a.duration == b.duration && a.handsFrom == b.handsFrom && a.handsTo == b.handsTo
            && a.marks.map(\.time) == b.marks.map(\.time) && a.marks.map(\.stage) == b.marks.map(\.stage)
    }
}

/// What the view reads from the weapon machine each frame.
public struct MachineView: Sendable {
    public var action: ViewAction?
    public var actionTime: Double
    public var chambered: Bool
    public var magazine: Int

    public init(action: ViewAction?, actionTime: Double, chambered: Bool, magazine: Int) {
        self.action = action
        self.actionTime = actionTime
        self.chambered = chambered
        self.magazine = magazine
    }

    public init(_ machine: WeaponMachine) {
        self.init(action: machine.action.map(ViewAction.init), actionTime: machine.actionTime,
                  chambered: machine.chambered, magazine: machine.magazine)
    }
}

public final class PartsAnimator {
    public private(set) var tilt = 0.0
    public private(set) var work = 0.0
    public private(set) var seat = 0.0
    public private(set) var supportAway = 0.0
    public private(set) var triggerAway = 0.0
    public private(set) var magazineOut = 0.0

    private var sinceShot = Double.infinity
    private var held = 0.0
    private let rests: [(part: RigNode, position: RVec3, quaternion: RQuat)]
    private let model: GunModel
    private let def: ViewModelTables.Weapon
    private let c: ViewModelTables.Parts
    private let manual: Bool
    private let locks: Bool

    init(model: GunModel, def: ViewModelTables.Weapon, constants: ViewModelTables.Parts) {
        self.model = model
        self.def = def
        c = constants
        manual = def.fireMode == "bolt"
        locks = (def.fireMode == "semi" || def.fireMode == "auto") && def.weaponClass == "carbine"
        rests = GunModel.partNames.compactMap { name in model.parts[name].map { ($0, $0.position, $0.quaternion) } }
    }

    public func fired() { sinceShot = 0 }

    public func reset() {
        sinceShot = .infinity
        held = 0
        tilt = 0
        work = 0
        seat = 0
        supportAway = 0
        triggerAway = 0
        magazineOut = 0
    }

    public func update(_ dt: Double, machine: MachineView) {
        sinceShot += dt
        for rest in rests {
            rest.part.position = rest.position
            rest.part.quaternion = rest.quaternion
        }
        let travel = model.cycleTravel
        var tilt = 0.0, work = 0.0, seat = 0.0, supportAway = 0.0, triggerAway = 0.0, magazineOut = 0.0
        var boltBack = 0.0, boltLift = 0.0, cover = 0.0
        var holdOpen = locks && !machine.chambered && machine.magazine == 0
        let ramp = Motion.ramp

        if let action = machine.action {
            let time = machine.actionTime
            let tLift = action.markTime("boltLift"), tBack = action.markTime("boltBack")
            let tForward = action.markTime("boltForward"), tClose = action.markTime("boltClose")
            let tMagOut = action.markTime("magOut"), tMagIn = action.markTime("magIn")
            let tOpen = action.markTime("beltOpen"), tShut = action.markTime("beltClose")

            if action.kind == "reload" {
                tilt = ramp(0, 0.22, time) * (1 - ramp(action.duration - 0.28, action.duration, time))
            } else {
                work = ramp(action.handsFrom, action.handsFrom + 0.12, time) * (1 - ramp(action.handsTo - 0.06, action.handsTo + 0.12, time))
            }
            if tMagOut >= 0, tMagIn >= 0 {
                magazineOut = ramp(tMagOut - 0.02, tMagOut + c.MAG_FALL_SECONDS, time) * (1 - ramp(tMagIn - c.MAG_SEAT_SECONDS, tMagIn, time))
                supportAway = ramp(tMagOut - 0.24, tMagOut - 0.04, time) * (1 - ramp(tMagIn + 0.05, tMagIn + 0.3, time))
                seat = Self.bump(time - tMagIn, 0.1)
            }
            if tOpen >= 0 {
                cover = ramp(tOpen - 0.04, tOpen + 0.25, time) * (1 - ramp(tShut - 0.25, tShut, time))
                supportAway = max(supportAway, ramp(tOpen - 0.2, tOpen, time) * (1 - ramp(tShut, tShut + 0.3, time)))
            }
            if manual {
                if tLift >= 0 {
                    boltLift = ramp(tLift - 0.09, tLift, time) * (1 - ramp(tClose - 0.07, tClose, time))
                    triggerAway = ramp(tLift - 0.2, tLift - 0.05, time) * (1 - ramp(tClose, tClose + 0.18, time))
                }
                if tBack >= 0 { boltBack = ramp(tBack - 0.1, tBack, time) * (1 - ramp(tForward - 0.1, tForward, time)) }
            } else if tBack >= 0 {
                // A self-loader's bolt pulled by hand: stays back until released, or snaps home when only charged.
                let until = tForward >= 0 ? tForward : tBack + 0.16
                if time > tBack - 0.1, time < until { holdOpen = true }
            }
        }

        self.tilt = Motion.damp(self.tilt, tilt, c.WEIGHT_RATE, dt)
        self.work = Motion.damp(self.work, work, c.WEIGHT_RATE, dt)
        self.supportAway = Motion.damp(self.supportAway, supportAway, c.WEIGHT_RATE, dt)
        self.triggerAway = Motion.damp(self.triggerAway, triggerAway, c.WEIGHT_RATE, dt)
        self.seat = seat
        self.magazineOut = magazineOut

        var slide = 0.0
        if !manual {
            let t = sinceShot
            let pulse = t < c.SLIDE_BACK_SECONDS ? t / c.SLIDE_BACK_SECONDS
                : max(0, 1 - (t - c.SLIDE_BACK_SECONDS) / c.SLIDE_RETURN_SECONDS)
            held = Motion.damp(held, holdOpen ? 1 : 0, c.RELEASE_RATE, dt)
            slide = max(pulse, held)
        } else {
            slide = boltBack
        }

        let parts = model.parts
        if let trigger = parts["trigger"], sinceShot < c.TRIGGER_HOLD_SECONDS + c.TRIGGER_RELEASE_SECONDS {
            let squeeze = 1 - max(0, sinceShot - c.TRIGGER_HOLD_SECONDS) / c.TRIGGER_RELEASE_SECONDS
            trigger.quaternion = trigger.quaternion * RQuat.axisAngle(RVec3(1, 0, 0), -c.TRIGGER_PULL_RADIANS * squeeze)
        }
        if let slidePart = parts["slide"] { slidePart.position.z += travel * slide }
        if let bolt = parts["bolt"] {
            bolt.position.z += travel * slide
            if boltLift > 0 { bolt.quaternion = bolt.quaternion * RQuat.axisAngle(RVec3(0, 0, 1), boltLift * c.BOLT_LIFT_RADIANS) }
        }
        if let handle = parts["chargingHandle"], !manual, held > 0, def.reloadStyle == "belt" {
            handle.position.z += travel * held
        }
        if let coverPart = parts["cover"], cover > 0 {
            coverPart.quaternion = coverPart.quaternion * RQuat.axisAngle(RVec3(1, 0, 0), cover * c.COVER_OPEN_RADIANS)
        }
        if let magazine = parts["magazine"] {
            magazine.position.y -= c.MAG_DROP_METRES * magazineOut
            magazine.position.z += c.MAG_TOWARD_SHOOTER * magazineOut
            magazine.visible = magazineOut < 0.97
        }
    }

    /// 1 at t = 0, falling to 0 at +/- width.
    static func bump(_ t: Double, _ width: Double) -> Double {
        let x = abs(t) / width
        return x >= 1 ? 0 : 1 - x * x * (3 - 2 * x)
    }
}
