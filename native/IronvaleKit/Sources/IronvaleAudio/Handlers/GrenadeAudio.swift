// Ported from src/audio/grenade.ts at commit cbe0add.
// The hand grenade: pin and throw, each bounce, and the blast with a close and a distant take.

import Foundation
import IronvaleWorld

final class GrenadeAudio {
    static let closeUntil = 30.0
    static let distantFrom = 110.0
    /// Louder and further-carrying than a gunshot.
    static let blastProfile = DistanceProfile(ref: 12, max: 900, rolloff: 0.55, airHalf: 70, minCutoff: 500, delayed: true)
    static let closeGain = 1.25
    static let fullBounceSpeed = 7.0

    private let mixer: Mixer

    init(mixer: Mixer) {
        self.mixer = mixer
    }

    func thrown(ownerId: Int, position: Vec3, local eventLocal: Bool) {
        let local = eventLocal || mixer.isLocal(ownerId)
        if var pin = mixer.begin("snd-grenade-pin") {
            if local { pin.volume = 0.45 } else {
                pin.position = position
                pin.soundClass = .foley
            }
            pin.pitch = jitter(mixer.random, 0.03)
            mixer.pool.play(pin)
        }
        guard var swing = mixer.begin("snd-grenade-throw") else { return }
        if local { swing.volume = 0.6 } else {
            swing.position = position
            swing.soundClass = .foley
        }
        swing.pitch = jitter(mixer.random, 0.06)
        swing.delay = 0.05
        mixer.pool.play(swing)
    }

    func bounced(position: Vec3, speed: Double, surface: Surface) {
        guard var request = mixer.begin("snd-grenade-bounce") else { return }
        request.position = position
        request.soundClass = .impact
        request.volume = 0.25 + 0.75 * min(1, speed / GrenadeAudio.fullBounceSpeed)
        // Softer ground gives a duller knock.
        request.cutoff = mixer.catalog.casingGroup(.rifle, surface).hasSuffix("soft") ? 1800 : request.cutoff
        request.pitch = jitter(mixer.random, 0.07)
        request.group = "grenade-bounce"
        request.groupCap = 3
        mixer.pool.play(request)
    }

    func exploded(position: Vec3) {
        let distance = mixer.pool.distanceTo(position)
        // One ray for both takes.
        let occlusion = mixer.pool.occlusionAt(position)
        let far = smoothstep(GrenadeAudio.closeUntil, GrenadeAudio.distantFrom, distance)
        let pitch = jitter(mixer.random, 0.04)

        let closeLevel = cos((far * Double.pi) / 2)
        if closeLevel > 0.02, var close = mixer.begin("snd-grenade-explode") {
            close.position = position
            close.occlusion = occlusion
            close.profile = GrenadeAudio.blastProfile
            close.volume = closeLevel * GrenadeAudio.closeGain
            close.pitch = pitch
            close.send = 0.3
            close.priority = .critical
            close.group = "grenade-blast"
            close.groupCap = 2
            mixer.pool.play(close)
        }
        let distantLevel = sin((far * Double.pi) / 2)
        if distantLevel > 0.02, var distant = mixer.begin("snd-grenade-explode-dist") {
            distant.position = position
            distant.occlusion = occlusion
            distant.profile = GrenadeAudio.blastProfile
            distant.volume = distantLevel
            distant.pitch = pitch
            distant.send = 0.2
            distant.priority = .high
            distant.group = "grenade-blast-far"
            distant.groupCap = 2
            mixer.pool.play(distant)
        }
        // A blast nearby pushes the world down for a moment.
        if distance < 60 { mixer.graph.duckAmbience(0.3, 0.25, 0.9) }
    }
}
