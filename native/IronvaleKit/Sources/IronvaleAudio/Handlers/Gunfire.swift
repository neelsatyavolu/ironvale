// Ported from src/audio/gunfire.ts at commit cbe0add.
// Gunshots, fly-bys, impacts and hit confirmation. A shot is several layers: close crack and
// body, a recorded outdoor tail, a sub thump and the action for the shooter, and a distant take.

import IronvaleWorld

final class Gunfire {
    static let pitchJitter = 0.03
    static let levelJitter = 0.07
    static let crackCap = 4
    static let tailCap = 4
    static let impactsPerFrame = 4
    static let nearMissGap = 0.07
    static let hitTickGap = 0.05
    static let ricochetChance = 0.16
    static let supersonic = 360.0
    static let distantTrim = 1.8

    private let mixer: Mixer
    private var impactsThisFrame = 0
    private var lastNearMiss = -1.0
    private var lastHitTick = -1.0

    init(mixer: Mixer) {
        self.mixer = mixer
    }

    /// Call once a frame.
    func update() {
        impactsThisFrame = 0
    }

    func shot(shooterId: Int, weapon: AudioWeapon, muzzle: Vec3, local eventLocal: Bool) {
        let local = eventLocal || mixer.isLocal(shooterId)
        let distance = local ? 0 : mixer.pool.distanceTo(muzzle)
        let layers = ShotLayers.choose(local: local, distance: distance, environment: mixer.environment)
        let loud = 0.7 + 0.3 * weapon.loudness
        let level = loud * jitter(mixer.random, Gunfire.levelJitter)
        let pitch = jitter(mixer.random, Gunfire.pitchJitter)
        let position: Vec3? = local ? nil : muzzle
        // One ray for the whole shot instead of one per layer.
        let occlusion: Occlusion? = local ? nil : mixer.pool.occlusionAt(muzzle)

        if layers.close > 0.02, var request = mixer.begin(mixer.catalog.weaponGroup(weapon, .shot)) {
            request.position = position
            request.occlusion = occlusion
            request.soundClass = .gunshot
            request.volume = level * layers.close
            request.pitch = pitch
            request.send = layers.reverbSend
            request.priority = local ? .critical : .high
            request.group = "shot:\(shooterId)"
            request.groupCap = Gunfire.crackCap
            mixer.pool.play(request)
        }
        if layers.distant > 0.02, var request = mixer.begin(mixer.catalog.weaponGroup(weapon, .dist)) {
            request.position = position
            request.occlusion = occlusion
            request.soundClass = .gunshot
            request.volume = level * layers.distant * Gunfire.distantTrim
            request.pitch = pitch
            request.send = layers.reverbSend * 0.5
            request.priority = .normal
            request.group = "dist:\(shooterId)"
            request.groupCap = Gunfire.tailCap
            mixer.pool.play(request)
        }
        if layers.tail > 0.02, var request = mixer.begin(mixer.catalog.weaponGroup(weapon, .tail)) {
            request.position = position
            request.occlusion = occlusion
            request.soundClass = .gunshot
            request.volume = loud * layers.tail * (local ? 0.85 : 0.75)
            request.pitch = pitch
            request.cutoff = layers.tailCutoff
            request.send = layers.reverbSend * 0.4
            request.priority = local ? .high : .normal
            request.group = "tail:\(shooterId)"
            request.groupCap = Gunfire.tailCap
            request.delay = 0.015
            mixer.pool.play(request)
        }
        if layers.mech > 0.02, var request = mixer.begin(mixer.catalog.weaponGroup(weapon, .mech)) {
            request.position = position
            request.occlusion = occlusion
            request.soundClass = .foley
            request.volume = layers.mech
            request.pitch = jitter(mixer.random, 0.04)
            request.group = "mech:\(shooterId)"
            request.groupCap = 2
            request.delay = 0.028
            mixer.pool.play(request)
        }
        if layers.sub > 0 { sub(weapon, layers.sub) }

        // The shooter's own gun pushes the world down for a moment; a close neighbour's does a little.
        if local { mixer.graph.duckAmbience(0.32, 0.14, 0.4) } else if distance < 30 { mixer.graph.duckAmbience(0.7, 0.08, 0.3) }
    }

    private func sub(_ weapon: AudioWeapon, _ amount: Double) {
        guard let sound = mixer.sound(AudioGraph.subBuffer) else { return }
        var request = PlayRequest(sound: sound)
        request.volume = amount * (0.55 + 0.45 * weapon.loudness)
        // Bigger rounds thump lower.
        request.pitch = 1.15 - 0.3 * weapon.loudness
        request.priority = .high
        request.group = "sub"
        request.groupCap = 2
        mixer.pool.play(request)
    }

