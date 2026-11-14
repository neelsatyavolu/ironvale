// Replays the M8a scenes (native/Tools/audio-trace/fixtures/scenes) through the native
// AudioEngine with a recording MixSink, and builds the same per-voice trace the web exporter
// builds from its recording AudioContext (native/Tools/audio-trace/audio-trace.gen.ts):
//   - a play call's commands on its own slot belong to the voice it starts; its panning model is
//     whatever the call left it at; commands on other slots belong to their current voice;
//   - sources end, at frame starts, when their buffer runs out or their stop time passes,
//     earliest first (stub-context.ts `advance`).

import Foundation
import IronvaleAudio
import IronvaleCore
import IronvaleWorld

enum Fixtures {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let repo = root.deletingLastPathComponent()
    static let traces = root.appending(path: "Tools/audio-trace/fixtures")

    static func json(_ url: URL) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }

    static func sceneFiles() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: traces.appending(path: "scenes"), includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    static func loops() throws -> [String: (start: Double, end: Double)] {
        let meta = try json(repo.appending(path: "src/audio/sound-meta.json"))
        var loops: [String: (Double, Double)] = [:]
        for (id, value) in meta["loops"] as! [String: [String: Double]] { loops[id] = (value["start"]!, value["end"]!) }
        return loops
    }
}

// ---------------------------------------------------------------- trace values

struct VoiceTrace: Equatable {
    var frame: Int
    var kind: String
    var slot: Int
    var sound: String
    var bus: String
    var start: Double
    var offset: Double
    var rate: Double
    var loop: Bool
    var loopStart: Double
    var loopEnd: Double
    var positional: Bool
    var position: [Double]?
    var pan: Double
    var occlusion: Double
    var hrtf: [Bool] = []
    var gain: [Automation] = []
    var cutoff: [Automation] = []
    var send: [Automation] = []
    var stop: Double?
    var end: Double?
    var endFrame: Int?
}

struct SceneTrace {
    var voices: [VoiceTrace] = []
    var buses: [String: [Automation]] = [:]
    var reverb: [(frame: Int, slot: Int, preset: String?)] = []
    var rays: [(from: [Double], to: [Double], clear: Bool)] = []
}

// ---------------------------------------------------------------- recorder

final class TraceRecorder: MixSink {
    var now = 0.0
    var frame = -1
    weak var pool: VoicePool?
    var durations: [Int32: Double] = [:]
    var trace = SceneTrace()
    var onEnded: (Int, UInt32) -> Void = { _, _ in }

    private struct Source {
        let voice: Int
        let slot: Int32
        let generation: UInt32
        let isBed: Bool
        let start: Double
        let natural: Double
        var stop: Double?
        var ended = false
        var endTime: Double { min(natural, stop ?? .infinity) }
    }

    private struct Window {
        var frame: Int
        var entries: [(slot: Int32, kind: Entry)] = []
        var voice: Int?
        var bus = "", positional = false
        var position: [Double]?
        var pan = 0.0
    }

    private enum Entry {
        case param(VoiceParam, Automation)
        case model(Bool)
    }

    private var sources: [Source] = []
    private var current: [Int32: Int] = [:]
    private var bedVoice: [Int32: Int] = [:]
    private var bedPending: [Int32: [Automation]] = [:]
    private var window: Window?
    private var listener = ListenerPose(position: .zero, forward: Vec3(0, 0, -1), up: Vec3(0, 1, 0))

    init() {
        for bus in BusParam.allCases { trace.buses[bus.name] = [] }
    }

