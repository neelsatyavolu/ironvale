// MixCore (PLAN.md 3.8): the realtime half of the audio engine. It mirrors the Web Audio graph
// of src/audio/graph.ts and pool.ts inside one render callback:
//
//   44 voices: source (resampling read head, loop points, sample-accurate start and stop)
//              -> biquad low-pass -> gain -> equal-power / stereo pan -> effects | ambience | interface
//                                       \-> send -> reverb input (convolution arrives in M8b)
//   beds:      source -> gain -> bed filter | ambience loops
//   bed filter + ambience loops -> duck -> ambience -> world;  effects -> world
//   world -> narrow low-pass -> master;  interface -> master
//   master -> limiter -> trim -> soft clip -> out
//
// Threading: the main thread only calls `enqueue` (and `registerSound` before the sound is used);
// the render thread only calls `render`. All render state is preallocated; `render` takes no
// locks and allocates nothing (checked by the malloc-hook test).

import Foundation
import IronvaleWorld
import Synchronization

public final class MixCore: @unchecked Sendable {
    public static let voiceCount = VoicePool.slotCount
    public static let bedCount = 8
    public static let maxFrames = 4096
    public static let soundCapacity = 1024
    /// Stereo bus buffers: two lanes per `Bus` case.
    static let busLanes = Bus.allCases.count * 2

    public let sampleRate: Double
    /// Main -> render commands.
    public let commands: SPSCRing<MixCommand>
    /// Render -> main: (slot, generation) of voice sources that fell silent.
    public let ended: SPSCRing<EndedVoice>
    /// Multiplies the final output (after the soft clip). 0 renders everything and outputs silence.
    public let outputGain = Atomic<UInt32>(Float(1).bitPattern)

    // Sound table: rows written by the main thread before they are published through `soundCount`.
    private let sounds: UnsafeMutablePointer<SoundRow>
    private let soundCount = Atomic<Int>(0)

    private let voices: UnsafeMutablePointer<Voice>
    private let beds: UnsafeMutablePointer<Voice>
    private var busParams: UnsafeMutablePointer<RenderParam>
    private let scratch: UnsafeMutablePointer<Float>
    private let busBuffers: UnsafeMutablePointer<Float>
    private var bedFilter = Biquad()
    private var narrow = Biquad()
    private var limiter: Limiter
    private let clip = SoftClip()
    private var listener = (position: (0.0, 0.0, 0.0), forward: (0.0, 0.0, -1.0), up: (0.0, 1.0, 0.0))

    /// Frames rendered so far; the audio clock is this over the sample rate.
    private let rendered = Atomic<Int64>(0)
    /// Render calls that took longer than their buffer's duration.
    public let overruns = Atomic<Int>(0)
    /// Longest render call, in nanoseconds.
    public let longestRenderNanos = Atomic<Int>(0)
    public let renderCalls = Atomic<Int>(0)

    public struct EndedVoice: Sendable, BitwiseCopyable {
        public let slot: Int32
        public let generation: UInt32
    }

    struct SoundRow {
        var samples: UnsafeMutablePointer<Float>?
        var frames = 0
        var channels = 1
        var sampleRate = 44100.0
    }

    struct Voice {
        var playing = false
        var generation: UInt32 = 0
        var sound: Int32 = -1
        var position = 0.0
        var step = 1.0
        var startSample: Int64 = 0
        var stopSample: Int64 = .max
        var loop = false
        var loopStart = 0.0
        var loopEnd = 0.0
        var bus = BusName.effects
        var bedDestination = BedDestination.bedFilter
        var positional = false
        var source = (0.0, 0.0, 0.0)
        var pan = 0.0
        var gain: RenderParam
        var cutoff: RenderParam
        var send: RenderParam
        var filter = Biquad()
    }

    // Scratch layout (Float32, maxFrames each).
    private enum Lane: Int, CaseIterable {
        case gain, cutoff, send, busA, busB, busC, busD
    }
    // Stereo bus buffers (2 * maxFrames each).
    private enum Bus: Int, CaseIterable {
        case effects, ambienceLoops, bedFilterIn, interface, reverbIn, world, master
    }

