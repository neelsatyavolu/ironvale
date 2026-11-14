// Ported from src/fx/shared.ts (FxEnv, RENDER_ORDER) at commit a487033.
import IronvaleWorld

public enum Weather: String, Sendable, CaseIterable { case clear, mist, rain }

public enum WeaponClass: String, Sendable, CaseIterable { case pistol, rifle, carbine, smg, shotgun, sniper, lmg }

public enum CasingKind: String, Sendable, CaseIterable { case pistol, rifle, shotgun }

/// The fields of a WeaponDef the effects read.
public struct FXWeapon: Sendable, Equatable {
    public var weaponClass: WeaponClass
    public var pellets: Int
    public var muzzleVelocity: Double

    public init(weaponClass: WeaponClass, pellets: Int, muzzleVelocity: Double) {
        self.weaponClass = weaponClass
        self.pellets = pellets
        self.muzzleVelocity = muzzleVelocity
    }
}

/// The parts of a map's LightingSetup the effects read.
public struct FXLighting: Sendable, Equatable {
    public var sunDirection: D3
    public var sunColor: UInt32
    public var sunIntensity: Double
    public var skyIntensity: Double
    public var fogColor: UInt32

    public init(sunDirection: D3, sunColor: UInt32, sunIntensity: Double, skyIntensity: Double, fogColor: UInt32) {
        self.sunDirection = sunDirection
        self.sunColor = sunColor
        self.sunIntensity = sunIntensity
        self.skyIntensity = skyIntensity
        self.fogColor = fogColor
    }
}

/// The camera: position and orientation (the player's YXZ yaw and pitch).
public struct FXCamera: Sendable, Equatable {
    public var position: D3
    public var quaternion: Quat
    /// The YXZ Euler angles, when the camera was made from them (the blast shake adds to them).
    public private(set) var euler: D3?

    public init(position: D3, yaw: Double, pitch: Double, roll: Double = 0) {
        self.position = position
        quaternion = .eulerYXZ(pitch, yaw, roll)
        euler = D3(pitch, yaw, roll)
    }

    /// grenade.ts applyShake: the camera's rotation += (x, y, z), position.y -= drop.
    mutating func shake(_ x: Double, _ y: Double, _ z: Double, _ drop: Double) {
        let e = euler ?? .zero
        self = FXCamera(position: D3(position.x, position.y - drop, position.z), yaw: e.y + y, pitch: e.x + x, roll: e.z + z)
    }

    public init(position: D3, quaternion: Quat) {
        self.position = position
        self.quaternion = quaternion
    }

    /// getWorldDirection.
    public var forward: D3 { D3(0, 0, -1).applying(quaternion).normalized() }
}

/// What the effects read of the local player.
public struct FXPlayer: Sendable, Equatable {
    public var id: Int
    public var position: D3
    public var yaw: Double
    public var indoors: Bool
    public var alive: Bool

    public init(id: Int = 0, position: D3 = .zero, yaw: Double = 0, indoors: Bool = false, alive: Bool = true) {
        self.id = id
        self.position = position
        self.yaw = yaw
        self.indoors = indoors
        self.alive = alive
    }
}

/// shared.ts RENDER_ORDER: draw order among the transparent effects; nothing here writes depth.
public enum RenderOrder {
    public static let decals = 1, rings = 2, mist = 3, particles = 4, rain = 5, glow = 6, tracers = 7, flash = 8
}

/// State every effect shares: the effect clock, the map's light and wind, quality, camera, player.
public final class FxEnv {
    static let sunScatter = 0.2
    static let ambientFromFog = 0.85
    static let sunProbeDistance = 60.0
    static let sunProbeLift = 0.06
    static func wind(_ weather: Weather) -> D3 {
        switch weather {
        case .clear: D3(0.45, 0, 0.25)
        case .mist: D3(0.3, 0, 0.18)
        case .rain: D3(2.4, 0, 1.2)
        }
    }

    /// Effect clock in seconds.
    public internal(set) var now = 0.0
    /// true while a map is loaded; events outside a match are ignored.
    public var live = false
    public internal(set) var weather: Weather = .clear
    public internal(set) var wind = D3.zero
    public internal(set) var sunDirection = D3(0, 1, 0)
    /// Sunlight a particle scatters, linear RGB.
    public internal(set) var sunLight = D3(1, 1, 1)
    /// Sky light a particle scatters, linear RGB.
    public internal(set) var ambientLight = D3(0.4, 0.4, 0.4)
    public var particleDensity: Double
    public var detailDensity: Double
    /// settings.gameplay.headBob, which scales the blast shake.
    public var headBob = 1.0
    public var camera = FXCamera(position: .zero, yaw: 0, pitch: 0)
    public var player = FXPlayer()
    public var world: CollisionWorld?
    public let random: FXRandom

    public init(particleDensity: Double, detailDensity: Double, random: FXRandom) {
        self.particleDensity = particleDensity
        self.detailDensity = detailDensity
        self.random = random
    }

    func advance(_ dt: Double) { now += dt }

    public func setMap(lighting: FXLighting, weather: Weather) {
        live = true
        self.weather = weather
        sunDirection = lighting.sunDirection.normalized()
        sunLight = linearFromHex(lighting.sunColor) * (lighting.sunIntensity * Self.sunScatter)
        ambientLight = linearFromHex(lighting.fogColor) * (lighting.skyIntensity * Self.ambientFromFog)
        wind = Self.wind(weather)
    }

    /// 1 when the sun reaches a point just off a surface, 0 when the level shadows it.
    func sunAt(_ point: D3, _ normal: D3?) -> Double {
        guard let world else { return 1 }
        var from = point
        if let normal { from = from.adding(normal, Self.sunProbeLift) }
        let to = from.adding(sunDirection, Self.sunProbeDistance)
        return world.lineOfSight(from.vec3, to.vec3) ? 1 : 0
    }

    /// Light a particle of the given albedo: sky light plus sunlight where `sun` (0 - 1) reaches.
    @inline(__always) func shade(_ r: Double, _ g: Double, _ b: Double, _ sun: Double) -> D3 {
        D3(r * (ambientLight.x + sunLight.x * sun), g * (ambientLight.y + sunLight.y * sun), b * (ambientLight.z + sunLight.z * sun))
    }
}
