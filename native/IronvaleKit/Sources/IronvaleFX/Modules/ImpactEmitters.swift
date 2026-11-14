// Ported from src/fx/impact-emitters.ts at commit a487033.
import Darwin

/// The building blocks impacts are made of; `amount` scales how many particles each call launches.
final class ImpactEmitters {
    static let gravity = 9.81
    /// Light on this impact's dust and on its solid debris. Set before emitting.
    var dustLight = D3.zero
    var debrisLight = D3.zero
    private unowned let env: FxEnv
    private unowned let lit: ParticlePool
    private unowned let glow: ParticlePool
    private unowned let rings: Rings

    init(env: FxEnv, lit: ParticlePool, glow: ParticlePool, rings: Rings) {
        self.env = env
        self.lit = lit
        self.glow = glow
        self.rings = rings
    }

    @inline(__always) private func count(_ base: Double, _ amount: Double) -> Int { scaledCount(base, amount, env.random.next()) }

    /// Slow, lingering cloud that the wind carries off.
    func dust(_ point: D3, _ normal: D3, _ amount: Double, _ base: Double, _ speed: Double, _ size: Double, _ life: Double, _ alpha: Double) {
        let r = env.random
        var s = lit.spawn
        var i = count(base, amount)
        while i > 0 {
            defer { i -= 1 }
            let dir = r.inCone(normal, 0.55)
            let launch = speed * r.range(0.3, 1)
            s.at(point.adding(normal, 0.04))
            s.velocity(dir * launch)
            s.life = life * r.range(0.7, 1.3)
            s.size = size * r.range(0.3, 0.42)
            s.sizeEnd = size * r.range(0.85, 1.3)
            s.rotation = r.range(-0.6, 0.6)
            s.spin = r.range(-0.25, 0.25)
            let tone = r.range(0.85, 1.1)
            s.color(dustLight, tone)
            s.a = alpha * r.range(0.75, 1)
            s.sprite = r.next() < 0.5 ? Sprite.puffA : Sprite.puffB
            s.gravity = 0.1
            s.drag = r.range(3, 4.6)
            s.stretch = 0
            lit.emit(s)
        }
    }

    /// Dense, short jet straight off the surface in the first instant.
    func burst(_ point: D3, _ axis: D3, _ amount: Double, _ base: Double, _ speed: Double, _ size: Double, _ life: Double, _ alpha: Double) {
        let r = env.random
        var s = lit.spawn
        var i = count(base, amount)
        while i > 0 {
            defer { i -= 1 }
            let dir = r.inCone(axis, 0.3)
            let launch = speed * r.range(0.5, 1)
            s.at(point.adding(axis, 0.04))
            s.velocity(dir * launch)
            s.life = life * r.range(0.75, 1.25)
            s.size = size * r.range(0.22, 0.35)
            s.sizeEnd = size * r.range(0.9, 1.3)
            s.rotation = r.range(-0.6, 0.6)
            s.spin = r.range(-0.5, 0.5)
            s.color(dustLight, 0.9)
            s.a = alpha
            s.sprite = Sprite.puffB
            s.gravity = 1.2
            s.drag = 4.5
            s.stretch = 0
            lit.emit(s)
        }
    }

    /// Solid fragments that tumble and fall.
    func debris(_ point: D3, _ normal: D3, _ amount: Double, _ base: Double, _ speed: Double, _ size: Double, _ sprite: Int) {
        let r = env.random
        var s = lit.spawn
        var i = count(base, amount)
        while i > 0 {
            defer { i -= 1 }
            let dir = r.inCone(normal, 0.85)
            let launch = speed * r.range(0.3, 1)
            s.at(point.adding(normal, 0.02))
            s.vx = dir.x * launch
            s.vy = dir.y * launch + 0.6
            s.vz = dir.z * launch
            s.life = r.range(0.5, 0.95)
            s.size = size * r.range(0.5, 1.3)
            s.sizeEnd = s.size
            s.rotation = r.range(0, .pi * 2)
            s.spin = r.range(-14, 14)
            let tone = r.range(0.3, 0.85)
            s.color(debrisLight, tone)
            s.a = 1
            s.sprite = sprite
            s.gravity = Self.gravity
            s.drag = 0.7
            s.stretch = 0
            lit.emit(s)
        }
    }

    /// Sprays of small grains; each sprite carries several.
    func grit(_ point: D3, _ axis: D3, _ amount: Double, _ base: Double, _ speed: Double) {
        let r = env.random
        var s = lit.spawn
        var i = count(base, amount)
        while i > 0 {
            defer { i -= 1 }
            let dir = r.inCone(axis, 0.6)
            let launch = speed * r.range(0.45, 1)
            s.at(point.adding(axis, 0.03))
            s.velocity(dir * launch)
            s.life = r.range(0.6, 1.05)
            s.size = r.range(0.1, 0.16)
            s.sizeEnd = s.size * 2.4
            s.rotation = r.range(0, .pi * 2)
            s.spin = r.range(-3, 3)
            s.color(debrisLight, 0.6)
            s.a = 1
            s.sprite = Sprite.grains
            s.gravity = Self.gravity
            s.drag = 1.1
            s.stretch = 0
            lit.emit(s)
        }
    }

