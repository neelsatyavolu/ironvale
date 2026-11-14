// Ported from src/fx/weather.ts, the CPU sides of src/fx/rain.ts and src/fx/mist.ts (FogBanks,
// Motes), at commit a487033. Shaders/WeatherRain.metal and WeatherMist.metal draw them.
import Darwin
import IronvaleCore
import IronvaleWorld

/// One axis-aligned interior zone (InteriorZone.box).
public struct FXBox: Sendable, Equatable {
    public var min: D3
    public var max: D3
    public init(min: D3, max: D3) { self.min = min; self.max = max }
}

/// Rain, ground mist and dust motes for the map's weather, plus the roof mask over them.
public final class WeatherFx {
    public static let maskCells = 32
    public static let maskCellMetres = 1.0
    static let maskBudget = 48
    static let maskFullRefresh = maskCells * maskCells / 2
    static let noGround = -1000.0
    static let splashesPerSecond = 420.0
    static let splashMinRadius = 1.2
    static let splashMaxRadius = 10.0
    static let splashViewHalfAngle = 1.25
    static let splashInViewShare = 0.8
    static let roofAboveFeet = 2.6
    static let maxSplashesPerFrame = 16
    static func moteAmount(_ w: Weather) -> Double {
        switch w { case .clear: 0.3; case .mist: 1; case .rain: 0 }
    }

    // rain.ts
    public static let maxStreaks = 7000
    public static let rainBox = D3(26, 16, 26)
    static let rainLead = 6.0
    public static let fallSpeed = 9.5
    // mist.ts
    public static let maxBanks = 56
    public static let maxMotes = 520
    public static let moteBox = D3(15, 7, 15)
    static let moteLead = 4.0

    /// Per-instance seeds (vec4 each), seededRandom as rain.ts and mist.ts make them.
    public let rainSeeds = WeatherFx.seeds(maxStreaks, 0x7a1)
    public let bankSeeds = WeatherFx.seeds(maxBanks, 0xf06)
    public let moteSeeds = WeatherFx.seeds(maxMotes, 0x307e)

    public let mask = RoofMask(size: WeatherFx.maskCells, cell: WeatherFx.maskCellMetres)
    /// The rain, bank and mote state the shaders read (rain.ts / mist.ts uniforms and mesh counts).
    public struct State: Sendable {
        public var rainVisible = false, rainCount = WeatherFx.maxStreaks
        public var rainCentre = D3.zero, rainFall = D3(0, -WeatherFx.fallSpeed, 0), rainIndoors = 0.0
        public var banksVisible = false, banksCount = WeatherFx.maxBanks
        public var banksCentre = D3.zero, banksIndoors = 0.0
        public var motesVisible = false, motesCount = WeatherFx.maxMotes
        public var motesCentre = D3.zero
    }
    public private(set) var state = State()
    private var weather = Weather.clear
    private var interiors: [FXBox] = []
    private var active = false
    private var splashDebt = 0.0
    private var moteAmount = 0.0
    private var groundY = 0.0
    private var placed = false
    private unowned let env: FxEnv
    private unowned let lit: ParticlePool
    private unowned let rings: Rings

    init(env: FxEnv, lit: ParticlePool, rings: Rings) {
        self.env = env
        self.lit = lit
        self.rings = rings
    }

    static func seeds(_ count: Int, _ seed: UInt32) -> FloatStore {
        var random = SeededRandom(seed: seed)
        let store = FloatStore(count: count * 4)
        for i in 0..<count * 4 { store[i] = Float(random.next()) }
        return store
    }

    func enterMap(weather: Weather, interiors: [FXBox]) {
        self.weather = weather
        self.interiors = interiors
        active = true
        splashDebt = 0
        state.rainVisible = weather == .rain
        state.banksVisible = weather == .mist
        placed = false
        moteAmount = Self.moteAmount(weather)
        state.motesVisible = moteAmount > 0
    }

    func update(_ dt: Double) {
        guard active else { return }
        refreshMask()
        updateRain(dt)
        updateBanks(dt)
        updateMotes()
        if weather == .rain { splashes(dt) }
    }

    func clear() {
        active = false
        state.rainVisible = false
        state.banksVisible = false
        placed = false
        moteAmount = 0
        state.motesVisible = false
    }