    func send(_ command: MixCommand) {
        switch command {
        case .playBegin:
            window = Window(frame: frame)
        case let .playEnd(slot):
            closeWindow(slot)
        case let .param(id, event):
            switch id {
            case let .bus(bus): trace.buses[bus.name]!.append(event)
            case let .bed(bed):
                if let v = bedVoice[bed] { trace.voices[v].gain.append(event) } else { bedPending[bed, default: []].append(event) }
            case let .voice(slot, param):
                if window != nil { window!.entries.append((slot, .param(param, event))) } else { applyParam(current[slot], param, event) }
            }
        case let .panningModel(slot, hrtf):
            if window != nil { window!.entries.append((slot, .model(hrtf))) } else { applyModel(current[slot], hrtf) }
        case let .route(_, bus, positional):
            window?.bus = bus.rawValue
            window?.positional = positional
        case let .position(_, x, y, z):
            window?.position = [x, y, z]
        case let .stereoPan(_, pan):
            window?.pan = pan
        case let .startVoice(slot, start):
            let voice = VoiceTrace(
                frame: window?.frame ?? frame, kind: "voice", slot: Int(slot), sound: "", bus: "", start: start.start, offset: start.offset,
                rate: start.rate, loop: start.loop, loopStart: start.loopStart, loopEnd: start.loopEnd, positional: false, position: nil, pan: 0, occlusion: 1
            )
            trace.voices.append(voice)
            let index = trace.voices.count - 1
            window?.voice = index
            current[slot] = index
            addSource(index, slot: slot, start, isBed: false)
        case let .stopVoice(slot, generation, when):
            if let i = sources.lastIndex(where: { !$0.isBed && $0.slot == slot && $0.generation == generation && !$0.ended }) {
                sources[i].stop = when
                trace.voices[sources[i].voice].stop = when
            }
        case let .startBed(bed, start, destination):
            var voice = VoiceTrace(
                frame: frame, kind: "bed", slot: Int(bed), sound: "", bus: destination == .bedFilter ? "bedFilter" : "ambienceLoops",
                start: start.start, offset: start.offset, rate: start.rate, loop: start.loop, loopStart: start.loopStart, loopEnd: start.loopEnd,
                positional: false, position: nil, pan: 0, occlusion: 1
            )
            voice.gain = bedPending.removeValue(forKey: bed) ?? []
            trace.voices.append(voice)
            bedVoice[bed] = trace.voices.count - 1
            addSource(trace.voices.count - 1, slot: bed, start, isBed: true)
        case let .stopBed(bed, when):
            if let i = sources.lastIndex(where: { $0.isBed && $0.slot == bed && !$0.ended }) {
                sources[i].stop = when
                trace.voices[sources[i].voice].stop = when
            }
        case let .listener(pose):
            listener = pose
        case let .reverbImpulse(slot, preset):
            trace.reverb.append((frame, Int(slot), preset?.rawValue))
        }
    }

    var soundNames: [Int32: String] = [:]

    private func addSource(_ voice: Int, slot: Int32, _ start: SourceStart, isBed: Bool) {
        trace.voices[voice].sound = soundNames[start.sound] ?? "?"
        let duration = durations[start.sound] ?? 0
        let natural = start.loop ? Double.infinity : start.start + max(0, duration - start.offset) / start.rate
        sources.append(Source(voice: voice, slot: slot, generation: start.generation, isBed: isBed, start: start.start, natural: natural))
    }

    private func closeWindow(_ slot: Int32) {
        guard let w = window else { return }
        window = nil
        var model: Bool?
        let own = w.voice
        for (entrySlot, entry) in w.entries {
            let target = entrySlot == slot ? own : current[entrySlot]
            switch entry {
            case let .param(param, event): applyParam(target, param, event)
            case let .model(hrtf):
                if entrySlot == slot { model = hrtf } else { applyModel(target, hrtf) }
            }
        }
        guard let own else { return }
        trace.voices[own].bus = w.bus
        trace.voices[own].positional = w.positional
        trace.voices[own].position = w.positional ? w.position : nil
        if w.positional, let p = w.position {
            let azimuth = Panning.equalPowerAzimuth(
                listener: (listener.px, listener.py, listener.pz), forward: (listener.fx, listener.fy, listener.fz),
                up: (listener.ux, listener.uy, listener.uz), source: (p[0], p[1], p[2]))
            trace.voices[own].pan = azimuth / 90
        } else {
            trace.voices[own].pan = w.pan
        }
        trace.voices[own].occlusion = pool?.occlusionState(Int(slot)) ?? 1
        if let model { applyModel(own, model) }
    }

    private func applyParam(_ voice: Int?, _ param: VoiceParam, _ event: Automation) {
        guard let voice else { return }
        switch param {
        case .gain: trace.voices[voice].gain.append(event)
        case .cutoff: trace.voices[voice].cutoff.append(event)
        case .send: trace.voices[voice].send.append(event)
        }
    }

