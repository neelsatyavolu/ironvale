// Ported from src/weapons/machine.ts at commit 185029e. Fire-rate accounting is observable by the
// peer's WeaponGate (weapons map 4.5): keep the one-frame credit and the `while` loop exactly.
import IronvaleContract

/// What the machine tells its owner. Called synchronously from `step`.
public protocol MachineSink: AnyObject {
    /// A round left the barrel. `lastRound` is true when it emptied the gun.
    func fire(lastRound: Bool)
    func dryFire()
    func stage(_ stage: String)
    /// A spent casing left the gun.
    func eject()
}

public struct TriggerInput: Sendable, Equatable {
    public var fireHeld: Bool
    public var firePressed: Bool
    public var reloadPressed: Bool
    /// false while the gun is lowered (switching, sprinting). Presses wait for it.
    public var ready: Bool

    public init(fireHeld: Bool = false, firePressed: Bool = false, reloadPressed: Bool = false, ready: Bool = true) {
        self.fireHeld = fireHeld
        self.firePressed = firePressed
        self.reloadPressed = reloadPressed
        self.ready = ready
    }
}

/// One gun's trigger, magazine and action. `magazine` counts everything loaded, including the chambered round.
public final class WeaponMachine {
    public let def: WeaponDef
    public private(set) var action: ActionPlan?
    public private(set) var actionTime = 0.0
    /// A live round is in the chamber.
    public private(set) var chambered = true
    public private(set) var magazine: Int
    public private(set) var reserve: Int
    public private(set) var reloading = false

    private var spentCase = false
    private var cooldown = 0.0
    private var pressBuffer = 0.0
    private var reloadQueued = false
    private let interval: Double
    private let manual: Bool
    private let plans: PlanSet
    private let pressBufferSeconds: Double

    public init(def: WeaponDef, constants: SimConstants = SimData.shared.constants) {
        self.def = def
        magazine = def.magazineSize
        reserve = def.reserveAmmo
        interval = WeaponMath.shotInterval(def.roundsPerMinute)
        manual = isManual(def)
        plans = PlanSet(def: def, constants: constants.plans)
        pressBufferSeconds = constants.machine.PRESS_BUFFER
    }

    /// true while an action runs or the gun is between shots.
    public var busy: Bool { action != nil || cooldown > 0 }

    /// true while the firing hand is working a bolt after a shot.
    public var cycling: Bool {
        guard let action, action.kind == .cycle else { return false }
        return actionTime >= action.handsFrom && actionTime <= action.handsTo
    }

    public var canReload: Bool {
        let keep = def.reloadStyle == "magazine" && chambered ? 1 : 0
        return reserve > 0 && magazine < def.magazineSize + keep
    }

    public func refill() {
        cancel()
        setAmmo(rounds: Double(def.magazineSize), reserve: Double(def.reserveAmmo))
        cooldown = 0
    }

    public func setAmmo(rounds: Double, reserve: Double) {
        magazine = Int(max(0, rounds.rounded(.down)))
        self.reserve = Int(max(0, reserve.rounded(.down)))
        chambered = magazine > 0
        spentCase = false
    }

    /// Drop whatever the hands were doing (weapon switch, death). Ammo already loaded stays loaded.
    public func cancel() {
        action = nil
        actionTime = 0
        reloading = false
        pressBuffer = 0
        reloadQueued = false
    }

    public func step(dt: Double, input: TriggerInput, sink: any MachineSink) {
        if input.firePressed { pressBuffer = pressBufferSeconds }
        if input.reloadPressed, !reloading { reloadQueued = true }
        // Keep at most one frame of credit so the rate of fire is exact but a pause never banks shots.
        cooldown = max(cooldown - dt, -dt)
        if action != nil { advance(dt, sink) }
        if !input.ready { return }
        think(input, sink)
        if pressBuffer > 0 { pressBuffer -= dt }
    }

    private func think(_ input: TriggerInput, _ sink: any MachineSink) {
        if action != nil { return }
        if !chambered, magazine > 0 {
            begin(plans.chamber)
            return
        }
        if reloadQueued {
            reloadQueued = false
            if canReload {
                startReload()
                return
            }
        }
        let auto = def.fireMode == "auto"
        while (pressBuffer > 0 || (auto && input.fireHeld)) && cooldown <= 0 && action == nil {
            if magazine <= 0 {
                // Only a fresh press clicks; holding the trigger on an empty gun stays quiet.
                if pressBuffer > 0 {
                    pressBuffer = 0
                    sink.dryFire()
                    if canReload { startReload() }
                }
                return
            }
            fire(sink)
        }
    }

    private func fire(_ sink: any MachineSink) {
        pressBuffer = 0
        reloadQueued = false
        magazine -= 1
        cooldown += interval
        let last = magazine == 0
        if manual {
            chambered = false
            spentCase = true
            sink.fire(lastRound: last)
            // The last case stays in the chamber until the reload works the action.
            if !last { begin(plans.chamber) }
            return
        }
        chambered = !last
        sink.fire(lastRound: last)
        sink.eject()
    }

    private func startReload() {
        reloading = true
        reloadQueued = false
        begin(plans.reload(chambered: chambered))
    }

    private func begin(_ plan: ActionPlan) {
        action = plan
        actionTime = 0
    }

    private func advance(_ dt: Double, _ sink: any MachineSink) {
        var remaining = dt
        while let action, remaining > 0 {
            let from = actionTime
            let to = from + remaining
            for mark in action.marks where mark.time >= from && mark.time < to { apply(mark, sink) }
            if to < action.duration {
                actionTime = to
                return
            }
            remaining = to - action.duration
            self.action = nil
            actionTime = 0
            reloading = false
        }
    }

    private func apply(_ mark: Mark, _ sink: any MachineSink) {
        if let stage = mark.stage { sink.stage(stage) }
        switch mark.effect {
        case .eject:
            if spentCase {
                spentCase = false
                sink.eject()
            }
        case .chamber:
            chambered = magazine > 0
        case .fill:
            let keep = def.reloadStyle == "magazine" && chambered ? 1 : 0
            let pool = reserve + magazine - keep
            let take = min(def.magazineSize, pool)
            magazine = keep + take
            reserve = pool - take
        case nil:
            break
        }
    }
}
