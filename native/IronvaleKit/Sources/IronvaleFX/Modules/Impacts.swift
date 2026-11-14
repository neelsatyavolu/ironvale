// Ported from src/fx/impacts.ts at commit a487033.
import Darwin
import IronvaleWorld

/// Dust, chips, sparks and splashes where bullets land, chosen by the surface that was hit.
final class Impacts {
    static let lodSteps: [(Double, Double)] = [(35, 1), (70, 0.55), (140, 0.25)]
    static let pelletScale = 0.45
    static let wetDust = 0.55

    private let emit: ImpactEmitters
    private unowned let env: FxEnv
    private unowned let decals: Decals

    init(env: FxEnv, lit: ParticlePool, glow: ParticlePool, rings: Rings, decals: Decals) {
        self.env = env
        self.decals = decals
        emit = ImpactEmitters(env: env, lit: lit, glow: glow, rings: rings)
    }

    func onImpact(weapon: FXWeapon, point: D3, normal: D3, surface: Surface) {
        guard env.live else { return }
        let look = SurfaceLook.of(surface)
        if look.family == .none { return }
        let distance = env.camera.position.distance(point)
        var amount = 0.0
        for (limit, scale) in Self.lodSteps where distance < limit {
            amount = scale
            break
        }
        let pellets = weapon.pellets > 1
        if let decal = look.decal { decals.add(decal, point, normal, pellets ? 0.6 : 1) }
        if amount == 0 { return }
        amount *= env.particleDensity * (pellets ? Self.pelletScale : 1)
        let dustiness = look.dustiness * (env.weather == .rain ? Self.wetDust : 1)

        let sun = env.sunAt(point, normal)
        emit.dustLight = env.shade(look.dust.x, look.dust.y, look.dust.z, sun)
        emit.debrisLight = env.shade(look.debris.x, look.debris.y, look.debris.z, sun)

        switch look.family {
        case .masonry:
            emit.dust(point, normal, amount * dustiness, 6, 2.8, 0.95, 2.3, 0.6)
            emit.burst(point, normal, amount, 3, 5.5, 0.5, 0.5, 0.8)
            emit.debris(point, normal, amount, 7, 4.5, 0.05, Sprite.chipA)
            emit.grit(point, normal, amount, 2, 3.2)
        case .metal:
            emit.sparks(point, normal, amount, 12, sun)
            emit.flare(point, normal, 0.17)
            emit.dust(point, normal, amount * dustiness, 4, 1.8, 0.5, 1.1, 0.4)
        case .wood:
            emit.debris(point, normal, amount, 7, 4, 0.11, Sprite.splinter)
            emit.debris(point, normal, amount, 3, 3, 0.03, Sprite.chipB)
            emit.dust(point, normal, amount * dustiness, 5, 2.2, 0.75, 1.8, 0.5)
        case .soil:
            // Earth is thrown up more than out, whatever the slope.
            let axis = normal.lerp(.up, 0.45).normalized()
            emit.burst(point, axis, amount, 5, 4.2, 0.8, 0.95, 0.85)
            emit.grit(point, axis, amount, 7, 4.8)
            emit.dust(point, axis, amount * dustiness, 3, 1.6, 1, 2.4, 0.42)
            if surface == .grass { emit.leaves(point, axis, amount, 3) }
        case .water:
            emit.splash(point, normal, amount)
        case .glass:
            emit.shards(point, normal, amount, 10, sun)
            emit.dust(point, normal, amount * dustiness, 2, 1.6, 0.4, 0.7, 0.2)
        case .foliage:
            emit.leaves(point, normal, amount, 6)
            emit.dust(point, normal, amount * dustiness, 2, 0.9, 0.4, 0.8, 0.3)
        case .none:
            break
        }
    }
}