    private func applyModel(_ voice: Int?, _ hrtf: Bool) {
        guard let voice else { return }
        if trace.voices[voice].hrtf.last != hrtf { trace.voices[voice].hrtf.append(hrtf) }
    }

    /// Move the clock and end every source that has fallen silent by then, earliest first.
    func advance(to time: Double, frame: Int) {
        now = time
        self.frame = frame
        let due = sources.indices.filter { !sources[$0].ended && sources[$0].endTime <= time }
            .sorted { sources[$0].endTime != sources[$1].endTime ? sources[$0].endTime < sources[$1].endTime : $0 < $1 }
        for i in due {
            sources[i].ended = true
            trace.voices[sources[i].voice].end = sources[i].endTime
            trace.voices[sources[i].voice].endFrame = frame
            if !sources[i].isBed { onEnded(Int(sources[i].slot), sources[i].generation) }
        }
    }
}

// ---------------------------------------------------------------- decoder and host

final class FixtureDecoder: SoundDecoder {
    let lengths: [String: Int]
    let rate: Double
    let loops: [String: (start: Double, end: Double)]
    unowned let recorder: TraceRecorder
    private var next: Int32 = 0

    init(lengths: [String: Int], rate: Double, loops: [String: (start: Double, end: Double)], recorder: TraceRecorder) {
        self.lengths = lengths
        self.rate = rate
        self.loops = loops
        self.recorder = recorder
    }

    func decode(_ id: String) -> DecodedSound? {
        guard let frames = lengths[id] else { return nil }
        let table = take(id, duration: Double(frames) / rate)
        // The stub's decoded buffers start at full scale on the first sample.
        let head: [Float] = [1]
        return head.withUnsafeBufferPointer {
            AudioEngine.describe(id: id, table: table, duration: Double(frames) / rate, sampleRate: rate, head: $0, frames: frames, loops: loops)
        }
    }

    func register(_ id: String, samples: [Float], sampleRate: Double) -> DecodedSound {
        let duration = Double(samples.count) / sampleRate
        return DecodedSound(id: id, table: take(id, duration: duration), duration: duration, offset: 0, loopStart: 0, loopEnd: duration)
    }

    private func take(_ id: String, duration: Double) -> Int32 {
        let table = next
        next += 1
        recorder.durations[table] = duration
        recorder.soundNames[table] = id
        return table
    }
}

final class SceneHost: AudioHost {
    var playerId = 1
    var playerIndoors = false
    var playerCrouching = false
    var audioSettings = AudioSettings(master: 1, effects: 1, ambience: 1, interface: 1, hrtf: true)
    var showHitMarkers = true
    var cameraMatrix: [Double] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    var combatants: [Int: (position: Vec3, crouching: Bool)] = [:]
    var occluders: [(min: [Double], max: [Double])] = []
    var rays: [(from: [Double], to: [Double], clear: Bool)] = []

    func combatant(_ id: Int) -> (position: Vec3, crouching: Bool)? { combatants[id] }

    func lineOfSight(_ a: Vec3, _ b: Vec3) -> Bool {
        let clear = !occluders.contains { segmentHitsBox(a, b, $0.min, $0.max) }
        rays.append(([a.x, a.y, a.z], [b.x, b.y, b.z], clear))
        return clear
    }

    /// Slab test, as the exporter's stand-in for World.lineOfSight.
    private func segmentHitsBox(_ a: Vec3, _ b: Vec3, _ lo: [Double], _ hi: [Double]) -> Bool {
        var t0 = 0.0, t1 = 1.0
        let from = [a.x, a.y, a.z], to = [b.x, b.y, b.z]
        for axis in 0..<3 {
            let d = to[axis] - from[axis]
            if d == 0 {
                if from[axis] < lo[axis] || from[axis] > hi[axis] { return false }
                continue
            }
            var near = (lo[axis] - from[axis]) / d
            var far = (hi[axis] - from[axis]) / d
            if near > far { swap(&near, &far) }
            t0 = max(t0, near)
            t1 = min(t1, far)
            if t0 > t1 { return false }
        }
        return true
    }
}

// ---------------------------------------------------------------- scene runner

