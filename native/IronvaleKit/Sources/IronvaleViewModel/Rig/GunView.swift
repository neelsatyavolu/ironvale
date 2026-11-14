// Ported from src/weapons/view/gun-view.ts at commit a487033: one gun as the player sees it, its
// hip and aimed holder poses from the model's anchors, the parts animator and the hand targets.
import Foundation
import simd

/// src/game/contracts.ts GunModel: the gun's scene graph and its named anchors and parts.
public final class GunModel {
    public let id: String
    public let root: RigNode
    public let muzzle: RigNode
    public let ejection: RigNode
    public let sight: RigNode
    public let parts: [String: RigNode]
    public let cycleTravel: Double
    public let gripTrigger: RigNode
    public let gripSupport: RigNode

    /// Part names in GunModel order (contracts.ts), the order the parts animator restores them in.
    public static let partNames = ["bolt", "slide", "magazine", "trigger", "chargingHandle", "cover"]

    public init(id: String, root: RigNode, muzzle: RigNode, ejection: RigNode, sight: RigNode, parts: [String: RigNode],
                cycleTravel: Double, gripTrigger: RigNode, gripSupport: RigNode) {
        self.id = id
        self.root = root
        self.muzzle = muzzle
        self.ejection = ejection
        self.sight = sight
        self.parts = parts
        self.cycleTravel = cycleTravel
        self.gripTrigger = gripTrigger
        self.gripSupport = gripSupport
    }
}

public final class GunView {
    public let model: GunModel
    public let def: ViewModelTables.Weapon
    public let parts: PartsAnimator
    public let aimPosition: RVec3
    public let aimQuaternion: RQuat
    public let hipPosition: RVec3
    public let hipQuaternion: RQuat
    /// Metres from the grip to the muzzle along the barrel.
    public let barrelLength: Double
    public let triggerTarget = RigNode(name: "hand_trigger_target")
    public let supportTarget = RigNode(name: "hand_support_target")
    private let awayNode: RigNode?
    private let triggerRest: RVec3
    private let triggerRestQuaternion: RQuat

    public init(model: GunModel, def: ViewModelTables.Weapon, tables: ViewModelTables) {
        self.model = model
        self.def = def
        let root = model.root
        root.position = .zero
        root.quaternion = .identity
        root.updateMatrixWorld()
        let inverseRoot = root.matrixWorld.inverse

        // Aimed: holder * sight = identity, so the eye sits exactly on the sight anchor.
        let sight = RMat.decompose(inverseRoot * model.sight.matrixWorld)
        aimQuaternion = sight.quaternion.inverse
        aimPosition = -aimQuaternion.rotate(sight.position)

        let handling = tables.handling[def.weaponClass]
        let hip = handling?.hip ?? [0, 0, 0], tilt = handling?.hipTilt ?? [0, 0, 0]
        hipPosition = hip.vec3
        hipQuaternion = RQuat.eulerYXZ(tilt[0], tilt[1], tilt[2])

        barrelLength = max(0.05, -RMat.position(inverseRoot * model.muzzle.matrixWorld).z)
        let trigger = RMat.decompose(inverseRoot * model.gripTrigger.matrixWorld)
        triggerRest = trigger.position
        triggerRestQuaternion = trigger.quaternion

        switch def.reloadStyle {
        case "belt": awayNode = model.parts["cover"] ?? model.parts["magazine"]
        default: awayNode = model.parts["magazine"]
        }
        root.add(triggerTarget)
        root.add(supportTarget)
        parts = PartsAnimator(model: model, def: def, constants: tables.parts)
        updateHands()
    }

    /// Place the hand targets for this frame, after the parts and the holder have moved and world matrices are current.
    public func updateHands() {
        let inverseRoot = model.root.matrixWorld.inverse
        let support = RMat.decompose(inverseRoot * model.gripSupport.matrixWorld)
        supportTarget.position = support.position
        supportTarget.quaternion = support.quaternion
        if let awayNode, parts.supportAway > 0.001 {
            let away = RMat.position(inverseRoot * awayNode.matrixWorld)
            supportTarget.position += (away - supportTarget.position) * parts.supportAway
        }
        triggerTarget.position = triggerRest
        triggerTarget.quaternion = triggerRestQuaternion
        if let bolt = model.parts["bolt"], parts.triggerAway > 0.001 {
            let at = RMat.position(inverseRoot * bolt.matrixWorld)
            triggerTarget.position += (at - triggerTarget.position) * parts.triggerAway
        }
        triggerTarget.updateMatrixWorld()
        supportTarget.updateMatrixWorld()
    }
}
