// Ported from src/fx/grenade.ts and src/fx/grenade-blast.ts at commit a487033. The aim-preview arc
// (grenade-arc.ts) is GrenadeArc.swift.
import Darwin
import IronvaleSim
import IronvaleWorld

/// What the effects read of one grenade in flight (IronvaleSim GrenadeFlight).
public struct GrenadeView: Sendable {
    public var active: Bool
    public var position: D3
    public var speed: Double
    public var resting: Bool

    public init(active: Bool, position: D3, speed: Double, resting: Bool) {
        self.active = active
        self.position = position
        self.speed = speed
        self.resting = resting
    }
}

/// Grenade bodies in flight, the blast, and the jolt it gives the view.
public final class GrenadeFx {
    /// GRENADE.radius * 1.15 (weapons.json `grenade.radius`).
    public let bodyRadius: Double
    static let shakeSeconds = 0.5
    static let shakeAngle = 0.04
    static let shakeDrop = 0.035
    public static let bodyCount = 4

    /// Per body: 16 floats of instance matrix (zero scale when hidden).
    public let matrices = FloatStore(count: GrenadeFx.bodyCount * 16)
    private var rotations = [D3](repeating: .zero, count: GrenadeFx.bodyCount)
    private var shake = 0.0
    private var shakeStrength = 0.0
    /// This frame's view jolt: Euler x, y, z (radians, added to the camera's) and a drop in metres.
    public private(set) var shakeOffset = (x: 0.0, y: 0.0, z: 0.0, drop: 0.0)
    private let blast: GrenadeBlast
    public let arc: GrenadeArc
    private let shakeAt: (Double) -> Double
    private unowned let env: FxEnv

    init(env: FxEnv, lit: ParticlePool, glow: ParticlePool, rings: Rings, decals: Decals, math: GrenadeMath) {
        self.env = env
        bodyRadius = math.g.radius * 1.15
        shakeAt = { math.blastShake($0) }
        arc = GrenadeArc(math: math)
        blast = GrenadeBlast(env: env, lit: lit, glow: glow, rings: rings, decals: decals)
        for i in 0..<Self.bodyCount { M4.hidden(into: matrices.row(i, 16)) }
    }

    func update(_ dt: Double, flights: UnsafeBufferPointer<GrenadeView>, aim: (origin: D3, velocity: D3)?) {
        if let aim, env.player.alive {
            arc.show(origin: aim.origin, velocity: aim.velocity, camera: env.camera, world: env.world)
        } else {
            arc.hide()
        }
        for i in 0..<Self.bodyCount {
            guard i < flights.count, flights[i].active else {
                M4.hidden(into: matrices.row(i, 16))
                continue
            }
            let flight = flights[i]
            if !flight.resting {
                // Tumble end over end at about the rate a rolling grenade would.
                rotations[i].x += (flight.speed / bodyRadius) * dt * 0.35
                rotations[i].z += dt * 3
            }
            let r = rotations[i]
            M4.compose(flight.position, Self.eulerXYZ(r.x, r.y, r.z), D3(1, 1, 1), into: matrices.row(i, 16))
        }
        shakeOffset = (0, 0, 0, 0)
        if shake > 0 { applyShake(dt) }
    }

    func onExploded(position: D3) {
        guard env.live else { return }
        blast.emit(position)
        let strength = shakeAt(env.camera.position.distance(position))
        if strength <= 0 { return }
        shakeStrength = shake > 0 ? max(strength, shakeStrength) : strength
        shake = Self.shakeSeconds
    }

    private func applyShake(_ dt: Double) {
        shake = max(0, shake - dt)
        let fade = shake / Self.shakeSeconds
        let amount = shakeStrength * fade * fade * env.headBob
        let t = env.now
        shakeOffset = (sin(t * 71) * Self.shakeAngle * amount,
                       sin(t * 53 + 1.3) * Self.shakeAngle * 0.6 * amount,
                       sin(t * 43 + 2.1) * Self.shakeAngle * 0.8 * amount,
                       abs(sin(t * 37)) * Self.shakeDrop * amount)
        if shake == 0 { shakeStrength = 0 }
    }

    func clear() {
        shake = 0
        shakeOffset = (0, 0, 0, 0)
        arc.hide()
        for i in 0..<Self.bodyCount { M4.hidden(into: matrices.row(i, 16)) }
    }