    public init(sampleRate: Double) {
        self.sampleRate = sampleRate
        commands = SPSCRing(capacity: 8192)
        ended = SPSCRing(capacity: 1024)
        sounds = .allocate(capacity: MixCore.soundCapacity)
        sounds.initialize(repeating: SoundRow(), count: MixCore.soundCapacity)
        voices = .allocate(capacity: MixCore.voiceCount)
        for i in 0..<MixCore.voiceCount {
            (voices + i).initialize(to: Voice(gain: RenderParam(initial: 0), cutoff: RenderParam(initial: VoicePool.openHz), send: RenderParam(initial: 0)))
            voices[i].filter.setLowpass(frequency: Float(VoicePool.openHz), qDB: 0.6, sampleRate: sampleRate)
        }
        beds = .allocate(capacity: MixCore.bedCount)
        for i in 0..<MixCore.bedCount {
            (beds + i).initialize(to: Voice(gain: RenderParam(initial: 0), cutoff: RenderParam(initial: 0), send: RenderParam(initial: 0)))
        }
        busParams = .allocate(capacity: BusParam.allCases.count)
        for bus in BusParam.allCases { (busParams + bus.rawValue).initialize(to: RenderParam(initial: bus.initial)) }
        scratch = .allocate(capacity: Lane.allCases.count * MixCore.maxFrames)
        busBuffers = .allocate(capacity: MixCore.busLanes * MixCore.maxFrames)
        bedFilter.setLowpass(frequency: 20000, qDB: 0.5, sampleRate: sampleRate)
        narrow.setLowpass(frequency: 20000, qDB: 0.5, sampleRate: sampleRate)
        limiter = Limiter(sampleRate: sampleRate)
    }

    deinit {
        for i in 0..<MixCore.voiceCount { voices[i].gain.free(); voices[i].cutoff.free(); voices[i].send.free() }
        for i in 0..<MixCore.bedCount { beds[i].gain.free(); beds[i].cutoff.free(); beds[i].send.free() }
        for bus in BusParam.allCases { busParams[bus.rawValue].free() }
        for i in 0..<soundCount.load(ordering: .acquiring) { sounds[i].samples?.deallocate() }
        voices.deallocate()
        beds.deallocate()
        busParams.deallocate()
        sounds.deallocate()
        scratch.deallocate()
        busBuffers.deallocate()
        clip.free()
    }

    /// Seconds of audio rendered; the engine's `now`.
    public var currentTime: Double { Double(rendered.load(ordering: .acquiring)) / sampleRate }

    /// Main thread: copy PCM (channel-major) into the table and return its row.
    public func registerSound(samples: [Float], frames: Int, channels: Int, sampleRate rate: Double) -> Int32 {
        let row = soundCount.load(ordering: .relaxed)
        precondition(row < MixCore.soundCapacity, "MixCore sound table is full")
        let storage = UnsafeMutablePointer<Float>.allocate(capacity: max(1, samples.count))
        samples.withUnsafeBufferPointer { storage.initialize(from: $0.baseAddress!, count: samples.count) }
        sounds[row] = SoundRow(samples: storage, frames: frames, channels: channels, sampleRate: rate)
        soundCount.store(row + 1, ordering: .releasing)
        return Int32(row)
    }

    public func setOutputGain(_ gain: Float) { outputGain.store(gain.bitPattern, ordering: .relaxed) }

    // ---------------------------------------------------------------- render thread

    /// Render `frames` stereo frames into `left` and `right`.
    public func render(frames total: Int, left: UnsafeMutablePointer<Float>, right: UnsafeMutablePointer<Float>) {
        let began = DispatchTime.now().uptimeNanoseconds
        var done = 0
        while done < total {
            let frames = min(MixCore.maxFrames, total - done)
            renderBlock(frames: frames, left: left + done, right: right + done)
            done += frames
        }
        let took = Int(DispatchTime.now().uptimeNanoseconds - began)
        renderCalls.add(1, ordering: .relaxed)
        if Double(took) > Double(total) / sampleRate * 1e9 { overruns.add(1, ordering: .relaxed) }
        var longest = longestRenderNanos.load(ordering: .relaxed)
        while took > longest {
            let (exchanged, original) = longestRenderNanos.compareExchange(expected: longest, desired: took, ordering: .relaxed)
            if exchanged { break }
            longest = original
        }
    }

