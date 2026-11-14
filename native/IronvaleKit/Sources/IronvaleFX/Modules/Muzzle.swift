// Ported from src/fx/muzzle.ts and src/fx/flash-sheet.ts (FLASH cells) at commit a487033;
// Shaders/FXMuzzle.metal draws the quads, the lights join the scene's punctual lights.
import Darwin

/// Muzzle flash quads, the light they throw, and the smoke that follows.
public final class Muzzle {
    struct Shape { let cell: Int; let size: Double; let length: Double; let light: Double }
    /// flash-sheet.ts FLASH (2 x 2 sheet).
    public enum Cell { public static let grid = 2; public static let star = 0, round = 1, small = 2, jet = 3 }
    static func shape(_ c: WeaponClass) -> Shape {
        switch c {
        case .rifle: Shape(cell: Cell.star, size: 0.27, length: 0.4, light: 6)
        case .carbine: Shape(cell: Cell.star, size: 0.23, length: 0.34, light: 5.5)
        case .lmg: Shape(cell: Cell.star, size: 0.29, length: 0.42, light: 6.5)
        case .sniper: Shape(cell: Cell.star, size: 0.34, length: 0.5, light: 7.5)
        case .shotgun: Shape(cell: Cell.round, size: 0.42, length: 0.46, light: 9)
        case .smg: Shape(cell: Cell.small, size: 0.16, length: 0.22, light: 4)
        case .pistol: Shape(cell: Cell.small, size: 0.14, length: 0.18, light: 3.5)
        }
    }

    public static let maxFlashes = 8
    public static let quads = 3
    static let flashSeconds = 0.04
    static let lightSeconds = 0.06
    /// LIGHT_RANGE and LIGHT_COLOR (0xffb26b) of the pooled PointLights (decay 2).
    public static let lightRange = 10.0
    public static let lightColor = linearFromHex(0xffb26b)
    static let localLightAhead = 0.7
    static let botLightAhead = 0.3
    static let botLights = 2
    static let botEffectRange = 70.0
    /// BRIGHTNESS: the shader's gain on the flash colour.
    public static let brightness: Float = 9
    static let dimShotChance = 0.2
    static let heatPerShot = 1.0
    static let maxHeat = 12.0
    static let heatCooling = 2.6
    static let lingerSeconds = 1.3
    static let lingerInterval = 0.085
    static let lingerMinHeat = 1.5

    struct Flash {
        var active = false, local = false
        var birth = 0.0
        var position = D3.zero, direction = D3.zero
        var size = 0.0, length = 0.0
        var cell = 0
        var roll = 0.0
    }

    public struct Light: Sendable {
        /// World position and current intensity (0 when off).
        public internal(set) var position = D3.zero
        public internal(set) var intensity = 0.0
        var cameraSpace = D3.zero
        var birth = -1.0
        var peak = 0.0
        let local: Bool
    }

    /// Per quad: 16 floats of instance matrix.
    public let matrices = FloatStore(count: Muzzle.maxFlashes * Muzzle.quads * 16)
    /// Per quad: sheet cell and brightness.
    public let info = FloatStore(count: Muzzle.maxFlashes * Muzzle.quads * 2)
    public private(set) var lights: [Light] = [Light(local: true), Light(local: false), Light(local: false)]
    private var flashes = [Flash](repeating: Flash(), count: Muzzle.maxFlashes)
    private var ring = RingPool(capacity: Muzzle.maxFlashes)
    private var nextBotLight = 0
    private var anyActive = false
    private(set) var heat = 0.0
    private var sinceShot = Double.infinity
    private var lingerTimer = 0.0
    private var localMuzzle = D3.zero
    private var localDirection = D3(0, 0, -1)
    private unowned let env: FxEnv
    private unowned let lit: ParticlePool

    init(env: FxEnv, lit: ParticlePool) {
        self.env = env
        self.lit = lit
        for i in 0..<Self.maxFlashes * Self.quads { M4.hidden(into: matrices.row(i, 16)) }
    }

    func update(_ dt: Double) {
        let camera = env.camera
        let now = env.now
        if anyActive {
            anyActive = false
            for i in 0..<Self.maxFlashes where flashes[i].active {
                let progress = (now - flashes[i].birth) / Self.flashSeconds
                if progress >= 1 {
                    flashes[i].active = false
                    hide(i)
                    continue
                }
                anyActive = true
                place(i, flashes[i], progress)
            }
        }
        for i in lights.indices where lights[i].birth >= 0 {
            let progress = (now - lights[i].birth) / Self.lightSeconds
            if progress >= 1 {
                lights[i].birth = -1
                lights[i].intensity = 0
                continue
            }
            lights[i].intensity = lights[i].peak * (1 - progress) * (1 - progress)
            if lights[i].local { lights[i].position = lights[i].cameraSpace.applying(camera.quaternion) + camera.position }
        }

        heat = max(0, heat - Self.heatCooling * dt)
        sinceShot += dt
        if heat > Self.lingerMinHeat, sinceShot > 0.1, sinceShot < Self.lingerSeconds {
            lingerTimer -= dt
            if lingerTimer <= 0 {
                lingerTimer = Self.lingerInterval
                let muzzle = localMuzzle.applying(camera.quaternion) + camera.position
                let dir = localDirection.applying(camera.quaternion)
                smoke(muzzle, dir, scaledCount(1, env.particleDensity, env.random.next()), 0.25, true)
            }
        }
    }