enum SceneRunner {
    static let rate = 48000.0

    static func run(_ file: URL, lengths: [String: Int], loops: [String: (start: Double, end: Double)]) throws -> (native: SceneTrace, web: SceneTrace, name: String) {
        let root = try Fixtures.json(file)
        let scene = root["scene"] as! [String: Any]
        let maps = root["maps"] as! [String: Any]
        let recorder = TraceRecorder()
        let decoder = FixtureDecoder(lengths: lengths, rate: rate, loops: loops, recorder: recorder)
        let host = SceneHost()
        host.playerId = scene["playerId"] as! Int
        var revision = 0
        host.audioSettings = settings(scene["settings"] as! [String: Any], revision: revision)
        host.showHitMarkers = (scene["settings"] as! [String: Any])["showHitMarkers"] as! Bool
        host.combatants = combatants(scene["combatants"] as! [String: Any])
        host.occluders = (scene["occluders"] as! [[String: Any]]).map { ($0["min"] as! [Double], $0["max"] as! [Double]) }
        let frames = scene["frames"] as! [[String: Any]]
        if let first = frames.first { host.cameraMatrix = first["camera"] as! [Double] }

        var random = SeededRandom(seed: UInt32(scene["seed"] as! Int))
        let engine = AudioEngine(host: host, catalog: Catalog(ids: Array(lengths.keys)), decoder: decoder, sink: recorder, sampleRate: rate,
                                 clock: { [unowned recorder] in recorder.now }, random: { random.next() })
        recorder.onEnded = { [unowned engine] slot, generation in engine.sourceEnded(slot: slot, generation: generation) }
        engine.enterMap(map(scene["map"] as! [String: Any]))
        engine.unlock()
        recorder.pool = engine.voicePool

        var handles: [String: SoundHandle] = [:]
        for (index, frame) in frames.enumerated() {
            recorder.advance(to: frame["time"] as! Double, frame: index)
            host.cameraMatrix = frame["camera"] as! [Double]
            host.playerIndoors = frame["indoors"] as! Bool
            host.playerCrouching = frame["crouching"] as! Bool
            if let s = frame["settings"] as? [String: Any] {
                revision += 1
                host.audioSettings = settings(s, revision: revision)
                host.showHitMarkers = s["showHitMarkers"] as! Bool
            }
            if let c = frame["combatants"] as? [String: Any] { host.combatants = combatants(c) }
            for action in frame["actions"] as! [[String: Any]] {
                perform(action, engine: engine, maps: maps, handles: &handles)
            }
            engine.update(frame["dt"] as! Double)
        }
        var native = recorder.trace
        native.rays = host.rays
        return (native, webTrace(root["trace"] as! [String: Any]), file.deletingPathExtension().lastPathComponent)
    }

    static func perform(_ action: [String: Any], engine: AudioEngine, maps: [String: Any], handles: inout [String: SoundHandle]) {
        switch action["op"] as! String {
        case "event": engine.handle(event(action))
        case "play", "playAt":
            let o = action["options"] as? [String: Any] ?? [:]
            let options = PlaySoundOptions(volume: o["volume"] as? Double, pitch: o["pitch"] as? Double, pitchJitter: o["pitchJitter"] as? Double,
                                           refDistance: o["refDistance"] as? Double, maxDistance: o["maxDistance"] as? Double, loop: o["loop"] as? Bool)
            let id = action["id"] as! String
            let handle = action["op"] as! String == "play" ? engine.play(id, options: options) : engine.playAt(id, position: vec(action["position"]), options: options)
            if let name = action["handle"] as? String { handles[name] = handle }
        case "handleStop": handles[action["handle"] as! String]!.stop(action["fade"] as? Double)
        case "handleVolume": handles[action["handle"] as! String]!.setVolume(action["volume"] as! Double)
        case "pause": engine.setPaused(action["paused"] as! Bool)
        case "reverb": engine.setReverb(ReverbPreset(rawValue: action["preset"] as! String)!)
        case "leaveMap": engine.leaveMap()
        case "enterMap": engine.enterMap(map(maps[action["map"] as! String] as! [String: Any]))
        case let op: fatalError("unknown action \(op)")
        }
    }

