// `--audio-report SECONDS`: every SECONDS of play, log what the audio did since launch: the output
// device and rate, the AudioEvents delivered by kind, the voices and beds MixCore was told to start
// (by sound-id family: snd-step-*, snd-m4a1-*, ...), and the peak level reaching the output.
import AVFoundation
import Foundation
import IronvaleAudio
import os
import Synchronization

@MainActor
final class AudioReport {
    private static let logger = Logger(subsystem: "dev.n3el.ironvale", category: "audio")
    private let every: Double
    private var elapsed = 0.0
    private var events: [String: Int] = [:]
    private var voices: [String: Int] = [:]
    private var beds: [String: Int] = [:]
    private let meter = PeakMeter()
    var route = "no output"

    init(every: Double) { self.every = max(1, every) }

    /// Count what `session` starts, and meter what its output plays.
    func watch(_ session: AudioSession) {
        let library = session.library
        session.monitor = { [weak self] command in
            switch command {
            case let .startVoice(_, start): self?.voices[Self.family(library.tableIds[start.sound]), default: 0] += 1
            case let .startBed(_, start, _): self?.beds[Self.family(library.tableIds[start.sound]), default: 0] += 1
            default: break
            }
        }
        guard let mixer = session.output?.engine.mainMixerNode else { return }
        mixer.removeTap(onBus: 0)
        mixer.installTap(onBus: 0, bufferSize: 2048, format: nil, block: Self.tap(meter))
    }

    /// The tap runs on an AVFAudio thread: its block must not inherit the main actor.
    private nonisolated static func tap(_ meter: PeakMeter) -> AVAudioNodeTapBlock {
        { buffer, _ in meter.take(buffer) }
    }

    func delivered(_ batch: [AudioEvent]) {
        for event in batch { events[Self.name(event), default: 0] += 1 }
    }

    func frame(_ dt: Double, voicesPlaying: Int) {
        elapsed += dt
        if elapsed < every { return }
        elapsed = 0
        let peak = meter.peak
        let db = peak > 0 ? String(format: "%.1f dBFS", 20 * log10(Double(peak))) : "silent"
        let line = "audio report: \(route) | peak \(db) | playing \(voicesPlaying) | events \(Self.list(events)) | voices \(Self.list(voices)) | beds \(Self.list(beds))"
        FileHandle.standardError.write(Data((line + "\n").utf8))
        Self.logger.info("\(line, privacy: .public)")
    }

    private static func list(_ counts: [String: Int]) -> String {
        "\(counts.values.reduce(0, +)) {" + counts.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: ", ") + "}"
    }

    /// "snd-step-gravel-run-3" -> "step", "snd-m4a1-shot-close-1" -> "m4a1".
    private static func family(_ id: String?) -> String {
        guard let id else { return "?" }
        let parts = id.split(separator: "-")
        return parts.count > 1 && parts[0] == "snd" ? String(parts[1]) : id
    }

    private static func name(_ event: AudioEvent) -> String {
        switch event {
        case .shotFired: "shotFired"
        case .nearMiss: "nearMiss"
        case .bulletImpact: "bulletImpact"
        case .combatantHit: "combatantHit"
        case .dryFire: "dryFire"
        case .weaponAction: "weaponAction"
        case .weaponSwitch: "weaponSwitch"
        case .casingLanded: "casingLanded"
        case .aimChanged: "aimChanged"
        case .footstep: "footstep"
        case .jumped: "jumped"
        case .landed: "landed"
        case .playerHurt: "playerHurt"
        case .died: "died"
        case .botCallout: "botCallout"
        case .grenadeThrown: "grenadeThrown"
        case .grenadeBounced: "grenadeBounced"
        case .grenadeExploded: "grenadeExploded"
        case .matchState: "matchState"
        }
    }
}

/// Highest absolute sample seen on the output, written from the tap's thread.
private final class PeakMeter: Sendable {
    private let bits = Atomic<UInt32>(0)

    var peak: Float { Float(bitPattern: bits.load(ordering: .relaxed)) }

    func take(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData else { return }
        var top: Float = 0
        for channel in 0..<Int(buffer.format.channelCount) {
            for i in 0..<Int(buffer.frameLength) { top = max(top, abs(data[channel][i])) }
        }
        // Non-negative floats order like their bit patterns.
        bits.max(top.bitPattern, ordering: .relaxed)
    }
}