    func onShot(weapon: FXWeapon, muzzle: D3, direction: D3, local: Bool) {
        guard env.live else { return }
        let camera = env.camera
        let shape = Self.shape(weapon.weaponClass)
        if !local, camera.position.distanceSq(muzzle) > Self.botEffectRange * Self.botEffectRange { return }

        let slot = ring.next()
        let random = env.random
        let dim = random.next() < Self.dimShotChance ? 0.45 : 1
        let scale = random.range(0.75, 1.25) * dim * (local ? 0.8 : 1)
        var flash = Flash(active: true, local: local, birth: env.now, position: muzzle, direction: direction,
                          size: shape.size * scale, length: shape.length * scale, cell: shape.cell, roll: random.range(0, .pi * 2))
        if local {
            // Keep the flash on the gun while the view turns.
            let inverse = camera.quaternion.inverse
            flash.position = (flash.position - camera.position).applying(inverse)
            flash.direction = flash.direction.applying(inverse)
            localMuzzle = flash.position
            localDirection = flash.direction
            heat = min(Self.maxHeat, heat + Self.heatPerShot)
            sinceShot = 0
        }
        flashes[slot] = flash
        anyActive = true
        place(slot, flash, 0)

        flashLight(muzzle: muzzle, direction: direction, local: local, peak: shape.light * dim)
        let wisps = local ? 1 + (heat > 4 ? 1 : 0) : 1
        smoke(muzzle, direction, scaledCount(Double(wisps), env.particleDensity, random.next()), 1, local)
    }

    private func flashLight(muzzle: D3, direction: D3, local: Bool, peak: Double) {
        let index: Int
        if local {
            index = 0
        } else {
            index = 1 + nextBotLight
            nextBotLight = (nextBotLight + 1) % Self.botLights
        }
        let position = muzzle.adding(direction, local ? Self.localLightAhead : Self.botLightAhead)
        lights[index].position = position
        lights[index].intensity = peak
        lights[index].peak = peak
        lights[index].birth = env.now
        if lights[index].local {
            lights[index].cameraSpace = (position - env.camera.position).applying(env.camera.quaternion.inverse)
        }
    }

    /// Thin grey smoke that leaves the muzzle, slows and rises.
    private func smoke(_ muzzle: D3, _ direction: D3, _ count: Int, _ push: Double, _ local: Bool) {
        guard count > 0 else { return }
        let sun = local && env.player.indoors ? 0.0 : 1.0
        let light = env.shade(0.7, 0.7, 0.72, sun)
        let random = env.random
        var s = lit.spawn
        for _ in 0..<count {
            let speed = random.range(0.5, 1.8) * push
            s.at(muzzle.adding(direction, 0.05))
            s.vx = direction.x * speed + random.range(-0.15, 0.15)
            s.vy = direction.y * speed + random.range(0.05, 0.3)
            s.vz = direction.z * speed + random.range(-0.15, 0.15)
            s.life = random.range(0.9, 1.7)
            s.size = random.range(0.03, 0.05)
            s.sizeEnd = random.range(0.22, 0.36)
            s.rotation = random.range(0, .pi * 2)
            s.spin = random.range(-0.9, 0.9)
            s.color(light)
            s.a = random.range(0.14, 0.24)
            s.sprite = random.next() < 0.6 ? Sprite.wisp : Sprite.puffA
            s.gravity = -0.4
            s.drag = 3.2
            s.stretch = 0
            lit.emit(s)
        }
    }

    private func hide(_ index: Int) {
        for q in 0..<Self.quads { M4.hidden(into: matrices.row(index * Self.quads + q, 16)) }
    }

    /// Write the three quads of one flash for its current age.
    private func place(_ index: Int, _ flash: Flash, _ progress: Double) {
        let camera = env.camera
        var muzzle = flash.position
        var dir = flash.direction
        if flash.local {
            muzzle = muzzle.applying(camera.quaternion) + camera.position
            dir = dir.applying(camera.quaternion)
        }
        dir = dir.normalized()
        // Two axes across the barrel, rolled by a random angle.
        var u = abs(dir.y) > 0.99 ? D3(1, 0, 0) : D3(0, 1, 0)
        u = u.cross(dir).normalized()
        let v = dir.cross(u)
        let cosR = cos(flash.roll), sinR = sin(flash.roll)
        let a = (u * cosR).adding(v, sinR)
        let b = (v * cosR).adding(u, -sinR)

        let grow = 0.75 + 0.5 * progress
        let brightness = (1 - progress) * (1 - progress * 0.5)
        let base = index * Self.quads
        let size = flash.size * grow
        M4.basis(a, b, dir, scale: D3(size, size, 1), position: muzzle.adding(dir, 0.04), into: matrices.row(base, 16))
        info[base * 2] = Float(flash.cell)
        info[base * 2 + 1] = Float(brightness)

        let length = flash.length * grow
        let width = flash.size * 0.62 * grow
        for q in 1..<Self.quads {
            let across = q == 1 ? a : b
            let facing = q == 1 ? b : a
            M4.basis(across, dir, facing, scale: D3(width, length, 1), position: muzzle.adding(dir, length * 0.46),
                     into: matrices.row(base + q, 16))
            info[(base + q) * 2] = Float(Cell.jet)
            info[(base + q) * 2 + 1] = Float(brightness * 0.8)
        }
    }

    func clear() {
        for i in 0..<Self.maxFlashes {
            flashes[i].active = false
            hide(i)
        }
        for i in lights.indices {
            lights[i].birth = -1
            lights[i].intensity = 0
        }
        anyActive = false
        heat = 0
        sinceShot = .infinity
    }
}
