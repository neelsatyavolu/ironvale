// Ported from src/audio/index.ts at commit cbe0add.
// The spatial audio engine, main-thread side: decoding, the per-frame listener, interior-zone
// reverb, the GameEvent handlers and the public play/playAt. Everything it decides goes to a
// MixSink as commands; MixCore renders them on the audio thread.

import Foundation
import IronvaleWorld

/// Supplies decoded sounds: AVAudioFile decoding in the app, fixture lengths in the trace harness.
public protocol SoundDecoder: AnyObject {
    /// Decode one manifest sound (nil when it cannot be).
    func decode(_ id: String) -> DecodedSound?
    /// Register a generated mono buffer (the sub thump) at `sampleRate`.
    func register(_ id: String, samples: [Float], sampleRate: Double) -> DecodedSound
}

public final class AudioEngine {
    static let pauseFade = 0.08
    /// Samples quieter than this at the head of a one-shot are encoder padding.
    static let onsetLevel: Float = 0.004
    static let onsetScanSeconds = 0.12

    private let host: AudioHost
    private let catalog: Catalog
    private let decoder: SoundDecoder
    private let sink: MixSink
    private let clock: () -> Double
    private let random: () -> Double
    public let sampleRate: Double

    private var buffers: [String: DecodedSound] = [:]
    private var live: Live?
    private var map: MapAudio?
    private var mapToken = 0
    private var ambienceFor: Int?
    private var baseReverb = ReverbPreset.openField
    private var paused = false

    private struct Live {
        let graph: AudioGraph
        let pool: VoicePool
        let mixer: Mixer
        let gunfire: Gunfire
        let foley: Foley
        let grenade: GrenadeAudio
        let ambience: Ambience
    }

    /// `clock`: the audio clock in seconds (MixCore's rendered time, or the scene clock).
    /// `random`: the shared stream the web takes from Math.random.
    public init(host: AudioHost, catalog: Catalog, decoder: SoundDecoder, sink: MixSink, sampleRate: Double,
                clock: @escaping () -> Double, random: @escaping () -> Double) {
        self.host = host
        self.catalog = catalog
        self.decoder = decoder
        self.sink = sink
        self.sampleRate = sampleRate
        self.clock = clock
        self.random = random
    }

    public var isRunning: Bool { live != nil }
    public var voicePool: VoicePool? { live?.pool }

    /// Build the graph and decode the interface sounds (the web's `unlock`, minus the gesture).
    public func unlock() {
        if live == nil { live = createLive() }
        decode(catalog.interfaceIds())
        if let map { beginMap(map, token: mapToken) }
    }

    public func requiredSounds(_ map: MapAudio) -> [String] { catalog.required(map) }

    public func enterMap(_ map: MapAudio) {
        self.map = map
        mapToken += 1
        baseReverb = map.reverb
        paused = false
        guard live != nil else { return }
        beginMap(map, token: mapToken)
    }

    public func leaveMap() {
        map = nil
        ambienceFor = nil
        guard let live else { return }
        live.ambience.stop()
        live.pool.stopAll(0.1, includeLoops: true)
        live.foley.reset()
    }

    @discardableResult
    public func playAt(_ soundId: String, position: Vec3, options: PlaySoundOptions = .init()) -> SoundHandle {
        playSound(soundId, position, options)
    }

    @discardableResult
    public func play(_ soundId: String, options: PlaySoundOptions = .init()) -> SoundHandle {
        playSound(soundId, nil, options)
    }

    /// Set the outdoor reverb. Interior zones still take over while the player is under a roof.
    public func setReverb(_ preset: ReverbPreset) {
        baseReverb = preset
    }

    public func setPaused(_ paused: Bool) {
        if paused == self.paused { return }
        self.paused = paused
        guard let live else { return }
        live.graph.setWorldGain(paused ? 0 : 1, AudioEngine.pauseFade)
        // One-shots end with the fade so nothing finishes its tail when play resumes; loops wait muted.
        if paused { live.pool.stopAll(AudioEngine.pauseFade, includeLoops: false) }
    }

    /// A source MixCore started has fallen silent (forwarded from the render thread's ended ring).
    public func sourceEnded(slot: Int, generation: UInt32) {
        live?.pool.sourceEnded(slot: slot, generation: generation)
    }

