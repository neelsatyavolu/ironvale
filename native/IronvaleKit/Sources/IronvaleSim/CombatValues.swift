// Public constructors for the combat values another module builds: IronvaleNet applies hits that
// arrive from the other machine (src/net/match.ts onRemoteHit) and replays their combatantHit
// events. (The memberwise initialisers are internal and cannot be redeclared public.)
import IronvaleWorld

public extension DamageInfo {
    static func make(amount: Double, zone: HitZone, attackerId: Int, weaponId: String, point: Vec3, direction: Vec3) -> DamageInfo {
        DamageInfo(amount: amount, zone: zone, attackerId: attackerId, weaponId: weaponId, point: point, direction: direction)
    }
}

public extension CombatantHit {
    static func make(distance: Double, zone: HitZone, point: Vec3) -> CombatantHit {
        CombatantHit(distance: distance, zone: zone, point: point)
    }
}
