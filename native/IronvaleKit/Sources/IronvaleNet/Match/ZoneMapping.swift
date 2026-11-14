// The hit zone exists twice: IronvaleSim's (what bullets hit) and IronvaleWire's (what the `hit`
// event carries). Both are the strings head, torso and limb.
import IronvaleSim
import IronvaleWire

extension IronvaleSim.HitZone {
    var wire: IronvaleWire.HitZone { IronvaleWire.HitZone(rawValue: rawValue)! }
    init(wire: IronvaleWire.HitZone) { self = IronvaleSim.HitZone(rawValue: wire.rawValue)! }
}