    /// A round passed close: the crack first, then the whiz, on the side it went by.
    func nearMiss(point: Vec3, weapon: AudioWeapon) {
        if mixer.clock - lastNearMiss < Gunfire.nearMissGap { return }
        lastNearMiss = mixer.clock
        let raw = mixer.panFor(point, fullAt: 1.2)
        // A pass dead ahead still gets a side, so it never sounds like it came from inside the head.
        let side = raw != 0 && !raw.isNaN ? raw : mixer.random() - 0.5
        let pan = jsSign(side) * max(0.35, abs(raw))
        let supersonic = weapon.muzzleVelocity > Gunfire.supersonic

        if supersonic, var crack = mixer.begin("snd-bullet-crack") {
            crack.volume = 0.85
            crack.pan = pan
            crack.pitch = jitter(mixer.random, 0.08)
            crack.send = 0.15
            crack.priority = .high
            crack.group = "crack"
            crack.groupCap = 3
            mixer.pool.play(crack)
        }
        if var whiz = mixer.begin("snd-bullet-whiz") {
            whiz.volume = 0.7
            whiz.pan = pan * 0.9
            whiz.pitch = jitter(mixer.random, 0.1)
            whiz.priority = .high
            whiz.group = "whiz"
            whiz.groupCap = 3
            whiz.delay = supersonic ? 0.035 : 0
            mixer.pool.play(whiz)
        }
    }

    func impact(point: Vec3, normal: Vec3, surface: Surface) {
        if impactsThisFrame >= Gunfire.impactsPerFrame { return }
        impactsThisFrame += 1
        // Lift the source off the surface so the line-of-sight test does not start inside the wall.
        let position = Vec3(point.x + normal.x * 0.15, point.y + normal.y * 0.15, point.z + normal.z * 0.15)
        let occlusion = mixer.pool.occlusionAt(position)

        if var request = mixer.begin(mixer.catalog.impactGroup(surface)) {
            request.position = position
            request.occlusion = occlusion
            request.soundClass = .impact
            request.volume = 0.8 + 0.2 * mixer.random()
            request.pitch = jitter(mixer.random, 0.07)
            request.send = 0.2
            request.group = "impact"
            request.groupCap = 6
            mixer.pool.play(request)
        }
        if mixer.catalog.ricochets(surface) && mixer.random() < Gunfire.ricochetChance, var ricochet = mixer.begin("snd-ricochet") {
            ricochet.position = position
            ricochet.occlusion = occlusion
            ricochet.soundClass = .impact
            ricochet.volume = 0.55
            ricochet.pitch = jitter(mixer.random, 0.12)
            ricochet.send = 0.3
            ricochet.priority = .low
            ricochet.group = "ricochet"
            ricochet.groupCap = 2
            ricochet.delay = 0.02
            mixer.pool.play(ricochet)
        }
    }

    func combatantHit(targetId: Int, attackerId: Int, point: Vec3, fatal: Bool) {
        // The player's own wounds are voiced by `playerHurt`.
        if mixer.isLocal(targetId) { return }
        if var request = mixer.begin("snd-impact-flesh") {
            request.position = point
            request.soundClass = .impact
            request.volume = 0.8
            request.pitch = jitter(mixer.random, 0.08)
            request.group = "flesh"
            request.groupCap = 3
            mixer.pool.play(request)
        }
        if !mixer.isLocal(attackerId) || !mixer.host.showHitMarkers { return }
        if !fatal && mixer.clock - lastHitTick < Gunfire.hitTickGap { return }
        lastHitTick = mixer.clock
        if var tick = mixer.begin(fatal ? "snd-ui-kill" : "snd-ui-hit") {
            tick.bus = .interface
            tick.volume = fatal ? 0.9 : 0.7
            tick.priority = .high
            tick.group = "tick"
            tick.groupCap = 2
            mixer.pool.play(tick)
        }
    }

    func dryFire(shooterId: Int, weapon: AudioWeapon, position: Vec3) {
        guard var request = mixer.begin(mixer.catalog.weaponGroup(weapon, .dry)) else { return }
        if mixer.isLocal(shooterId) {
            request.volume = 0.7
        } else {
            request.position = position
            request.soundClass = .foley
        }
        request.pitch = jitter(mixer.random, 0.03)
        mixer.pool.play(request)
    }
}
