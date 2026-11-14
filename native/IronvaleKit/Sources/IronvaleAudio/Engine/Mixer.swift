// Ported from src/audio/mixer.ts at commit cbe0add, plus the GameEvents the audio consumes
// (src/game/contracts.ts GameEvents). Until IronvaleSim (M4) emits its own GameEvent, callers feed
// AudioEvent directly; the M8a trace harness is such a stub event source.

import IronvaleWorld

/// What the audio needs from the game (a slice of GameContext).
public protocol AudioHost: AnyObject {
    var playerId: Int { get }
    var playerIndoors: Bool { get }
    var playerCrouching: Bool { get }
    var audioSettings: AudioSettings { get }
    var showHitMarkers: Bool { get }
    /// Camera world matrix, column-major (three.js `matrixWorld.elements`).
    var cameraMatrix: [Double] { get }
    func combatant(_ id: Int) -> (position: Vec3, crouching: Bool)?
    func lineOfSight(_ a: Vec3, _ b: Vec3) -> Bool
}

public enum BotCalloutKind: String, Sendable {
    case spotted, reloading, hurt, death
}

/// The GameEvents src/audio subscribes to, with the fields it reads.
public enum AudioEvent: Sendable {
    case shotFired(shooterId: Int, weapon: AudioWeapon, muzzle: Vec3, local: Bool)
    case nearMiss(point: Vec3, weapon: AudioWeapon)
    case bulletImpact(point: Vec3, normal: Vec3, surface: Surface)
    case combatantHit(targetId: Int, attackerId: Int, point: Vec3, fatal: Bool)
    case dryFire(shooterId: Int, weapon: AudioWeapon, position: Vec3)
    case weaponAction(shooterId: Int, weapon: AudioWeapon, stage: WeaponActionStage, position: Vec3, local: Bool)
    case weaponSwitch(shooterId: Int, weapon: AudioWeapon, local: Bool)
    case casingLanded(kind: CasingKind, position: Vec3, surface: Surface)
    case aimChanged(aiming: Bool)
    case footstep(ownerId: Int, position: Vec3, surface: Surface, running: Bool, local: Bool)
    case jumped(ownerId: Int, position: Vec3, local: Bool)
    case landed(ownerId: Int, position: Vec3, surface: Surface, speed: Double, local: Bool)
    case playerHurt(amount: Double, direction: Vec3)
    case died(victimId: Int)
    case botCallout(botId: Int, kind: BotCalloutKind, position: Vec3)
    case grenadeThrown(ownerId: Int, position: Vec3, local: Bool)
    case grenadeBounced(position: Vec3, speed: Double, surface: Surface)
    case grenadeExploded(position: Vec3)
    /// MatchSnapshot: the phase is "playing" or anything else.
    case matchState(playing: Bool, health: Double)
}

/// What the event handlers share. Exists only once the engine is running.
final class Mixer {
    let picker: VariationPicker
    /// Unit vector to the listener's right, refreshed every frame.
    var right = Vec3(1, 0, 0)
    /// Reverb preset in force this frame.
    var environment = ReverbPreset.openField
    /// Seconds since audio started; for rate limits.
    var clock = 0.0

    unowned let host: AudioHost
    let graph: AudioGraph
    let pool: VoicePool
    let catalog: Catalog
    let random: () -> Double
    private let buffers: () -> [String: DecodedSound]

    init(host: AudioHost, graph: AudioGraph, pool: VoicePool, catalog: Catalog, buffers: @escaping () -> [String: DecodedSound], random: @escaping () -> Double) {
        self.host = host
        self.graph = graph
        self.pool = pool
        self.catalog = catalog
        self.buffers = buffers
        self.random = random
        picker = VariationPicker(random: random)
    }

    func sound(_ id: String) -> DecodedSound? { buffers()[id] }

    /// A play request for the next take of `group`, or nil when the group has no decoded sound.
    func begin(_ group: String?) -> PlayRequest? {
        guard let group else { return nil }
        let takes = catalog.takes(group)
        if takes.isEmpty { return nil }
        guard let sound = buffers()[takes[picker.next(group, count: takes.count)]] else { return nil }
        return PlayRequest(sound: sound)
    }

    /// -1 (hard left) to 1 (hard right) for a world position, by how far to the side it lies.
    func panFor(_ position: Vec3, fullAt: Double) -> Double {
        let l = pool.listener
        let side = (position.x - l.x) * right.x + (position.y - l.y) * right.y + (position.z - l.z) * right.z
        return max(-1, min(1, side / fullAt))
    }

    func isLocal(_ combatantId: Int) -> Bool { combatantId == host.playerId }
}

func jsSign(_ x: Double) -> Double { x > 0 ? 1 : x < 0 ? -1 : x }
