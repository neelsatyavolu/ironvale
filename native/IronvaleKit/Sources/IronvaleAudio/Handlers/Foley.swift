// Ported from src/audio/foley.ts at commit cbe0add.
// Everything bodies do: weapon handling, footsteps, jumps and landings, casings, cloth, grunts and
// the low-health heartbeat.

import IronvaleWorld

final class Foley {
    /// Below this health the heartbeat starts and the mix begins to close in.
    static let lowHealth = 40.0
    static let hurtGap = 0.22
    static let calloutGap = 0.6
    static let stepPan = 0.16
    static let up = 0.4

    private let mixer: Mixer
    private var leftFoot = false
    private var lastHurt = -1.0
    private var lastCallout = -1.0
    /// 0 when healthy, 1 at the edge of death.
    private var danger = 0.0
    private var nextBeat = 0.0

    init(mixer: Mixer) {
        self.mixer = mixer
    }

    /// Call once a frame while the match is running.
    func update(_ dt: Double) {
        if danger <= 0 { return }
        nextBeat -= dt
        if nextBeat > 0 { return }
        // 65 beats a minute when hurt, climbing to 105.
        nextBeat = 0.92 - 0.35 * danger
        guard var beat = mixer.begin("snd-heartbeat") else { return }
        beat.volume = 0.45 + 0.5 * danger
        beat.priority = .high
        beat.group = "heart"
        beat.groupCap = 2
        mixer.pool.play(beat)
    }

    func reset() {
        danger = 0
        mixer.graph.setNarrow(0)
    }

    func matchState(playing: Bool, health: Double) {
        let alive = playing && health > 0
        let danger = alive && health < Foley.lowHealth ? 1 - health / Foley.lowHealth : 0
        if danger == self.danger { return }
        if self.danger <= 0 { nextBeat = 0 }
        self.danger = danger
        mixer.graph.setNarrow(danger * 0.6)
    }

    func weaponAction(shooterId: Int, weapon: AudioWeapon, stage: WeaponActionStage, position: Vec3, local: Bool) {
        guard var request = mixer.begin(mixer.catalog.actionGroup(weapon, stage)) else { return }
        if local || mixer.isLocal(shooterId) {
            request.volume = 0.8
            request.send = 0.08
        } else {
            request.position = position
            request.soundClass = .foley
        }
        request.pitch = jitter(mixer.random, 0.025)
        request.group = "action:\(shooterId)"
        request.groupCap = 3
        mixer.pool.play(request)
    }

    func weaponSwitch(shooterId: Int, local: Bool) {
        guard var request = mixer.begin("snd-equip") else { return }
        if local || mixer.isLocal(shooterId) {
            request.volume = 0.55
        } else {
            guard let owner = mixer.host.combatant(shooterId) else { return }
            request.position = Vec3(owner.position.x, owner.position.y + 1.2, owner.position.z)
            request.soundClass = .foley
        }
        request.pitch = jitter(mixer.random, 0.05)
        mixer.pool.play(request)
    }

    func aimChanged(aiming: Bool) {
        guard var request = mixer.begin("snd-cloth") else { return }
        request.volume = aiming ? 0.4 : 0.3
        request.pitch = jitter(mixer.random, 0.08) * (aiming ? 1.04 : 0.96)
        request.priority = .low
        request.group = "cloth"
        request.groupCap = 2
        mixer.pool.play(request)
    }

    func casingLanded(kind: CasingKind, position: Vec3, surface: Surface) {
        guard var request = mixer.begin(mixer.catalog.casingGroup(kind, surface)) else { return }
        request.position = Vec3(position.x, position.y + 0.1, position.z)
        request.soundClass = .casing
        request.volume = 0.7 + 0.3 * mixer.random()
        request.pitch = jitter(mixer.random, 0.08)
        request.priority = .low
        request.group = "casing"
        request.groupCap = 4
        request.occlude = false
        mixer.pool.play(request)
    }

    func footstep(ownerId: Int, position: Vec3, surface: Surface, running: Bool, local eventLocal: Bool) {
        let local = eventLocal || mixer.isLocal(ownerId)
        let crouching = local ? mixer.host.playerCrouching : (mixer.host.combatant(ownerId)?.crouching ?? false)
        let level = Curves.stepLevel(running: running, crouching: crouching)
        step(ownerId, position, surface, running, local, level.volume, level.pitch)
        if !local { return }
        // Kit shifts on every stride, more when running.
        guard var gear = mixer.begin("snd-gear") else { return }
        gear.volume = running ? 0.6 : 0.34
        gear.pan = leftFoot ? -0.1 : 0.1
        gear.pitch = jitter(mixer.random, 0.08)
        gear.priority = .low
        gear.group = "gear"
        gear.groupCap = 2
        gear.delay = 0.03
        mixer.pool.play(gear)
    }

