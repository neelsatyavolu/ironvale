// Ported from src/fx/blood.ts at commit a487033.
import Darwin

/// A brief dark mist and a few drops where a bullet hits someone. Kept small.
final class Blood {
    static let mist = (0.15, 0.012, 0.01)
    static let drops = (0.11, 0.008, 0.006)
    static let maxDistance = 90.0
    private unowned let env: FxEnv
    private unowned let lit: ParticlePool

    init(env: FxEnv, lit: ParticlePool) {
        self.env = env
        self.lit = lit
    }

    func onHit(targetId: Int, point: D3, direction travel: D3, fatal: Bool) {
        guard env.live else { return }
        // Nothing is drawn for hits on the player: it would only fill the screen.
        if targetId == env.player.id { return }
        if env.camera.position.distance(point) > Self.maxDistance { return }
        var direction = travel
        if direction.lengthSq < 1e-6 { direction = D3(0, 0, -1) }
        direction = direction.normalized()

        let r = env.random
        let density = env.particleDensity
        let sun = env.sunAt(point, nil)
        let mist = env.shade(Self.mist.0, Self.mist.1, Self.mist.2, sun)
        let drops = env.shade(Self.drops.0, Self.drops.1, Self.drops.2, sun)
        var s = lit.spawn

        var i = scaledCount(3, density, r.next())
        while i > 0 {
            defer { i -= 1 }
            // Most of the mist carries on with the bullet; one puff comes back toward the shooter.
            let forward = i > 1 ? 1.0 : -0.45
            let dir = r.inCone(direction, 0.35)
            let speed = r.range(1.2, 3) * forward
            s.at(point)
            s.velocity(dir * speed)
            s.life = r.range(0.3, 0.5)
            s.size = r.range(0.05, 0.08)
            s.sizeEnd = r.range(0.22, 0.34)
            s.rotation = r.range(0, .pi * 2)
            s.spin = r.range(-1, 1)
            s.color(mist)
            s.a = r.range(0.5, 0.7)
            s.sprite = Sprite.puffB
            s.gravity = 1.5
            s.drag = 5
            s.stretch = 0
            lit.emit(s)
        }

        i = scaledCount(fatal ? 5 : 3, density, r.next())
        while i > 0 {
            defer { i -= 1 }
            let dir = r.inCone(direction, 0.5)
            let speed = r.range(1.5, 4)
            s.at(point)
            s.vx = dir.x * speed
            s.vy = dir.y * speed + 0.8
            s.vz = dir.z * speed
            s.life = r.range(0.4, 0.7)
            s.size = r.range(0.012, 0.022)
            s.sizeEnd = s.size
            s.rotation = 0
            s.spin = 0
            s.color(drops)
            s.a = 0.9
            s.sprite = Sprite.streak
            s.gravity = 9.81
            s.drag = 0.6
            s.stretch = 0.02
            lit.emit(s)
        }
    }
}