    static func event(_ e: [String: Any]) -> AudioEvent {
        func weapon() -> AudioWeapon {
            let w = e["weapon"] as! [String: Any]
            return AudioWeapon(id: w["id"] as! String, weaponClass: w["weaponClass"] as! String, loudness: w["loudness"] as! Double, muzzleVelocity: w["muzzleVelocity"] as! Double)
        }
        func int(_ key: String) -> Int { e[key] as! Int }
        func bool(_ key: String) -> Bool { e[key] as! Bool }
        func surface(_ name: Any?) -> Surface { Surface.allCases.first { $0.name == name as! String }! }
        switch e["type"] as! String {
        case "shotFired": return .shotFired(shooterId: int("shooterId"), weapon: weapon(), muzzle: vec(e["muzzle"]), local: bool("local"))
        case "nearMiss": return .nearMiss(point: vec(e["point"]), weapon: weapon())
        case "bulletImpact":
            let hit = e["hit"] as! [String: Any]
            return .bulletImpact(point: vec(hit["point"]), normal: vec(hit["normal"]), surface: surface(hit["surface"]))
        case "combatantHit":
            let hit = e["hit"] as! [String: Any]
            return .combatantHit(targetId: int("targetId"), attackerId: int("attackerId"), point: vec(hit["point"]), fatal: bool("fatal"))
        case "dryFire": return .dryFire(shooterId: int("shooterId"), weapon: weapon(), position: vec(e["position"]))
        case "weaponAction":
            return .weaponAction(shooterId: int("shooterId"), weapon: weapon(), stage: WeaponActionStage(rawValue: e["stage"] as! String)!, position: vec(e["position"]), local: bool("local"))
        case "weaponSwitch": return .weaponSwitch(shooterId: int("shooterId"), weapon: weapon(), local: bool("local"))
        case "casingLanded": return .casingLanded(kind: CasingKind(rawValue: e["kind"] as! String)!, position: vec(e["position"]), surface: surface(e["surface"]))
        case "aimChanged": return .aimChanged(aiming: bool("aiming"))
        case "footstep": return .footstep(ownerId: int("ownerId"), position: vec(e["position"]), surface: surface(e["surface"]), running: bool("running"), local: bool("local"))
        case "jumped": return .jumped(ownerId: int("ownerId"), position: vec(e["position"]), local: bool("local"))
        case "landed": return .landed(ownerId: int("ownerId"), position: vec(e["position"]), surface: surface(e["surface"]), speed: e["speed"] as! Double, local: bool("local"))
        case "playerHurt": return .playerHurt(amount: e["amount"] as! Double, direction: vec(e["direction"]))
        case "died": return .died(victimId: int("victimId"))
        case "botCallout": return .botCallout(botId: int("botId"), kind: BotCalloutKind(rawValue: e["kind"] as! String)!, position: vec(e["position"]))
        case "grenadeThrown": return .grenadeThrown(ownerId: int("ownerId"), position: vec(e["position"]), local: bool("local"))
        case "grenadeBounced": return .grenadeBounced(position: vec(e["position"]), speed: e["speed"] as! Double, surface: surface(e["surface"]))
        case "grenadeExploded": return .grenadeExploded(position: vec(e["position"]))
        case "matchState": return .matchState(playing: e["phase"] as! String == "playing", health: e["health"] as! Double)
        case let type: fatalError("unknown event \(type)")
        }
    }

    static func vec(_ value: Any?) -> Vec3 {
        let a = value as! [Double]
        return Vec3(a[0], a[1], a[2])
    }

    static func settings(_ s: [String: Any], revision: Int) -> AudioSettings {
        AudioSettings(master: s["master"] as! Double, effects: s["effects"] as! Double, ambience: s["ambience"] as! Double,
                      interface: s["interface"] as! Double, hrtf: s["hrtf"] as! Bool, revision: revision)
    }

    static func combatants(_ c: [String: Any]) -> [Int: (position: Vec3, crouching: Bool)] {
        var out: [Int: (position: Vec3, crouching: Bool)] = [:]
        for (id, value) in c {
            let v = value as! [String: Any]
            out[Int(id)!] = (vec(v["position"]), v["crouching"] as! Bool)
        }
        return out
    }