    private func lane(_ lane: Lane) -> UnsafeMutablePointer<Float> { scratch + lane.rawValue * MixCore.maxFrames }
    private func bus(_ bus: Bus) -> (UnsafeMutablePointer<Float>, UnsafeMutablePointer<Float>) {
        let base = busBuffers + bus.rawValue * 2 * MixCore.maxFrames
        return (base, base + MixCore.maxFrames)
    }

    private func renderBlock(frames: Int, left: UnsafeMutablePointer<Float>, right: UnsafeMutablePointer<Float>) {
        let blockStart = rendered.load(ordering: .relaxed)
        drainCommands()
        // Clear only what this block uses of each bus channel.
        var lane = 0
        while lane < MixCore.busLanes {
            (busBuffers + lane * MixCore.maxFrames).update(repeating: 0, count: frames)
            lane += 1
        }
        let t0 = Double(blockStart) / sampleRate
        let dt = 1 / sampleRate
        let soundsReady = soundCount.load(ordering: .acquiring)

        for i in 0..<MixCore.voiceCount {
            renderVoice(voices + i, slot: i, isBed: false, frames: frames, blockStart: blockStart, t0: t0, dt: dt, soundsReady: soundsReady)
        }
        for i in 0..<MixCore.bedCount {
            renderVoice(beds + i, slot: i, isBed: true, frames: frames, blockStart: blockStart, t0: t0, dt: dt, soundsReady: soundsReady)
        }
        mixBuses(frames: frames, t0: t0, dt: dt, left: left, right: right)
        rendered.store(blockStart + Int64(frames), ordering: .releasing)
    }