    public func update(_ dt: Double) {
        guard let live else { return }
        let settings = host.audioSettings
        live.graph.applySettings(settings)
        live.pool.hrtfEnabled = settings.hrtf
        live.mixer.clock += dt
        moveListener(live)

        let indoors = map != nil && host.playerIndoors
        live.mixer.environment = ShotLayers.activeReverb(baseReverb, indoors: indoors, zone: indoors ? zoneReverb(live) : nil)
        live.graph.setReverb(live.mixer.environment)
        live.graph.update()
        live.pool.update(dt)
        live.gunfire.update()
        if paused || ambienceFor == nil { return }
        live.foley.update(dt)
        live.ambience.update(dt, listener: live.pool.listener, indoors: indoors)
    }

    /// Deliver one GameEvent, as the web's event-bus subscriptions do.
    public func handle(_ event: AudioEvent) {
        guard let live else { return }
        if case let .matchState(playing, health) = event {
            // Match state arrives while paused and in menus too: it is what switches the heartbeat off.
            live.foley.matchState(playing: playing, health: health)
            return
        }
        if paused || ambienceFor == nil { return }
        switch event {
        case let .shotFired(shooterId, weapon, muzzle, local): live.gunfire.shot(shooterId: shooterId, weapon: weapon, muzzle: muzzle, local: local)
        case let .nearMiss(point, weapon): live.gunfire.nearMiss(point: point, weapon: weapon)
        case let .bulletImpact(point, normal, surface): live.gunfire.impact(point: point, normal: normal, surface: surface)
        case let .combatantHit(targetId, attackerId, point, fatal): live.gunfire.combatantHit(targetId: targetId, attackerId: attackerId, point: point, fatal: fatal)
        case let .dryFire(shooterId, weapon, position): live.gunfire.dryFire(shooterId: shooterId, weapon: weapon, position: position)
        case let .weaponAction(shooterId, weapon, stage, position, local): live.foley.weaponAction(shooterId: shooterId, weapon: weapon, stage: stage, position: position, local: local)
        case let .weaponSwitch(shooterId, _, local): live.foley.weaponSwitch(shooterId: shooterId, local: local)
        case let .casingLanded(kind, position, surface): live.foley.casingLanded(kind: kind, position: position, surface: surface)
        case let .aimChanged(aiming): live.foley.aimChanged(aiming: aiming)
        case let .footstep(ownerId, position, surface, running, local): live.foley.footstep(ownerId: ownerId, position: position, surface: surface, running: running, local: local)
        case let .jumped(ownerId, position, local): live.foley.jumped(ownerId: ownerId, position: position, local: local)
        case let .landed(ownerId, position, surface, speed, local): live.foley.landed(ownerId: ownerId, position: position, surface: surface, speed: speed, local: local)
        case let .playerHurt(amount, direction): live.foley.playerHurt(amount: amount, direction: direction)
        case let .died(victimId): live.foley.died(victimId: victimId)
        case let .botCallout(botId, kind, position): live.foley.botCallout(botId: botId, kind: kind, position: position)
        case let .grenadeThrown(ownerId, position, local): live.grenade.thrown(ownerId: ownerId, position: position, local: local)
        case let .grenadeBounced(position, speed, surface): live.grenade.bounced(position: position, speed: speed, surface: surface)
        case let .grenadeExploded(position): live.grenade.exploded(position: position)
        case .matchState: break
        }
    }

    // ---------------------------------------------------------------- startup

    private func createLive() -> Live {
        let graph = AudioGraph(sampleRate: sampleRate, sink: sink, clock: clock)
        let pool = VoicePool(sink: sink, clock: clock, lineOfSight: { [unowned host] a, b in host.lineOfSight(a, b) })
        let mixer = Mixer(host: host, graph: graph, pool: pool, catalog: catalog, buffers: { [unowned self] in self.buffers }, random: random)
        let ambience = Ambience(graph: graph, pool: pool, catalog: catalog, sound: { [unowned self] in self.buffers[$0] }, picker: mixer.picker,
                                random: random, sink: sink, clock: clock)
        let sub = decoder.register(AudioGraph.subBuffer, samples: AudioGraph.makeSubBuffer(sampleRate: sampleRate), sampleRate: sampleRate)
        buffers[AudioGraph.subBuffer] = sub
        let live = Live(graph: graph, pool: pool, mixer: mixer, gunfire: Gunfire(mixer: mixer), foley: Foley(mixer: mixer),
                        grenade: GrenadeAudio(mixer: mixer), ambience: ambience)
        graph.applySettings(host.audioSettings)
        if paused { graph.setWorldGain(0, 0) }
        return live
    }

