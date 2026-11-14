// Ported from src/audio/ambience.ts at commit cbe0add.
// Map ambience: stereo beds that drift slowly in level, positional loops on the pool, rain that
// changes character under a roof, and sparse one-shots placed around the listener.

import Foundation
import IronvaleWorld

final class Ambience {
    static let driftLow = 0.72
    static let driftHigh = 1.1
    static let fadeIn = 1.5
    static let oneShotMinGap = 7.0
    static let oneShotMaxGap = 22.0
    /// One-shots are heard from far off: full level at 30 m, gone by 220 m.
    static let farProfile: DistanceProfile = {
        var p = Curves.profile(.ambient)
        p.ref = 30
        p.max = 220
        p.airHalf = 90
        return p
    }()
    /// How much of the outdoor rain bed is left under a roof.
    static let rainIndoorShare = 0.3
    static let defaultRadius = 20.0

    private struct Bed {
        let index: Int32
        let gain: ParamMirror
        let volume: Double
        let indoor: Double
        let outdoor: Double
        var drift: Double
        var driftIn: Double
    }

    private let graph: AudioGraph
    private let pool: VoicePool
    private let catalog: Catalog
    private let sound: (String) -> DecodedSound?
    private let picker: VariationPicker
    private let random: () -> Double
    private unowned let sink: MixSink
    private let clock: () -> Double
    private var beds: [Bed] = []
    private var loops: [SoundHandle] = []
    private var oneShots: [String] = []
    private var nextOneShot = 0.0
    private var indoors = false
    private var bedCount: Int32 = 0

    init(graph: AudioGraph, pool: VoicePool, catalog: Catalog, sound: @escaping (String) -> DecodedSound?, picker: VariationPicker,
         random: @escaping () -> Double, sink: MixSink, clock: @escaping () -> Double) {
        self.graph = graph
        self.pool = pool
        self.catalog = catalog
        self.sound = sound
        self.picker = picker
        self.random = random
        self.sink = sink
        self.clock = clock
    }

    func start(_ map: MapAudio) {
        stop()
        indoors = false
        var volumes: [String: Double] = [:]
        for layer in map.ambience where layer.position == nil { volumes[layer.sound] = layer.volume }
        for id in catalog.bedIds(map) {
            let volume = volumes[id] ?? 0.8
            addBed(id, volume, id == Catalog.rainBed ? Ambience.rainIndoorShare : 1, 1, .bedFilter)
            // Rain heard from inside plays only under a roof and skips the indoor low-pass.
            if id == Catalog.rainBed { addBed(Catalog.rainRoofBed, volume, 1, 0, .ambienceLoops) }
        }
        for layer in map.ambience {
            guard let position = layer.position, let decoded = sound(layer.sound) else { continue }
            // `radius` is how far the loop carries: full level inside a fifth of it, soft at its edge, gone at twice it.
            let radius = layer.radius ?? Ambience.defaultRadius
            var request = PlayRequest(sound: decoded)
            request.bus = .ambience
            request.position = position
            var profile = Curves.profile(.ambient)
            profile.ref = max(1.5, radius * 0.2)
            profile.max = radius * 2
            request.profile = profile
            request.volume = layer.volume
            request.loop = true
            request.priority = .high
            request.fadeIn = Ambience.fadeIn
            loops.append(pool.handle(pool.play(request)))
        }
        oneShots = catalog.oneShotGroups(catalog.bedIds(map))
        nextOneShot = Ambience.oneShotMinGap * (0.5 + random())
    }

    func stop() {
        let now = clock()
        for bed in beds {
            bed.gain.cancelScheduledValues(now)
            bed.gain.setTargetAtTime(0, now, 0.08)
            sink.send(.stopBed(bed: bed.index, when: now + 0.5))
        }
        for loop in loops { loop.stop(0.3) }
        beds = []
        loops = []
        oneShots = []
    }

    func update(_ dt: Double, listener: Vec3, indoors: Bool) {
        let now = clock()
        let changed = indoors != self.indoors
        self.indoors = indoors
        for i in beds.indices {
            beds[i].driftIn -= dt
            if beds[i].driftIn <= 0 {
                beds[i].drift = Ambience.driftLow + (Ambience.driftHigh - Ambience.driftLow) * random()
                beds[i].driftIn = 7 + 9 * random()
                beds[i].gain.setTargetAtTime(bedLevel(beds[i]), now, 3.5)
            } else if changed {
                beds[i].gain.setTargetAtTime(bedLevel(beds[i]), now, 0.35)
            }
            beds[i].gain.compact(now: now)
        }
        if changed { graph.setIndoors(indoors) }

        if oneShots.isEmpty { return }
        nextOneShot -= dt
        if nextOneShot > 0 { return }
        nextOneShot = Ambience.oneShotMinGap + (Ambience.oneShotMaxGap - Ambience.oneShotMinGap) * random()
        playOneShot(listener)
    }

    private func bedLevel(_ bed: Bed) -> Double {
        bed.volume * bed.drift * (indoors ? bed.indoor : bed.outdoor)
    }

    private func addBed(_ id: String, _ volume: Double, _ indoor: Double, _ outdoor: Double, _ destination: BedDestination) {
        guard let decoded = sound(id) else { return }
        let now = clock()
        let index = bedCount
        bedCount += 1
        let gain = ParamMirror(.bed(index), initial: 0, sink: sink, clock: clock)
        let bed = Bed(index: index, gain: gain, volume: volume, indoor: indoor, outdoor: outdoor, drift: 1, driftIn: 4 + 8 * random())
        gain.setValueAtTime(0, now)
        gain.linearRampToValueAtTime(bedLevel(bed), now + Ambience.fadeIn)
        // Start each bed at a different point of its loop so two maps never open on the same second.
        let offset = decoded.loopStart + random() * (decoded.loopEnd - decoded.loopStart)
        sink.send(.startBed(bed: index, SourceStart(
            sound: decoded.table, start: now, offset: offset, rate: 1, loop: true,
            loopStart: decoded.loopStart, loopEnd: decoded.loopEnd, generation: 0
        ), destination))
        beds.append(bed)
    }

    private func playOneShot(_ listener: Vec3) {
        let group = oneShots[Int((random() * Double(oneShots.count)).rounded(.down))]
        let takes = catalog.takes(group)
        let take = picker.next(group, count: takes.count)
        guard take < takes.count, let decoded = sound(takes[take]) else { return }
        let angle = random() * Double.pi * 2
        let range = 30 + 70 * random()
        // Gulls are overhead; everything else is near the ground.
        let height = group.contains("gull") ? 8 + 25 * random() : 1 + 3 * random()
        var request = PlayRequest(sound: decoded)
        request.bus = .ambience
        request.position = Vec3(listener.x + cos(angle) * range, listener.y + height, listener.z + sin(angle) * range)
        request.profile = Ambience.farProfile
        request.volume = 0.5 + 0.35 * random()
        request.pitch = jitter(random, 0.06)
        request.send = 0.45
        request.occlude = false
        request.priority = .low
        pool.play(request)
    }
}