    private func updateRain(_ dt: Double) {
        guard state.rainVisible else { return }
        let camera = env.camera
        state.rainCount = max(1, Int(jsRound(Double(Self.maxStreaks) * env.detailDensity)))
        var forward = camera.forward
        forward.y = 0
        state.rainCentre = camera.position.adding(forward, Self.rainLead)
        state.rainFall = D3(env.wind.x, -Self.fallSpeed, env.wind.z)
        let target = env.player.indoors ? 1.0 : 0.0
        state.rainIndoors += (target - state.rainIndoors) * min(1, dt * 8)
    }

    private func updateBanks(_ dt: Double) {
        guard state.banksVisible else { return }
        let player = env.player
        state.banksCount = max(1, Int(jsRound(Double(Self.maxBanks) * env.detailDensity)))
        // Follow the player's feet slowly so stairs and jumps do not bounce the whole layer.
        let feet = player.position.y
        groundY = placed ? groundY + (feet - groundY) * min(1, dt * 0.6) : feet
        placed = true
        state.banksCentre = D3(player.position.x, groundY, player.position.z)
        let target = player.indoors ? 1.0 : 0.0
        state.banksIndoors += (target - state.banksIndoors) * min(1, dt * 2)
    }

    private func updateMotes() {
        guard state.motesVisible else { return }
        let camera = env.camera
        state.motesCount = max(1, Int(jsRound(Double(Self.maxMotes) * moteAmount * env.detailDensity)))
        state.motesCentre = camera.position.adding(camera.forward, Self.moteLead)
    }

    /// Highest surface over a point: the level's own geometry, or the top of an interior zone over it.
    private func probe(_ x: Double, _ z: Double) -> Double {
        var height = Self.noGround
        if let world = env.world {
            let top = world.bounds.max.y + 1
            let bottom = world.bounds.min.y - 1
            if top.isFinite, top > bottom { height = world.groundHeight(x: x, z: z, fromY: top, maxDrop: top - bottom) ?? Self.noGround }
        }
        for box in interiors where x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z {
            height = max(height, box.max.y)
        }
        return height
    }

    private func refreshMask() {
        let position = env.player.position
        mask.setCentre(position.x, position.z)
        if mask.stale > 0 {
            mask.refresh({ [unowned self] x, z in probe(x, z) }, budget: mask.stale > Self.maskFullRefresh ? .max : Self.maskBudget)
        }
    }

    /// Rings and a speck of spray where drops land on open ground near the player.
    private func splashes(_ dt: Double) {
        let player = env.player
        let r = env.random
        splashDebt += Self.splashesPerSecond * env.detailDensity * dt
        var budget = Self.maxSplashesPerFrame
        let light = env.shade(0.8, 0.86, 0.92, 0)
        while splashDebt >= 1 {
            guard budget > 0 else { break }
            budget -= 1
            splashDebt -= 1
            let inView = r.next() < Self.splashInViewShare
            let angle = inView ? player.yaw + r.range(-Self.splashViewHalfAngle, Self.splashViewHalfAngle) : r.range(0, .pi * 2)
            let radius = Self.splashMinRadius + (Self.splashMaxRadius - Self.splashMinRadius) * r.next().squareRoot()
            // Yaw 0 looks down -Z.
            let x = player.position.x - sin(angle) * radius
            let z = player.position.z - cos(angle) * radius
            let cover = mask.heightAt(x, z)
            if cover == RoofMask.staleHeight || cover <= Self.noGround || cover > player.position.y + Self.roofAboveFeet { continue }
            guard let ground = env.world?.groundHeight(x: x, z: z, fromY: cover + 0.5, maxDrop: 2) else { continue }
            rings.add(D3(x, ground, z), .up, 0.03, r.range(0.13, 0.24), r.range(0.2, 0.32), 0.55, 0)

            var s = lit.spawn
            s.x = x; s.y = ground + 0.02; s.z = z
            s.vx = 0; s.vy = 0.5; s.vz = 0
            s.life = 0.16
            s.size = 0.025
            s.sizeEnd = 0.085
            s.rotation = r.range(-0.3, 0.3)
            s.spin = 0
            s.color(light, 1.4)
            s.a = 0.5
            s.sprite = Sprite.splash
            s.gravity = 0
            s.drag = 2
            s.stretch = 0
            lit.emit(s)
        }
        if splashDebt > Double(Self.maxSplashesPerFrame) { splashDebt = 0 }
    }
}