    func jumped(ownerId: Int, position: Vec3, local eventLocal: Bool) {
        let local = eventLocal || mixer.isLocal(ownerId)
        guard var request = mixer.begin("snd-jump") else { return }
        if local {
            request.volume = 0.6
        } else {
            request.position = Vec3(position.x, position.y + Foley.up, position.z)
            request.soundClass = .footstep
        }
        request.pitch = jitter(mixer.random, 0.06)
        mixer.pool.play(request)
    }

    func landed(ownerId: Int, position: Vec3, surface: Surface, speed: Double, local eventLocal: Bool) {
        let local = eventLocal || mixer.isLocal(ownerId)
        let volume = Curves.landingVolume(speed)
        if var request = mixer.begin(mixer.catalog.landGroup(surface)) {
            if local {
                request.volume = volume
            } else {
                request.position = Vec3(position.x, position.y + Foley.up, position.z)
                request.soundClass = .footstep
                request.volume = volume
            }
            request.pitch = jitter(mixer.random, 0.05)
            request.priority = .high
            mixer.pool.play(request)
        }
        // The surface itself under the thump: both feet, so no pan.
        step(ownerId, position, surface, true, local, 0.5 + 0.5 * volume, 0.94, alternate: false)
    }

    func playerHurt(amount: Double, direction: Vec3) {
        if mixer.clock - lastHurt < Foley.hurtGap { return }
        lastHurt = mixer.clock
        let pan = max(-0.6, min(0.6, direction.dot(mixer.right) * 0.6))
        if var thud = mixer.begin("snd-impact-flesh") {
            thud.volume = 0.9
            thud.pan = pan
            thud.priority = .critical
            mixer.pool.play(thud)
        }
        if var grunt = mixer.begin("snd-hurt") {
            grunt.volume = min(1, 0.55 + amount / 80)
            grunt.pitch = jitter(mixer.random, 0.04)
            grunt.priority = .critical
            grunt.group = "voice:local"
            grunt.groupCap = 1
            grunt.delay = 0.05
            mixer.pool.play(grunt)
        }
    }

    func died(victimId: Int) {
        guard var fall = mixer.begin("snd-bodyfall") else { return }
        if mixer.isLocal(victimId) {
            fall.volume = 0.9
            fall.priority = .critical
            mixer.pool.play(fall)
            reset()
            return
        }
        guard let victim = mixer.host.combatant(victimId) else { return }
        let point = Vec3(victim.position.x, victim.position.y + Foley.up, victim.position.z)
        fall.position = point
        fall.soundClass = .voice
        fall.delay = 0.35
        mixer.pool.play(fall)
        voice(victimId, point, 0.85, 0.94)
    }

    /// Bots make a short breath or grunt at most; there is no speech.
    func botCallout(botId: Int, kind: BotCalloutKind, position: Vec3) {
        if kind == .death || kind == .reloading { return }
        if mixer.clock - lastCallout < Foley.calloutGap { return }
        lastCallout = mixer.clock
        let point = Vec3(position.x, position.y + 1.5, position.z)
        if kind == .hurt {
            voice(botId, point, 0.7, 1)
            return
        }
        guard var breath = mixer.begin("snd-breath") else { return }
        breath.position = point
        breath.soundClass = .voice
        breath.volume = 0.5
        breath.pitch = voicePitch(botId)
        breath.priority = .low
        mixer.pool.play(breath)
    }

    private func voice(_ ownerId: Int, _ position: Vec3, _ volume: Double, _ pitch: Double) {
        guard var grunt = mixer.begin("snd-hurt") else { return }
        grunt.position = position
        grunt.soundClass = .voice
        grunt.volume = volume
        grunt.pitch = pitch * voicePitch(ownerId) * jitter(mixer.random, 0.03)
        grunt.group = "voice:\(ownerId)"
        grunt.groupCap = 1
        mixer.pool.play(grunt)
    }

    /// Each soldier keeps his own voice: a fixed pitch offset from his id (JS `%` keeps the sign).
    private func voicePitch(_ ownerId: Int) -> Double {
        0.9 + Double(ownerId % 6) * 0.035
    }

    private func step(_ ownerId: Int, _ position: Vec3, _ surface: Surface, _ running: Bool, _ local: Bool, _ volume: Double, _ pitch: Double, alternate: Bool = true) {
        guard var request = mixer.begin(mixer.catalog.stepGroup(surface, running: running)) else { return }
        if local {
            if alternate { leftFoot.toggle() }
            request.pan = alternate ? (leftFoot ? -Foley.stepPan : Foley.stepPan) : 0
            request.volume = volume * 0.85
        } else {
            request.position = Vec3(position.x, position.y + Foley.up, position.z)
            request.soundClass = .footstep
            request.volume = volume
        }
        request.pitch = pitch * jitter(mixer.random, 0.05)
        request.send = 0.06
        request.group = "step:\(ownerId)"
        request.groupCap = 3
        mixer.pool.play(request)
    }
}
