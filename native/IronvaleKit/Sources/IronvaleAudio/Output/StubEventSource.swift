// A stand-in GameEvent source until IronvaleSim (M4) emits real events: a scripted 16-bot
// firefight around a player who walks a loop through a Railyard-like map. Deterministic for a
// given seed. Used by the load and allocation tests and the 10-minute soak.

import Foundation
import IronvaleCore
import IronvaleWorld

public final class StubFirefight: AudioHost {
    public let playerId = 1
    public private(set) var playerIndoors = false
    public private(set) var playerCrouching = false
    public var audioSettings = AudioSettings(master: 0.9, effects: 1, ambience: 0.8, interface: 0.7, hrtf: true)
    public let showHitMarkers = true
    public private(set) var cameraMatrix: [Double] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1]
    public private(set) var time = 0.0

    public static let map = MapAudio(
        reverb: .industrial, weather: "rain",
        ambience: [
            .init(sound: "snd-amb-industrial", volume: 0.55),
            .init(sound: "snd-amb-wind", volume: 0.35),
            .init(sound: "snd-loop-generator", volume: 0.7, position: Vec3(40.2, 0.8, 21.6), radius: 22),
            .init(sound: "snd-loop-water-lap", volume: 0.6, position: Vec3(2, -1.5, 30), radius: 30),
            .init(sound: "snd-loop-metal-creak", volume: 0.5, position: Vec3(12, 11, 6), radius: 28),
        ],
        interiors: [.init(min: Vec3(-30, 0, -10), max: Vec3(0, 9, 10), reverb: .interior)]
    )

    static let weapons = [
        AudioWeapon(id: "m4a1", weaponClass: "carbine", loudness: 0.8, muzzleVelocity: 880),
        AudioWeapon(id: "mp5", weaponClass: "smg", loudness: 0.55, muzzleVelocity: 400),
        AudioWeapon(id: "m24", weaponClass: "sniper", loudness: 1, muzzleVelocity: 790),
        AudioWeapon(id: "m249", weaponClass: "lmg", loudness: 0.9, muzzleVelocity: 915),
        AudioWeapon(id: "scarh", weaponClass: "rifle", loudness: 0.95, muzzleVelocity: 714),
    ]

    private var random: SeededRandom
    private var bots: [Vec3]
    private var position = Vec3(0, 0, 0)
    private var heading = 0.0
    private var health = 100.0
    private var nextStep = 0.0

    public init(seed: UInt32 = 7) {
        random = SeededRandom(seed: seed)
        bots = (0..<16).map { i in Vec3(cos(Double(i)) * 35, 0, sin(Double(i)) * 35) }
    }

    public func combatant(_ id: Int) -> (position: Vec3, crouching: Bool)? {
        id >= 100 && id < 116 ? (bots[id - 100], id % 3 == 0) : nil
    }

    public func lineOfSight(_ a: Vec3, _ b: Vec3) -> Bool {
        // A wall along x = 8 for |z| < 6: enough to exercise occlusion.
        let t = (8 - a.x) / (b.x - a.x)
        guard b.x != a.x, t > 0, t < 1 else { return true }
        let z = a.z + (b.z - a.z) * t
        return abs(z) >= 6
    }

    /// Advance the script by `dt` and return this frame's events (about 20 sounds a second, with bursts).
    public func step(_ dt: Double) -> [AudioEvent] {
        time += dt
        heading += dt * 0.15
        position = Vec3(cos(heading) * 25, 0, sin(heading) * 25)
        playerIndoors = position.x <= 0 && position.x >= -30 && abs(position.z) <= 10
        playerCrouching = Int(time / 7) % 4 == 3
        let yaw = heading + .pi / 2
        let (c, s) = (cos(yaw), sin(yaw))
        cameraMatrix = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, position.x, 1.6, position.z, 0]
        cameraMatrix[15] = 1

        var events: [AudioEvent] = []
        func r() -> Double { random.next() }
        for i in bots.indices {
            bots[i] = Vec3(bots[i].x + (r() - 0.5) * 0.2, 0, bots[i].z + (r() - 0.5) * 0.2)
        }
        let burst = Int(time) % 6 < 2
        let shots = burst ? 2 : (r() < 0.25 ? 1 : 0)
        for _ in 0..<shots {
            let id = 100 + Int(r() * 16)
            let weapon = StubFirefight.weapons[id % StubFirefight.weapons.count]
            let muzzle = Vec3(bots[id - 100].x, 1.5, bots[id - 100].z)
            events.append(.shotFired(shooterId: id, weapon: weapon, muzzle: muzzle, local: false))
            if r() < 0.5 {
                events.append(.bulletImpact(point: Vec3(position.x + (r() - 0.5) * 6, 0, position.z + (r() - 0.5) * 6), normal: Vec3(0, 1, 0),
                                            surface: Surface.allCases[Int(r() * 14)]))
            }
            if r() < 0.15 { events.append(.nearMiss(point: Vec3(position.x + 0.6, 1.6, position.z), weapon: weapon)) }
            if r() < 0.1 { events.append(.botCallout(botId: id, kind: r() < 0.5 ? .spotted : .hurt, position: muzzle)) }
        }
        if r() < 0.08 {
            let weapon = StubFirefight.weapons[0]
            events.append(.shotFired(shooterId: playerId, weapon: weapon, muzzle: Vec3(position.x, 1.5, position.z), local: true))
            events.append(.casingLanded(kind: .rifle, position: Vec3(position.x + 0.5, 0, position.z), surface: .concrete))
            events.append(.combatantHit(targetId: 100 + Int(r() * 16), attackerId: playerId, point: Vec3(0, 1.4, -10), fatal: r() < 0.1))
        }
        nextStep -= dt
        if nextStep <= 0 {
            nextStep = 0.36
            events.append(.footstep(ownerId: playerId, position: position, surface: playerIndoors ? .concrete : .gravel, running: true, local: true))
            let bot = 100 + Int(r() * 16)
            events.append(.footstep(ownerId: bot, position: bots[bot - 100], surface: .dirt, running: r() < 0.5, local: false))
        }
        if r() < 0.004 { events.append(.grenadeExploded(position: Vec3(position.x + 20, 0, position.z - 10))) }
        if r() < 0.01 {
            health = max(5, health - 15)
            events.append(.playerHurt(amount: 15, direction: Vec3(1, 0, 0)))
            events.append(.matchState(playing: true, health: health))
        }
        if r() < 0.003 {
            health = 100
            events.append(.matchState(playing: true, health: health))
        }
        if r() < 0.02 { events.append(.weaponAction(shooterId: playerId, weapon: StubFirefight.weapons[0], stage: r() < 0.5 ? .magOut : .magIn, position: position, local: true)) }
        return events
    }
}
