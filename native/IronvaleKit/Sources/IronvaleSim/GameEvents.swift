// Ported from src/game/contracts.ts (`GameEvents`, combat types) and src/core/events.ts at commit
// 185029e. Events are values, emitted synchronously in the order the TypeScript emits them: the net
// layer relies on `shotFired` arriving before its `bulletTrace`s (weapons map 2, 4.2).
import IronvaleContract
import IronvaleWorld

public enum Team: String, Sendable, CaseIterable { case alpha, bravo }
public enum HitZone: String, Sendable, CaseIterable { case head, torso, limb }
public enum CombatantKind: String, Sendable { case local, bot, remote }

public struct CombatantHit: Sendable, Equatable {
    public let distance: Double
    public let zone: HitZone
    public let point: Vec3
}

public struct DamageInfo: Sendable, Equatable {
    public let amount: Double
    public let zone: HitZone
    public let attackerId: Int
    public let weaponId: String
    public let point: Vec3
    /// Direction the damage travelled.
    public let direction: Vec3
}

/// Anyone who can be shot: the player, bots, remote players (`Combatant` in contracts.ts).
public protocol Combatant: AnyObject {
    var id: Int { get }
    var kind: CombatantKind { get }
    var team: Team { get }
    var name: String { get }
    var position: Vec3 { get }
    var velocity: Vec3 { get }
    var alive: Bool { get }
    var crouching: Bool { get }
    func eyePosition() -> Vec3
    func hitTest(origin: Vec3, direction: Vec3, maxDistance: Double) -> CombatantHit?
    func applyDamage(_ info: DamageInfo)
}

public struct ShotResult {
    public let world: RayHit?
    public let combatant: (any Combatant)?
    public let combatantHit: CombatantHit?
    public let end: Vec3
    public let distance: Double

    public init(world: RayHit?, combatant: (any Combatant)?, combatantHit: CombatantHit?, end: Vec3, distance: Double) {
        self.world = world
        self.combatant = combatant
        self.combatantHit = combatantHit
        self.end = end
        self.distance = distance
    }
}

public enum GameEvent: Sendable {
    case shotFired(shooterId: Int, weapon: String, muzzle: Vec3, direction: Vec3, local: Bool)
    case bulletTrace(shooterId: Int, weapon: String, from: Vec3, to: Vec3, local: Bool)
    case bulletImpact(shooterId: Int, weapon: String, hit: RayHit)
    case combatantHit(weapon: String, targetId: Int, attackerId: Int, hit: CombatantHit, direction: Vec3, fatal: Bool)
    case nearMiss(point: Vec3, direction: Vec3, weapon: String)
    case dryFire(shooterId: Int, weapon: String, position: Vec3)
    case weaponAction(shooterId: Int, weapon: String, stage: String, position: Vec3, local: Bool)
    case weaponSwitch(shooterId: Int, weapon: String, local: Bool)
    case casingEjected(kind: String, position: Vec3, velocity: Vec3)
    case aimChanged(aiming: Bool, weapon: String)
    case footstep(ownerId: Int, position: Vec3, surface: Surface, running: Bool, local: Bool)
    case jumped(ownerId: Int, position: Vec3, local: Bool)
    case landed(ownerId: Int, position: Vec3, surface: Surface, speed: Double, local: Bool)
    case playerHurt(amount: Double, health: Double, direction: Vec3)
    case died(victimId: Int, killerId: Int, weaponId: String, headshot: Bool)
    case spawned(combatantId: Int)
    case grenadeThrown(ownerId: Int, position: Vec3, velocity: Vec3, local: Bool)
    case grenadeBounced(ownerId: Int, position: Vec3, speed: Double, surface: Surface)
    case grenadeExploded(ownerId: Int, position: Vec3, local: Bool)

    /// The `GameEvents` key.
    public var name: String {
        switch self {
        case .shotFired: "shotFired"
        case .bulletTrace: "bulletTrace"
        case .bulletImpact: "bulletImpact"
        case .combatantHit: "combatantHit"
        case .nearMiss: "nearMiss"
        case .dryFire: "dryFire"
        case .weaponAction: "weaponAction"
        case .weaponSwitch: "weaponSwitch"
        case .casingEjected: "casingEjected"
        case .aimChanged: "aimChanged"
        case .footstep: "footstep"
        case .jumped: "jumped"
        case .landed: "landed"
        case .playerHurt: "playerHurt"
        case .died: "died"
        case .spawned: "spawned"
        case .grenadeThrown: "grenadeThrown"
        case .grenadeBounced: "grenadeBounced"
        case .grenadeExploded: "grenadeExploded"
        }
    }
}

/// `EventBus`: synchronous, handlers run in subscription order on a snapshot of the list.
public final class EventBus {
    public typealias Handler = (GameEvent) -> Void
    private var handlers: [(id: Int, handler: Handler)] = []
    private var nextId = 0

    public init() {}

    /// Returns an unsubscribe closure.
    @discardableResult
    public func on(_ handler: @escaping Handler) -> () -> Void {
        let id = nextId
        nextId += 1
        handlers.append((id, handler))
        return { [weak self] in self?.handlers.removeAll { $0.id == id } }
    }

    public func emit(_ event: GameEvent) {
        for entry in handlers { entry.handler(event) }
    }

    public func clear() { handlers.removeAll() }
}
