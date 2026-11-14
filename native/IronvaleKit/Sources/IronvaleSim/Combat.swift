// Ported from src/game/combat.ts at commit 185029e.
import IronvaleWorld

/// What ballistics needs from the combat registry; `Combat` is the real one, tests stub it.
public protocol ShotResolver: AnyObject {
    func get(_ id: Int) -> (any Combatant)?
    func raycast(origin: Vec3, direction: Vec3, maxDistance: Double, ignoreId: Int, ignoreTeam: Team?) -> ShotResult
}

/// Tracks every combatant and resolves bullets against the world and bodies.
public final class Combat: ShotResolver {
    /// Insertion order, as a JS `Map` iterates.
    private var combatants: [any Combatant] = []
    private var nextId = 1
    private let world: () -> CollisionWorld?

    public init(world: @escaping () -> CollisionWorld?) {
        self.world = world
    }

    public func allocateId() -> Int {
        defer { nextId += 1 }
        return nextId
    }

    public func add(_ combatant: any Combatant) {
        if let index = combatants.firstIndex(where: { $0.id == combatant.id }) {
            combatants[index] = combatant
        } else {
            combatants.append(combatant)
        }
    }

    public func remove(_ id: Int) { combatants.removeAll { $0.id == id } }
    public func get(_ id: Int) -> (any Combatant)? { combatants.first { $0.id == id } }
    public func all() -> [any Combatant] { combatants }
    public func enemies(of team: Team) -> [any Combatant] { combatants.filter { $0.alive && $0.team != team } }
    public func clear() { combatants.removeAll() }

    public func raycast(origin: Vec3, direction: Vec3, maxDistance: Double, ignoreId: Int, ignoreTeam: Team?) -> ShotResult {
        let worldHit = world()?.raycast(origin: origin, direction: direction, maxDistance: maxDistance)
        var limit = worldHit?.distance ?? maxDistance
        var struck: (any Combatant)?
        var struckHit: CombatantHit?
        for combatant in combatants {
            if !combatant.alive || combatant.id == ignoreId || combatant.team == ignoreTeam { continue }
            guard let hit = combatant.hitTest(origin: origin, direction: direction, maxDistance: limit) else { continue }
            limit = hit.distance
            struck = combatant
            struckHit = hit
        }
        return ShotResult(
            world: struck == nil ? worldHit : nil,
            combatant: struck,
            combatantHit: struckHit,
            end: origin.adding(direction, scaledBy: limit),
            distance: limit
        )
    }
}