    /// Thin, bright streaks that arc under gravity and die quickly.
    func sparks(_ point: D3, _ normal: D3, _ amount: Double, _ base: Double, _ sun: Double) {
        let r = env.random
        var s = glow.spawn
        let gain = 1 + sun * 0.6
        var i = count(base, amount)
        while i > 0 {
            defer { i -= 1 }
            let dir = r.inCone(normal, 0.8)
            let launch = r.range(4, 13)
            s.at(point.adding(normal, 0.01))
            s.vx = dir.x * launch
            s.vy = dir.y * launch + 0.8
            s.vz = dir.z * launch
            s.life = r.range(0.16, 0.55)
            s.size = r.range(0.016, 0.026)
            s.sizeEnd = s.size * 0.5
            s.rotation = 0
            s.spin = 0
            let heat = r.range(0.6, 1)
            s.r = 22 * gain * heat
            s.g = 12 * gain * heat * heat
            s.b = 3.6 * gain * heat * heat * heat
            s.a = 1
            s.sprite = Sprite.streak
            s.gravity = Self.gravity
            s.drag = 1.7
            s.stretch = 0.03
            glow.emit(s)
        }
    }

    /// One-frame flash at the strike point.
    func flare(_ point: D3, _ normal: D3, _ size: Double) {
        let r = env.random
        var s = glow.spawn
        s.at(point.adding(normal, 0.03))
        s.vx = 0; s.vy = 0; s.vz = 0
        s.life = 0.07
        s.size = size * r.range(0.8, 1.2)
        s.sizeEnd = s.size * 1.5
        s.rotation = r.range(0, .pi * 2)
        s.spin = 0
        s.r = 9; s.g = 6.5; s.b = 3.2
        s.a = 1
        s.sprite = Sprite.flare
        s.gravity = 0
        s.drag = 1
        s.stretch = 0
        glow.emit(s)
    }

    func shards(_ point: D3, _ normal: D3, _ amount: Double, _ base: Double, _ sun: Double) {
        debris(point, normal, amount, base, 3.6, 0.06, Sprite.shard)
        if sun == 0 { return }
        let r = env.random
        var s = glow.spawn
        var i = count(3, amount)
        while i > 0 {
            defer { i -= 1 }
            let dir = r.inCone(normal, 0.85)
            let launch = r.range(1.5, 3.6)
            s.at(point)
            s.vx = dir.x * launch
            s.vy = dir.y * launch + 0.6
            s.vz = dir.z * launch
            s.life = r.range(0.2, 0.45)
            s.size = r.range(0.03, 0.05)
            s.sizeEnd = s.size * 0.3
            s.rotation = 0
            s.spin = 0
            s.color(env.sunLight, 4)
            s.a = 1
            s.sprite = Sprite.glow
            s.gravity = Self.gravity
            s.drag = 0.7
            s.stretch = 0
            glow.emit(s)
        }
    }

    func leaves(_ point: D3, _ axis: D3, _ amount: Double, _ base: Double) {
        let r = env.random
        var s = lit.spawn
        var i = count(base, amount)
        while i > 0 {
            defer { i -= 1 }
            let dir = r.inCone(axis, 0.9)
            let launch = r.range(0.8, 2.2)
            s.at(point)
            s.vx = dir.x * launch
            s.vy = dir.y * launch + 0.5
            s.vz = dir.z * launch
            s.life = r.range(1.1, 1.9)
            s.size = r.range(0.045, 0.08)
            s.sizeEnd = s.size
            s.rotation = r.range(0, .pi * 2)
            s.spin = r.range(-7, 7)
            let tone = r.range(0.7, 1.2)
            s.color(debrisLight, tone)
            s.a = 1
            s.sprite = Sprite.leaf
            s.gravity = 2.6
            s.drag = 2.6
            s.stretch = 0
            lit.emit(s)
        }
    }

    /// Water: a short column, thrown droplets and two rings spreading on the surface.
    func splash(_ point: D3, _ normal: D3, _ amount: Double) {
        let r = env.random
        var s = lit.spawn
        var i = count(3, amount)
        while i > 0 {
            defer { i -= 1 }
            let rise = r.range(2.2, 3.6)
            s.at(point.adding(normal, 0.1))
            s.vx = normal.x * rise + r.range(-0.3, 0.3)
            s.vy = normal.y * rise
            s.vz = normal.z * rise + r.range(-0.3, 0.3)
            s.life = r.range(0.4, 0.6)
            s.size = r.range(0.2, 0.3)
            s.sizeEnd = s.size * 2.8
            s.rotation = r.range(-0.25, 0.25)
            s.spin = 0
            s.color(dustLight)
            s.a = 0.9
            s.sprite = Sprite.splash
            s.gravity = 6
            s.drag = 1.2
            s.stretch = 0
            lit.emit(s)
        }
        i = count(8, amount)
        while i > 0 {
            defer { i -= 1 }
            let dir = r.inCone(normal, 0.5)
            let launch = r.range(2, 4.8)
            s.at(point)
            s.velocity(dir * launch)
            s.life = r.range(0.45, 0.8)
            s.size = r.range(0.02, 0.035)
            s.sizeEnd = s.size
            s.rotation = 0
            s.spin = 0
            s.color(debrisLight)
            s.a = 0.85
            s.sprite = Sprite.streak
            s.gravity = Self.gravity
            s.drag = 0.5
            s.stretch = 0.018
            lit.emit(s)
        }
        rings.add(point, normal, 0.12, 1.1, 0.9, 0.55, 0)
        rings.add(point, normal, 0.1, 0.75, 0.9, 0.4, 0.16)
    }
}