    /// setFromEuler(x, y, z, 'XYZ').
    static func eulerXYZ(_ ex: Double, _ ey: Double, _ ez: Double) -> Quat {
        let c1 = cos(ex / 2), c2 = cos(ey / 2), c3 = cos(ez / 2)
        let s1 = sin(ex / 2), s2 = sin(ey / 2), s3 = sin(ez / 2)
        return Quat(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3)
    }
}

/// A blast: flash, fireball, smoke, dust ring, sparks, debris and a scorch mark (grenade-blast.ts).
final class GrenadeBlast {
    static let gravity = 9.81
    static let lodSteps: [(Double, Double)] = [(60, 1), (140, 0.6)]
    static let farAmount = 0.35
    static let scorchReach = 1.2
    static let scorchScales: [Double] = [24, 14, 8]
    static let smokeAlbedo = 0.1
    static let dustAlbedo = D3(0.44, 0.4, 0.34)

    private var smokeLight = D3.zero
    private var dustLight = D3.zero
    private unowned let env: FxEnv
    private unowned let lit: ParticlePool
    private unowned let glow: ParticlePool
    private unowned let rings: Rings
    private unowned let decals: Decals

    init(env: FxEnv, lit: ParticlePool, glow: ParticlePool, rings: Rings, decals: Decals) {
        self.env = env
        self.lit = lit
        self.glow = glow
        self.rings = rings
        self.decals = decals
    }

    @inline(__always) private func count(_ base: Double, _ amount: Double) -> Int { scaledCount(base, amount, env.random.next()) }

    func emit(_ point: D3) {
        let distance = env.camera.position.distance(point)
        var amount = Self.farAmount
        for (limit, scale) in Self.lodSteps where distance < limit {
            amount = scale
            break
        }
        amount *= env.particleDensity
        let lift = point.adding(.up, 0.3)
        let sun = env.sunAt(lift, nil)
        smokeLight = env.shade(Self.smokeAlbedo, Self.smokeAlbedo, Self.smokeAlbedo, sun)
        dustLight = env.shade(Self.dustAlbedo.x, Self.dustAlbedo.y, Self.dustAlbedo.z, sun)

        flash(point)
        if let ground = env.world?.raycast(origin: lift.vec3, direction: Vec3(0, -1, 0), maxDistance: Self.scorchReach + 0.3) {
            let p = D3(ground.point), n = D3(ground.normal)
            for scale in Self.scorchScales { decals.add(.soft, p, n, scale) }
            rings.add(p, n, 0.8, 12, 0.4, 0.55, 0)
        }
        fireball(point, amount)
        smoke(point, amount)
        dustRing(point, amount)
        sparks(point, amount)
        debris(point, amount)
    }

    private func flash(_ point: D3) {
        var s = glow.spawn
        s.x = point.x; s.y = point.y + 0.35; s.z = point.z
        s.vx = 0; s.vy = 0; s.vz = 0
        s.rotation = env.random.range(0, .pi * 2)
        s.spin = 0; s.gravity = 0; s.drag = 1; s.stretch = 0; s.a = 1
        s.life = 0.1; s.size = 3.2; s.sizeEnd = 6.5
        s.r = 9; s.g = 7; s.b = 4.6
        s.sprite = Sprite.glow
        glow.emit(s)
        s.life = 0.14; s.size = 2.2; s.sizeEnd = 5
        s.r = 14; s.g = 9.5; s.b = 5
        s.sprite = Sprite.flare
        glow.emit(s)
    }

    private func fireball(_ point: D3, _ amount: Double) {
        let r = env.random
        var s = glow.spawn
        var i = count(16, amount)
        while i > 0 {
            defer { i -= 1 }
            let dir = r.inCone(.up, 1)
            let launch = r.range(1.5, 7)
            s.x = point.x + dir.x * 0.25; s.y = point.y + 0.2 + dir.y * 0.25; s.z = point.z + dir.z * 0.25
            s.velocity(dir * launch)
            s.life = r.range(0.24, 0.5)
            s.size = r.range(0.8, 1.3)
            s.sizeEnd = s.size * r.range(2, 2.8)
            s.rotation = r.range(0, .pi * 2)
            s.spin = r.range(-1.5, 1.5)
            let heat = r.range(0.55, 1)
            s.r = 5.2 * heat; s.g = 2.1 * heat * heat; s.b = 0.42 * heat * heat * heat
            s.a = 0.9
            s.sprite = r.next() < 0.5 ? Sprite.puffA : Sprite.puffB
            s.gravity = -2.5
            s.drag = 5
            s.stretch = 0
            glow.emit(s)
        }
    }