    private func renderVoice(_ v: UnsafeMutablePointer<Voice>, slot: Int, isBed: Bool, frames: Int, blockStart: Int64, t0: Double, dt: Double, soundsReady: Int) {
        let gains = lane(.gain)
        let cutoffs = lane(.cutoff)
        let sends = lane(.send)
        v.pointee.gain.render(gains, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        if !isBed {
            v.pointee.cutoff.render(cutoffs, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
            v.pointee.send.render(sends, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        }
        guard v.pointee.playing else { return }
        let soundIndex = Int(v.pointee.sound)
        guard soundIndex >= 0, soundIndex < soundsReady, let samples = sounds[soundIndex].samples else {
            finish(v, slot: slot, isBed: isBed)
            return
        }
        let row = sounds[soundIndex]
        let blockEnd = blockStart + Int64(frames)
        let first = Int(max(0, v.pointee.startSample - blockStart))
        if first >= frames { return }
        let stop = v.pointee.stopSample
        let last = stop >= blockEnd ? frames : Int(max(0, stop - blockStart))
        if last <= first {
            if stop < blockEnd { finish(v, slot: slot, isBed: isBed) }
            return
        }

        // Output routing and pan for this block (the panner is evaluated per block, k-rate).
        let target: (UnsafeMutablePointer<Float>, UnsafeMutablePointer<Float>)
        if isBed {
            target = bus(v.pointee.bedDestination == .bedFilter ? .bedFilterIn : .ambienceLoops)
        } else {
            switch v.pointee.bus {
            case .effects: target = bus(.effects)
            case .ambience: target = bus(.ambienceLoops)
            case .interface: target = bus(.interface)
            }
        }
        let reverb = bus(.reverbIn)
        let stereo = row.channels > 1
        let panValue: Double
        var monoL: Float = 1, monoR: Float = 0
        if !isBed && v.pointee.positional {
            let azimuth = Panning.equalPowerAzimuth(listener: listener.position, forward: listener.forward, up: listener.up, source: v.pointee.source)
            panValue = azimuth / 90
            (monoL, monoR) = Panning.monoGains(azimuth: azimuth)
        } else {
            panValue = isBed ? 0 : v.pointee.pan
            (monoL, monoR) = Panning.monoGains(azimuth: panValue * 90)
        }
        let law = Panning.stereoLaw(panValue)
        let channelStride = row.frames
        let frameCount = Double(row.frames)
        var position = v.pointee.position
        let step = v.pointee.step
        var finished = false
        var filter = v.pointee.filter

        for i in first..<last {
            if !isBed, i & 15 == 0 || filter.cutoff < 0 {
                let c = cutoffs[i]
                if abs(c - filter.cutoff) > 0.0005 * max(1, c) { filter.setLowpass(frequency: c, qDB: 0.6, sampleRate: sampleRate) }
            }
            if v.pointee.loop {
                if position >= v.pointee.loopEnd { position -= v.pointee.loopEnd - v.pointee.loopStart }
            } else if position >= frameCount - 1 {
                finished = true
                break
            }
            let index = max(0, min(row.frames - 2, Int(position)))
            let frac = Float(position - Double(index))
            var l = samples[index] + (samples[index + 1] - samples[index]) * frac
            var r = l
            if stereo {
                let base = samples + channelStride
                r = base[index] + (base[index + 1] - base[index]) * frac
            }
            if !isBed {
                l = filter.left(l)
                if stereo { r = filter.right(r) } else { r = l }
            }
            let g = gains[i]
            l *= g
            r *= g
            if !isBed {
                let s = sends[i]
                reverb.0[i] += l * s
                reverb.1[i] += r * s
            }
            if stereo {
                if law.toLeft {
                    target.0[i] += l + r * law.cosine
                    target.1[i] += r * law.sine
                } else {
                    target.0[i] += l * law.cosine
                    target.1[i] += r + l * law.sine
                }
            } else {
                target.0[i] += l * monoL
                target.1[i] += l * monoR
            }
            position += step
        }
        v.pointee.position = position
        v.pointee.filter = filter
        if finished || stop < blockEnd { finish(v, slot: slot, isBed: isBed) }
    }

    private func finish(_ v: UnsafeMutablePointer<Voice>, slot: Int, isBed: Bool) {
        v.pointee.playing = false
        if !isBed { ended.push(EndedVoice(slot: Int32(slot), generation: v.pointee.generation)) }
    }

    private func mixBuses(frames: Int, t0: Double, dt: Double, left: UnsafeMutablePointer<Float>, right: UnsafeMutablePointer<Float>) {
        let a = lane(.busA), b = lane(.busB), c = lane(.busC), d = lane(.busD)
        let effects = bus(.effects), loops = bus(.ambienceLoops), beds = bus(.bedFilterIn), interface = bus(.interface)
        let world = bus(.world), master = bus(.master)
        // Beds through the indoor low-pass, plus loops, ducked, then the ambience level.
        busParams[BusParam.bedFilter.rawValue].render(a, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        busParams[BusParam.ambienceLoops.rawValue].render(b, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        busParams[BusParam.duck.rawValue].render(c, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        busParams[BusParam.ambience.rawValue].render(d, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        for i in 0..<frames {
            if i & 15 == 0, abs(a[i] - bedFilter.cutoff) > 0.0005 * max(1, a[i]) { bedFilter.setLowpass(frequency: a[i], qDB: 0.5, sampleRate: sampleRate) }
            let duck = c[i] * d[i]
            world.0[i] = (bedFilter.left(beds.0[i]) + loops.0[i] * b[i]) * duck
            world.1[i] = (bedFilter.right(beds.1[i]) + loops.1[i] * b[i]) * duck
        }
        busParams[BusParam.effects.rawValue].render(a, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        busParams[BusParam.world.rawValue].render(b, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        busParams[BusParam.mix.rawValue].render(c, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        busParams[BusParam.interface.rawValue].render(d, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        for i in 0..<frames {
            if i & 15 == 0, abs(c[i] - narrow.cutoff) > 0.0005 * max(1, c[i]) { narrow.setLowpass(frequency: c[i], qDB: 0.5, sampleRate: sampleRate) }
            let wl = (world.0[i] + effects.0[i] * a[i]) * b[i]
            let wr = (world.1[i] + effects.1[i] * a[i]) * b[i]
            master.0[i] = narrow.left(wl) + interface.0[i] * d[i]
            master.1[i] = narrow.right(wr) + interface.1[i] * d[i]
        }
        // Reverb slot gains and the send bus keep time; convolution itself is M8b.
        busParams[BusParam.reverbIn.rawValue].render(a, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        busParams[BusParam.reverb0.rawValue].render(a, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        busParams[BusParam.reverb1.rawValue].render(a, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        busParams[BusParam.master.rawValue].render(b, frames: frames, t0: t0, dt: dt, sampleRate: sampleRate)
        let out = Float(bitPattern: outputGain.load(ordering: .relaxed))
        let trim = Float(AudioGraph.limiterTrim)
        for i in 0..<frames {
            let l = master.0[i] * b[i], r = master.1[i] * b[i]
            let g = limiter.gain(peak: max(abs(l), abs(r))) * trim
            left[i] = clip.apply(l * g) * out
            right[i] = clip.apply(r * g) * out
        }
    }

    private func drainCommands() {
        while let command = commands.pop() { apply(command) }
    }

    private func apply(_ command: MixCommand) {
        switch command {
        case let .param(id, event):
            switch id {
            case let .bus(bus): busParams[bus.rawValue].apply(event)
            case let .voice(slot, param):
                let v = voices + Int(slot)
                switch param {
                case .gain: v.pointee.gain.apply(event)
                case .cutoff: v.pointee.cutoff.apply(event)
                case .send: v.pointee.send.apply(event)
                }
            case let .bed(bed): beds[Int(bed) % MixCore.bedCount].gain.apply(event)
            }
        case let .startVoice(slot, start):
            begin(voices + Int(slot), start)
        case let .stopVoice(slot, generation, when):
            let v = voices + Int(slot)
            if v.pointee.generation == generation { v.pointee.stopSample = Int64((when * sampleRate).rounded()) }
        case let .route(slot, bus, positional):
            voices[Int(slot)].bus = bus
            voices[Int(slot)].positional = positional
        case let .position(slot, x, y, z):
            voices[Int(slot)].source = (x, y, z)
        case let .stereoPan(slot, pan):
            voices[Int(slot)].pan = pan
        case .panningModel:
            // HRTF lanes are M8b; every voice pans equal-power until then.
            break
        case let .startBed(bed, start, destination):
            let v = beds + Int(bed) % MixCore.bedCount
            v.pointee.bedDestination = destination
            begin(v, start)
        case let .stopBed(bed, when):
            beds[Int(bed) % MixCore.bedCount].stopSample = Int64((when * sampleRate).rounded())
        case let .listener(pose):
            listener = ((pose.px, pose.py, pose.pz), (pose.fx, pose.fy, pose.fz), (pose.ux, pose.uy, pose.uz))
        case .reverbImpulse, .playBegin, .playEnd:
            break
        }
    }

    private func begin(_ v: UnsafeMutablePointer<Voice>, _ start: SourceStart) {
        let row = Int(start.sound)
        let rate = row >= 0 && row < MixCore.soundCapacity ? sounds[row].sampleRate : sampleRate
        v.pointee.playing = true
        v.pointee.generation = start.generation
        v.pointee.sound = start.sound
        v.pointee.position = start.offset * rate
        v.pointee.step = start.rate * rate / sampleRate
        v.pointee.startSample = Int64((start.start * sampleRate).rounded())
        v.pointee.stopSample = .max
        v.pointee.loop = start.loop
        v.pointee.loopStart = start.loopStart * rate
        v.pointee.loopEnd = start.loopEnd * rate
    }
}