    static func map(_ m: [String: Any]) -> MapAudio {
        MapAudio(
            reverb: ReverbPreset(rawValue: m["reverb"] as! String)!,
            weather: m["weather"] as! String,
            ambience: (m["ambience"] as! [[String: Any]]).map {
                MapAudio.Layer(sound: $0["sound"] as! String, volume: $0["volume"] as! Double, position: $0["position"].map(vec), radius: $0["radius"] as? Double)
            },
            interiors: (m["interiors"] as! [[String: Any]]).map {
                MapAudio.Interior(min: vec($0["min"]), max: vec($0["max"]), reverb: ReverbPreset(rawValue: $0["reverb"] as! String)!)
            }
        )
    }

    static func automations(_ value: Any?) -> [Automation] {
        (value as! [[Any]]).map { e in
            let kind: AutomationKind = switch e[0] as! String { case "set": .set; case "lin": .lin; case "target": .target; default: .cancel }
            return Automation(kind, time: number(e[1]), value: number(e[2]), tau: number(e[3]))
        }
    }

    static func number(_ value: Any?) -> Double { (value as? NSNumber)?.doubleValue ?? .nan }

    static func webTrace(_ t: [String: Any]) -> SceneTrace {
        var trace = SceneTrace()
        trace.voices = (t["voices"] as! [[String: Any]]).map { v in
            VoiceTrace(
                frame: v["frame"] as! Int, kind: v["kind"] as! String, slot: v["slot"] as! Int, sound: v["sound"] as! String, bus: v["bus"] as! String,
                start: number(v["start"]), offset: number(v["offset"]), rate: number(v["rate"]), loop: v["loop"] as! Bool,
                loopStart: number(v["loopStart"]), loopEnd: number(v["loopEnd"]), positional: v["positional"] as! Bool,
                position: v["position"] as? [Double], pan: number(v["pan"]), occlusion: number(v["occlusion"]), hrtf: v["hrtf"] as! [Bool],
                gain: automations(v["gain"]), cutoff: automations(v["cutoff"]), send: automations(v["send"]),
                stop: v["stop"] is NSNull ? nil : number(v["stop"]), end: v["end"] is NSNull ? nil : number(v["end"]), endFrame: v["endFrame"] as? Int
            )
        }
        for (name, events) in t["buses"] as! [String: Any] { trace.buses[name] = automations(events) }
        trace.reverb = (t["reverb"] as! [[Any]]).map { ($0[0] as! Int, $0[1] as! Int, $0[2] as? String) }
        trace.rays = (t["rays"] as! [[Any]]).map { ($0[0] as! [Double], $0[1] as! [Double], $0[2] as! Bool) }
        return trace
    }
}

// ---------------------------------------------------------------- comparison

enum TraceDiff {
    static let tolerance = 1e-6

    static func close(_ a: Double, _ b: Double) -> Bool {
        if a.isInfinite || b.isInfinite { return a == b }
        return abs(a - b) <= tolerance
    }

    static func closeOpt(_ a: Double?, _ b: Double?) -> Bool {
        switch (a, b) {
        case (nil, nil): true
        case let (x?, y?): close(x, y)
        default: false
        }
    }

    static func events(_ a: [Automation], _ b: [Automation]) -> String? {
        if a.count != b.count { return "\(a.count) events vs \(b.count)" }
        for (i, (x, y)) in zip(a, b).enumerated() where x.kind != y.kind || !close(x.time, y.time) || !close(x.value, y.value) || !close(x.tau, y.tau) {
            return "event \(i): \(x) vs \(y)"
        }
        return nil
    }

    /// Largest absolute difference over every number the two traces share (voices, bus automation).
    static func maxDeviation(native n: SceneTrace, web w: SceneTrace) -> Double {
        var worst = 0.0
        func take(_ a: Double, _ b: Double) { if a.isFinite && b.isFinite { worst = max(worst, abs(a - b)) } }
        func takeEvents(_ a: [Automation], _ b: [Automation]) {
            for (x, y) in zip(a, b) { take(x.time, y.time); take(x.value, y.value); take(x.tau, y.tau) }
        }
        for (a, b) in zip(n.voices, w.voices) {
            for (x, y) in [(a.start, b.start), (a.offset, b.offset), (a.rate, b.rate), (a.loopStart, b.loopStart), (a.loopEnd, b.loopEnd), (a.pan, b.pan), (a.occlusion, b.occlusion)] { take(x, y) }
            for (x, y) in zip(a.position ?? [], b.position ?? []) { take(x, y) }
            if let x = a.stop, let y = b.stop { take(x, y) }
            if let x = a.end, let y = b.end { take(x, y) }
            takeEvents(a.gain, b.gain)
            takeEvents(a.cutoff, b.cutoff)
            takeEvents(a.send, b.send)
        }
        for (name, events) in w.buses { takeEvents(n.buses[name] ?? [], events) }
        return worst
    }