    private func smoke(_ point: D3, _ amount: Double) {
        let r = env.random
        var s = lit.spawn
        var i = count(18, amount)
        while i > 0 {
            defer { i -= 1 }
            let dir = r.inCone(.up, 0.9)
            let launch = r.range(1.2, 5.5)
            s.x = point.x + dir.x * 0.3; s.y = point.y + 0.25 + dir.y * 0.3; s.z = point.z + dir.z * 0.3
            s.vx = dir.x * launch; s.vy = dir.y * launch + 0.6; s.vz = dir.z * launch
            s.life = r.range(2.4, 4.4)
            s.size = r.range(0.7, 1.1)
            s.sizeEnd = r.range(2.6, 3.8)
            s.rotation = r.range(-0.6, 0.6)
            s.spin = r.range(-0.3, 0.3)
            let tone = r.range(0.7, 1.25)
            s.color(smokeLight, tone)
            s.a = r.range(0.5, 0.78)
            s.sprite = r.next() < 0.5 ? Sprite.puffA : Sprite.puffB
            s.gravity = -0.45
            s.drag = r.range(2, 2.8)
            s.stretch = 0
            lit.emit(s)
        }
    }

    private func dustRing(_ point: D3, _ amount: Double) {
        let r = env.random
        var s = lit.spawn
        let total = count(24, amount)
        let turn = r.next() * .pi * 2
        for i in 0..<total {
            let angle = turn + (Double(i) / Double(total)) * .pi * 2 + r.range(-0.12, 0.12)
            let launch = r.range(6, 11)
            let c = cos(angle), sn = sin(angle)
            s.x = point.x + c * 0.4; s.y = point.y + 0.12; s.z = point.z + sn * 0.4
            s.vx = c * launch; s.vy = r.range(0.2, 1.3); s.vz = sn * launch
            s.life = r.range(0.9, 1.7)
            s.size = r.range(0.4, 0.7)
            s.sizeEnd = r.range(1.7, 2.5)
            s.rotation = r.range(-0.6, 0.6)
            s.spin = r.range(-0.3, 0.3)
            let tone = r.range(0.85, 1.1)
            s.color(dustLight, tone)
            s.a = r.range(0.3, 0.46)
            s.sprite = r.next() < 0.5 ? Sprite.puffA : Sprite.puffB
            s.gravity = 0.1
            s.drag = r.range(3.2, 4.2)
            s.stretch = 0
            lit.emit(s)
        }
    }

    private func sparks(_ point: D3, _ amount: Double) {
        let r = env.random
        var s = glow.spawn
        var i = count(36, amount)
        while i > 0 {
            defer { i -= 1 }
            let dir = r.inCone(.up, 1)
            let launch = r.range(8, 24)
            s.x = point.x; s.y = point.y + 0.15; s.z = point.z
            s.vx = dir.x * launch; s.vy = dir.y * launch + 1.5; s.vz = dir.z * launch
            s.life = r.range(0.3, 0.95)
            s.size = r.range(0.02, 0.036)
            s.sizeEnd = s.size * 0.5
            s.rotation = 0; s.spin = 0
            let heat = r.range(0.6, 1)
            s.r = 26 * heat; s.g = 13 * heat * heat; s.b = 3.4 * heat * heat * heat
            s.a = 1
            s.sprite = Sprite.streak
            s.gravity = Self.gravity
            s.drag = 1.2
            s.stretch = 0.03
            glow.emit(s)
        }
    }

    private func debris(_ point: D3, _ amount: Double) {
        let r = env.random
        var s = lit.spawn
        var i = count(22, amount)
        while i > 0 {
            defer { i -= 1 }
            let dir = r.inCone(.up, 0.85)
            let launch = r.range(4, 13)
            let grains = r.next() < 0.4
            s.x = point.x; s.y = point.y + 0.1; s.z = point.z
            s.velocity(dir * launch)
            s.life = r.range(0.8, 1.6)
            s.size = grains ? r.range(0.14, 0.24) : r.range(0.05, 0.11)
            s.sizeEnd = grains ? s.size * 2 : s.size
            s.rotation = r.range(0, .pi * 2)
            s.spin = r.range(-9, 9)
            s.color(dustLight, 0.45)
            s.a = 1
            s.sprite = grains ? Sprite.grains : (r.next() < 0.5 ? Sprite.chipA : Sprite.chipB)
            s.gravity = Self.gravity
            s.drag = 0.5
            s.stretch = 0
            lit.emit(s)
        }
    }
}