    /// Decode what the map needs (once; buffers are kept across maps) and start its ambience.
    private func beginMap(_ map: MapAudio, token: Int) {
        guard let live else { return }
        decode(catalog.required(map))
        if token != mapToken || ambienceFor == token { return }
        ambienceFor = token
        live.graph.setWorldGain(paused ? 0 : 1, AudioEngine.pauseFade)
        live.ambience.start(map)
    }

    private func decode(_ ids: [String]) {
        for id in ids where buffers[id] == nil {
            if let sound = decoder.decode(id) { buffers[id] = sound }
        }
    }

    // ---------------------------------------------------------------- per frame

    private func moveListener(_ live: Live) {
        let e = host.cameraMatrix
        let position = Vec3(e[12], e[13], e[14])
        let forward = Vec3(-e[8], -e[9], -e[10]).normalized()
        let up = Vec3(e[4], e[5], e[6]).normalized()
        live.mixer.right = forward.cross(up).normalized()
        live.pool.listener = position
        sink.send(.listener(ListenerPose(position: position, forward: forward, up: up)))
    }

    /// Reverb of the interior zone the listener stands in, if the map names one.
    private func zoneReverb(_ live: Live) -> ReverbPreset? {
        guard let map else { return nil }
        let p = live.pool.listener
        for zone in map.interiors {
            if p.x >= zone.min.x && p.x <= zone.max.x && p.y >= zone.min.y && p.y <= zone.max.y && p.z >= zone.min.z && p.z <= zone.max.z {
                return zone.reverb
            }
        }
        return nil
    }

    // ---------------------------------------------------------------- public one-offs

    private func playSound(_ soundId: String, _ position: Vec3?, _ options: PlaySoundOptions) -> SoundHandle {
        guard let live, catalog.has(soundId) else { return .silent }
        let menu = soundId.hasPrefix(Catalog.interfacePrefix)
        if paused && !menu { return .silent }
        guard let sound = buffers[soundId] else {
            // Not decoded yet: warm it so the next call plays.
            decode([soundId])
            return .silent
        }
        var request = PlayRequest(sound: sound)
        request.bus = menu ? .interface : .effects
        request.position = position
        request.volume = options.volume ?? 1
        let jitterAmount = options.pitchJitter ?? 0
        request.pitch = (options.pitch ?? 1) * (jitterAmount != 0 ? jitter(random, jitterAmount) : 1)
        request.loop = options.loop ?? false
        if position != nil && (options.refDistance != nil || options.maxDistance != nil) {
            var profile = Curves.profile(.generic)
            profile.ref = options.refDistance ?? profile.ref
            profile.max = options.maxDistance ?? profile.max
            request.profile = profile
        }
        return live.pool.handle(live.pool.play(request))
    }

    // ---------------------------------------------------------------- decoding helpers

    /// Where a decoded sound really starts, and its loop points if it is a loop (index.ts `describe`).
    /// `head`: the first samples of channel 0, at least `onsetScanSeconds` of them when available.
    public static func describe(id: String, table: Int32, duration: Double, sampleRate: Double, head: UnsafeBufferPointer<Float>,
                                frames: Int, loops: [String: (start: Double, end: Double)]) -> DecodedSound {
        if let loop = loops[id] {
            return DecodedSound(id: id, table: table, duration: duration, offset: loop.start, loopStart: loop.start, loopEnd: min(loop.end, duration))
        }
        let limit = min(frames, Int((onsetScanSeconds * sampleRate).rounded(.down)), head.count)
        var first = 0
        while first < limit && abs(head[first]) < onsetLevel { first += 1 }
        // Keep a millisecond of lead-in; a file that is silent for the whole scan starts at 0.
        let offset = first >= limit ? 0 : max(0, Double(first) / sampleRate - 0.001)
        return DecodedSound(id: id, table: table, duration: duration, offset: offset, loopStart: 0, loopEnd: duration)
    }
}

public struct PlaySoundOptions: Sendable {
    public var volume: Double?
    public var pitch: Double?
    public var pitchJitter: Double?
    public var refDistance: Double?
    public var maxDistance: Double?
    public var loop: Bool?

    public init(volume: Double? = nil, pitch: Double? = nil, pitchJitter: Double? = nil, refDistance: Double? = nil, maxDistance: Double? = nil, loop: Bool? = nil) {
        self.volume = volume
        self.pitch = pitch
        self.pitchJitter = pitchJitter
        self.refDistance = refDistance
        self.maxDistance = maxDistance
        self.loop = loop
    }
}