    /// Every difference between the native and the web trace, as readable lines (empty when they match).
    static func compare(native n: SceneTrace, web w: SceneTrace, limit: Int = 12) -> [String] {
        var out: [String] = []
        func note(_ s: String) { if out.count < limit { out.append(s) } }
        if n.voices.count != w.voices.count { note("voice count \(n.voices.count) vs web \(w.voices.count)") }
        for (i, (a, b)) in zip(n.voices, w.voices).enumerated() {
            var fields: [String] = []
            if a.frame != b.frame { fields.append("frame \(a.frame)/\(b.frame)") }
            if a.kind != b.kind { fields.append("kind") }
            if a.slot != b.slot { fields.append("slot \(a.slot)/\(b.slot)") }
            if a.sound != b.sound { fields.append("sound \(a.sound)/\(b.sound)") }
            if a.bus != b.bus { fields.append("bus \(a.bus)/\(b.bus)") }
            if !close(a.start, b.start) { fields.append("start \(a.start)/\(b.start)") }
            if !close(a.offset, b.offset) { fields.append("offset \(a.offset)/\(b.offset)") }
            if !close(a.rate, b.rate) { fields.append("rate \(a.rate)/\(b.rate)") }
            if a.loop != b.loop || !close(a.loopStart, b.loopStart) || !close(a.loopEnd, b.loopEnd) { fields.append("loop") }
            if a.positional != b.positional { fields.append("positional") }
            if (a.position == nil) != (b.position == nil) || zip(a.position ?? [], b.position ?? []).contains(where: { !close($0, $1) }) { fields.append("position") }
            if !close(a.pan, b.pan) { fields.append("pan \(a.pan)/\(b.pan)") }
            if !close(a.occlusion, b.occlusion) { fields.append("occlusion \(a.occlusion)/\(b.occlusion)") }
            if a.hrtf != b.hrtf { fields.append("hrtf \(a.hrtf)/\(b.hrtf)") }
            if let d = events(a.gain, b.gain) { fields.append("gain \(d)") }
            if let d = events(a.cutoff, b.cutoff) { fields.append("cutoff \(d)") }
            if let d = events(a.send, b.send) { fields.append("send \(d)") }
            if !closeOpt(a.stop, b.stop) { fields.append("stop \(String(describing: a.stop))/\(String(describing: b.stop))") }
            if !closeOpt(a.end, b.end) || a.endFrame != b.endFrame { fields.append("end \(String(describing: a.end))@\(String(describing: a.endFrame))/\(String(describing: b.end))@\(String(describing: b.endFrame))") }
            if !fields.isEmpty { note("voice \(i) (\(b.sound) slot \(b.slot) frame \(b.frame)): " + fields.joined(separator: "; ")) }
        }
        for (name, events) in w.buses {
            if let d = TraceDiff.events(n.buses[name] ?? [], events) { note("bus \(name): \(d)") }
        }
        if n.reverb.count != w.reverb.count || zip(n.reverb, w.reverb).contains(where: { $0.frame != $1.frame || $0.slot != $1.slot || $0.preset != $1.preset }) {
            note("reverb \(n.reverb) vs \(w.reverb)")
        }
        if n.rays.count != w.rays.count { note("rays \(n.rays.count) vs \(w.rays.count)") }
        for (i, (a, b)) in zip(n.rays, w.rays).enumerated() where a.clear != b.clear || zip(a.from + a.to, b.from + b.to).contains(where: { !close($0, $1) }) {
            note("ray \(i): \(a) vs \(b)")
            break
        }
        return out
    }
}
