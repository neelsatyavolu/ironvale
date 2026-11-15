// What the audio reads from the match (src/audio's slice of GameContext) and how the sim's
// GameEvents become AudioEvents (src/audio/index.ts `subscribe`). The web hands the audio its
// WeaponDef and MapInstance; here the contract's weapon defs and the map package stand in.
import Foundation
import IronvaleAudio
import IronvaleContract
import IronvaleMapData
import IronvaleSim
import IronvaleWorld

/// AudioHost backed by the running Game. Read on the main thread only.
final class GameAudioHost: AudioHost {
    private let game: Game
    private(set) var audioSettings = IronvaleAudio.AudioSettings(master: 0.9, effects: 1, ambience: 0.8, interface: 0.7, hrtf: true)
    private(set) var showHitMarkers = true

    init(game: Game) { self.game = game }

    /// The interface's settings; the graph re-applies them only when the revision moves.
    func apply(master: Double, effects: Double, ambience: Double, interface: Double, hrtf: Bool, showHitMarkers: Bool) {
        self.showHitMarkers = showHitMarkers
        let s = audioSettings
        if s.master == master, s.effects == effects, s.ambience == ambience, s.interface == interface, s.hrtf == hrtf { return }
        audioSettings = IronvaleAudio.AudioSettings(master: master, effects: effects, ambience: ambience, interface: interface,
                                                    hrtf: hrtf, revision: s.revision + 1)
    }

    var playerId: Int { game.player.id }
    var playerIndoors: Bool { game.player.indoors }
    var playerCrouching: Bool { game.player.crouching }

    /// The player camera's world matrix, column-major (the web reads `engine.camera.matrixWorld`).
    var cameraMatrix: [Double] {
        let camera = game.player.camera
        let (r, u, b) = camera.basis
        let p = camera.position
        return [r.x, r.y, r.z, 0, u.x, u.y, u.z, 0, b.x, b.y, b.z, 0, p.x, p.y, p.z, 1]
    }

    func combatant(_ id: Int) -> (position: Vec3, crouching: Bool)? {
        game.combat.get(id).map { ($0.position, $0.crouching) }
    }

    /// pool.ts occlusion: `world.lineOfSight`; nothing blocks before a map is loaded.
    func lineOfSight(_ a: Vec3, _ b: Vec3) -> Bool {
        game.map?.world.lineOfSight(a, b) ?? true
    }
}

enum AudioEvents {
    /// The audio's view of every weapon def (WeaponDef.weaponClass, loudness, muzzleVelocity), by id.
    static func weapons(_ table: WeaponsTable) -> [String: AudioWeapon] {
        var out: [String: AudioWeapon] = [:]
        for def in table.weapons + [table.grenadeDef] {
            out[def.id] = AudioWeapon(id: def.id, weaponClass: def.weaponClass, loudness: def.loudness, muzzleVelocity: def.muzzleVelocity)
        }
        return out
    }

    /// One sim event as the audio hears it, or nil for the events src/audio does not subscribe to.
    /// casingLanded and botCallout do not travel on the sim's bus: the effects' casings and the bot
    /// manager report them (GameAudio.attach).
    static func translate(_ event: GameEvent, weapons: [String: AudioWeapon]) -> AudioEvent? {
        switch event {
        case let .shotFired(shooterId, weapon, muzzle, _, local):
            return weapons[weapon].map { .shotFired(shooterId: shooterId, weapon: $0, muzzle: muzzle, local: local) }
        case let .bulletImpact(_, _, hit):
            return .bulletImpact(point: hit.point, normal: hit.normal, surface: hit.surface)
        case let .combatantHit(_, targetId, attackerId, hit, _, fatal):
            return .combatantHit(targetId: targetId, attackerId: attackerId, point: hit.point, fatal: fatal)
        case let .nearMiss(point, _, weapon):
            return weapons[weapon].map { .nearMiss(point: point, weapon: $0) }
        case let .dryFire(shooterId, weapon, position):
            return weapons[weapon].map { .dryFire(shooterId: shooterId, weapon: $0, position: position) }
        case let .weaponAction(shooterId, weapon, stage, position, local):
            guard let def = weapons[weapon], let stage = WeaponActionStage(rawValue: stage) else { return nil }
            return .weaponAction(shooterId: shooterId, weapon: def, stage: stage, position: position, local: local)
        case let .weaponSwitch(shooterId, weapon, local):
            return weapons[weapon].map { .weaponSwitch(shooterId: shooterId, weapon: $0, local: local) }
        case let .aimChanged(aiming, _):
            return .aimChanged(aiming: aiming)
        case let .footstep(ownerId, position, surface, running, local):
            return .footstep(ownerId: ownerId, position: position, surface: surface, running: running, local: local)
        case let .jumped(ownerId, position, local):
            return .jumped(ownerId: ownerId, position: position, local: local)
        case let .landed(ownerId, position, surface, speed, local):
            return .landed(ownerId: ownerId, position: position, surface: surface, speed: speed, local: local)
        case let .playerHurt(amount, _, direction):
            return .playerHurt(amount: amount, direction: direction)
        case let .died(victimId, _, _, _):
            return .died(victimId: victimId)
        case let .grenadeThrown(ownerId, position, _, local):
            return .grenadeThrown(ownerId: ownerId, position: position, local: local)
        case let .grenadeBounced(_, position, speed, surface):
            return .grenadeBounced(position: position, speed: speed, surface: surface)
        case let .grenadeExploded(_, position, _):
            return .grenadeExploded(position: position)
        case .bulletTrace, .casingEjected, .spawned:
            return nil
        }
    }

    /// The audio part of a map (MapInstance reverb, weather, ambience and interior zones).
    static func map(_ meta: MapMeta) -> MapAudio {
        func vec(_ a: [Double]) -> Vec3 { Vec3(a[0], a[1], a[2]) }
        return MapAudio(
            reverb: ReverbPreset(rawValue: meta.reverb) ?? .openField,
            weather: meta.weather,
            ambience: meta.ambience.map { .init(sound: $0.sound, volume: $0.volume, position: $0.position.map(vec), radius: $0.radius) },
            interiors: meta.interiors.map { .init(min: vec($0.min), max: vec($0.max), reverb: ReverbPreset(rawValue: $0.reverb) ?? .interior) }
        )
    }
}
