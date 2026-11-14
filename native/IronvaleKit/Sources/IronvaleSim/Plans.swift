// Ported from src/weapons/plans.ts at commit 185029e. The named constants and BOLT_CYCLE come from
// Contract/sim/sim.json; the inline reload mark tables are checked by the WeaponMachine traces in
// Contract/sim/weapons.json (stage order and timing are audible to the peer).
import IronvaleContract

public enum PlanKind: String, Sendable { case cycle, charge, reload }
public enum MarkEffect: String, Sendable { case eject, chamber, fill }

public struct Mark: Sendable, Equatable {
    public let time: Double
    public let stage: String?
    public let effect: MarkEffect?
}

public struct ActionPlan: Sendable, Equatable {
    public let kind: PlanKind
    public let duration: Double
    public let marks: [Mark]
    /// Window in which the firing hand is off the grip (a scope cannot be held).
    public let handsFrom: Double
    public let handsTo: Double

    public func markTime(_ stage: String) -> Double { marks.first { $0.stage == stage }?.time ?? -1 }
}

public struct PlanSet: Sendable {
    public let chamber: ActionPlan
    public let reloadChambered: ActionPlan
    public let reloadEmpty: ActionPlan

    public init(def: WeaponDef, constants: SimConstants.Plans) {
        let builder = PlanBuilder(constants: constants)
        chamber = builder.chamberPlan(def)
        reloadChambered = builder.reload(def, chambered: true)
        reloadEmpty = builder.reload(def, chambered: false)
    }

    public func reload(chambered: Bool) -> ActionPlan { chambered ? reloadChambered : reloadEmpty }
}

public func isManual(_ def: WeaponDef) -> Bool { def.fireMode == "bolt" }

struct PlanBuilder {
    typealias Spec = SimConstants.MarkSpec
    let constants: SimConstants.Plans

    func plan(_ kind: PlanKind, _ duration: Double, _ specs: [Spec]) -> ActionPlan {
        let marks = specs.map { Mark(time: $0.fraction * duration, stage: $0.stage, effect: $0.effect.flatMap(MarkEffect.init)) }
        let first = marks.first?.time ?? 0
        let last = marks.last?.time ?? duration
        return ActionPlan(
            kind: kind, duration: duration, marks: marks,
            handsFrom: max(0, first - constants.HANDS_LEAD),
            handsTo: min(duration, last + constants.HANDS_TAIL)
        )
    }

    /// Stage that puts a round in the chamber of a self-loading gun. The M249 fires from an open bolt.
    func chargeStage(_ def: WeaponDef) -> String { def.reloadStyle == "belt" ? "boltBack" : "boltForward" }

    func chamberPlan(_ def: WeaponDef) -> ActionPlan {
        if def.fireMode == "bolt" { return plan(.cycle, WeaponMath.shotInterval(def.roundsPerMinute), constants.BOLT_CYCLE) }
        return plan(.charge, constants.CHARGE_SECONDS, [Spec(0.5, chargeStage(def), "chamber")])
    }

    func reload(_ def: WeaponDef, chambered: Bool) -> ActionPlan {
        let full = def.reloadTime
        if def.reloadStyle == "belt" {
            var marks = [Spec(0.1, "beltOpen"), Spec(0.26, "magOut"), Spec(0.5, "magIn", "fill"), Spec(0.8, "beltClose")]
            if !chambered { marks.append(Spec(0.9, "boltBack", "chamber")) }
            return plan(.reload, full, marks)
        }
        if def.fireMode == "bolt" {
            return chambered
                ? plan(.reload, full * constants.BOLT_TOP_UP_FACTOR, [Spec(0.2, "magOut"), Spec(0.7, "magIn", "fill")])
                : plan(.reload, full, [
                    Spec(0.12, "magOut"), Spec(0.42, "magIn", "fill"), Spec(0.58, "boltLift"),
                    Spec(0.68, "boltBack", "eject"), Spec(0.82, "boltForward"), Spec(0.92, "boltClose", "chamber"),
                ])
        }
        return chambered
            ? plan(.reload, full * constants.TACTICAL_FACTOR, [Spec(0.2, "magOut"), Spec(0.7, "magIn", "fill")])
            : plan(.reload, full, [Spec(0.16, "magOut"), Spec(0.56, "magIn", "fill"), Spec(0.82, chargeStage(def), "chamber")])
    }
}
