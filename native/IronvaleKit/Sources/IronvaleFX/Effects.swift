// Ported from src/fx/index.ts (createEffects) at commit a487033: builds the pools and modules in the
// web's order, routes GameEvents to them in the web's subscription order, and steps them once a
// frame. Everything the GPU reads lives in FloatStores the modules write in place (FXLayer draws).
import IronvaleContract
import IronvaleSim
import IronvaleWorld

public final class Effects {
    /// index.ts LIT_CAPACITY and GLOW_CAPACITY.
    public static let litCapacity = 1536
    public static let glowCapacity = 640

    public let env: FxEnv
    public let lit: ParticlePool
    public let glow: ParticlePool
    public let rings: Rings
    public let decals: Decals
    public let tracers: Tracers
    public let muzzle: Muzzle
    public let casings: Casings
    public let grenade: GrenadeFx
    public let weather: WeatherFx
    let impacts: Impacts
    let blood: Blood
    let nearMiss: NearMiss
    private let weapons: [String: FXWeapon]
    /// The web's ?freeze: the effect clock holds still (index.ts `visualsFrozen ? 0 : dt`).
    public var frozen = false
    /// casingLanded events, for audio.
    public var onCasingLanded: ((CasingKind, D3, Surface) -> Void)? {
        get { casings.onLanded }
        set { casings.onLanded = newValue }
    }
    private var noFlights = [GrenadeView]()

    /// `weapons`: the effects' view of every weapon id; `grenades`: the grenade figures (GRENADE) for
    /// the aim arc, body size and blast shake.
    public init(weapons: [String: FXWeapon], grenades: GrenadeMath, particleDensity: Double, detailDensity: Double,
                random: FXRandom = FXRandom(seed: 0x9e3779b9)) {
        env = FxEnv(particleDensity: particleDensity, detailDensity: detailDensity, random: random)
        self.weapons = weapons
        lit = ParticlePool(env: env, capacity: Self.litCapacity, additive: false, fadePower: 1.5)
        glow = ParticlePool(env: env, capacity: Self.glowCapacity, additive: true, fadePower: 0.6)
        rings = Rings(env: env)
        decals = Decals(env: env)
        tracers = Tracers(env: env)
        weather = WeatherFx(env: env, lit: lit, rings: rings)
        muzzle = Muzzle(env: env, lit: lit)
        impacts = Impacts(env: env, lit: lit, glow: glow, rings: rings, decals: decals)
        blood = Blood(env: env, lit: lit)
        casings = Casings(env: env)
        nearMiss = NearMiss(env: env, tracers: tracers, lit: lit)
        grenade = GrenadeFx(env: env, lit: lit, glow: glow, rings: rings, decals: decals, math: grenades)
        noFlights.reserveCapacity(GrenadeFx.bodyCount)
    }

    /// The effects' view of the contract's weapons.
    public static func weapons(from table: WeaponsTable) -> [String: FXWeapon] {
        var out: [String: FXWeapon] = [:]
        for def in table.weapons + [table.grenadeDef] {
            guard let weaponClass = WeaponClass(rawValue: def.weaponClass) else { continue }
            out[def.id] = FXWeapon(weaponClass: weaponClass, pellets: Int(def.pellets), muzzleVelocity: def.muzzleVelocity)
        }
        return out
    }

    public func enterMap(lighting: FXLighting, weather: Weather, interiors: [FXBox], world: CollisionWorld?) {
        env.world = world
        env.setMap(lighting: lighting, weather: weather)
        self.weather.enterMap(weather: weather, interiors: interiors)
    }

    public func leaveMap() {
        env.live = false
        muzzle.clear()
        casings.clear()
        nearMiss.clear()
        grenade.clear()
        weather.clear()
        decals.clear()
        tracers.clear()
        lit.clear()
        glow.clear()
        rings.clear()
    }

    /// One frame (index.ts update): advance the clock, every module in order, then the pools.
    /// `aim`: the grenade being aimed (hand origin and throw velocity), for the preview arc.
    public func update(_ dt: Double, flights: UnsafeBufferPointer<GrenadeView>? = nil, aim: (origin: D3, velocity: D3)? = nil) {
        let step = frozen ? 0 : dt
        env.advance(step)
        muzzle.update(step)
        casings.update(step)
        if let flights { grenade.update(step, flights: flights, aim: aim) } else {
            noFlights.withUnsafeBufferPointer { grenade.update(step, flights: $0, aim: aim) }
        }
        let shake = grenade.shakeOffset
        if shake != (0, 0, 0, 0) { env.camera.shake(shake.x, shake.y, shake.z, shake.drop) }
        weather.update(step)
        _ = tracers.flush()
        _ = lit.flush()
        _ = glow.flush()
        _ = rings.flush()
    }

    // MARK: - Events, in each GameEvents key's subscription order of index.ts

    public func shotFired(weapon: FXWeapon, muzzle at: D3, direction: D3, local: Bool) {
        muzzle.onShot(weapon: weapon, muzzle: at, direction: direction, local: local)
    }

    public func bulletTrace(weapon: FXWeapon, from: D3, to: D3, local: Bool) {
        nearMiss.onTrace(from: from, to: to, local: local)
        tracers.onTrace(weapon: weapon, from: from, to: to, local: local)
    }

    public func bulletImpact(weapon: FXWeapon, point: D3, normal: D3, surface: Surface) {
        impacts.onImpact(weapon: weapon, point: point, normal: normal, surface: surface)
    }

    public func combatantHit(targetId: Int, point: D3, direction: D3, fatal: Bool) {
        blood.onHit(targetId: targetId, point: point, direction: direction, fatal: fatal)
    }

    public func nearMiss(point: D3) { nearMiss.onNearMiss(point: point) }

    public func casingEjected(kind: CasingKind, position: D3, velocity: D3) {
        casings.onEjected(kind: kind, position: position, velocity: velocity)
    }

    public func grenadeExploded(position: D3) { grenade.onExploded(position: position) }

    /// Routes one IronvaleSim GameEvent (EventBus subscriber).
    public func handle(_ event: GameEvent) {
        switch event {
        case let .shotFired(_, weapon, muzzle, direction, local):
            guard let w = weapons[weapon] else { return }
            shotFired(weapon: w, muzzle: D3(muzzle), direction: D3(direction), local: local)
        case let .bulletTrace(_, weapon, from, to, local):
            guard let w = weapons[weapon] else { return }
            bulletTrace(weapon: w, from: D3(from), to: D3(to), local: local)
        case let .bulletImpact(_, weapon, hit):
            guard let w = weapons[weapon] else { return }
            bulletImpact(weapon: w, point: D3(hit.point), normal: D3(hit.normal), surface: hit.surface)
        case let .combatantHit(_, targetId, _, hit, direction, fatal):
            combatantHit(targetId: targetId, point: D3(hit.point), direction: D3(direction), fatal: fatal)
        case let .nearMiss(point, _, _):
            nearMiss(point: D3(point))
        case let .casingEjected(kind, position, velocity):
            guard let k = CasingKind(rawValue: kind) else { return }
            casingEjected(kind: k, position: D3(position), velocity: D3(velocity))
        case let .grenadeExploded(_, position, _):
            grenadeExploded(position: D3(position))
        default:
            break
        }
    }
}
