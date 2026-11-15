// M8 audio in the app (src/game/game.ts: createAudio, audio.enterMap / leaveMap / setPaused /
// update, and the 1/20 s matchState snapshot). The sim's GameEvents are gathered during the frame
// and handed to the AudioSession with the frame's update, as the web's bus delivers them before
// `audio.update`. Playback follows the system output device (OutputDeviceWatcher): a new device
// moves the output, a new sample rate rebuilds MixCore at that rate. Audio that cannot start is
// logged and the match goes on silent.
import AVFoundation
import Foundation
import IronvaleAI
import IronvaleAudio
import IronvaleFX
import IronvaleMapData
import IronvaleSim
import IronvaleUI
import IronvaleWorld
import os

@MainActor
final class GameAudio {
    private static let logger = Logger(subsystem: "dev.n3el.ironvale", category: "audio")
    /// PLAN.md 3.8: 128 frames on the built-in output; Bluetooth and other outputs keep their own size.
    static let builtInBufferFrames: UInt32 = 128
    /// game.ts SNAPSHOT_INTERVAL.
    static let snapshotInterval = 1.0 / 20
    /// Device changes arrive in bursts (default device, then its rate, then the engine's notice).
    static let rerouteDelay = Duration.milliseconds(250)

    private let repositoryRoot: URL
    private let game: Game
    private let host: GameAudioHost
    private let weapons: [String: AudioWeapon]
    private let report: AudioReport?
    private var session: AudioSession?
    private var watcher: OutputDeviceWatcher?
    private var device: AudioObjectID?
    private var configObserver: (any NSObjectProtocol)?
    private var rerouteTask: Task<Void, Never>?
    private var map: MapAudio?
    private var paused = false
    private var pending: [AudioEvent] = []
    private var snapshotTimer = 0.0
    private var unsubscribe: (() -> Void)?

    /// nil for automated runs (Presentation.background), so check scripts stay silent and repeatable.
    /// IRONVALE_AUDIO=1 plays audio in a background run anyway (verification); IRONVALE_AUDIO=0 never does.
    static func make(game: Game, bots: BotManager, repositoryRoot: URL, reportEvery: Double?) -> GameAudio? {
        let env = ProcessInfo.processInfo.environment["IRONVALE_AUDIO"]
        if env == "0" || (Presentation.background && env != "1") { return nil }
        return GameAudio(game: game, bots: bots, repositoryRoot: repositoryRoot, reportEvery: reportEvery)
    }

    private init(game: Game, bots: BotManager, repositoryRoot: URL, reportEvery: Double?) {
        self.game = game
        self.repositoryRoot = repositoryRoot
        host = GameAudioHost(game: game)
        weapons = AudioEvents.weapons(game.data.contract.weapons)
        report = reportEvery.map { AudioReport(every: $0) }
        pending.reserveCapacity(64)
        let weapons = weapons
        unsubscribe = game.events.on { [weak self] event in
            if let audio = AudioEvents.translate(event, weapons: weapons) { self?.pending.append(audio) }
        }
        // ai/manager.ts `callout` emits botCallout with the bot's position.
        bots.onCallout = { [weak self] bot, kind in
            guard let kind = BotCalloutKind(rawValue: kind.rawValue) else { return }
            self?.pending.append(.botCallout(botId: bot.id, kind: kind, position: bot.position))
        }
        watcher = OutputDeviceWatcher { [weak self] in self?.scheduleReroute() }
        reroute()
    }

    /// fx/casings.ts emits casingLanded on a casing's first ground contact; the native casings report it here.
    func attach(_ effects: GameEffects) {
        effects.effects.onCasingLanded = { [weak self] kind, position, surface in
            guard let kind = IronvaleAudio.CasingKind(rawValue: kind.rawValue) else { return }
            self?.pending.append(.casingLanded(kind: kind, position: Vec3(position.x, position.y, position.z), surface: surface))
        }
    }

    /// game.ts startMatch: the old map is left (unloadMap), audio unpaused, the new map entered.
    func enterMap(_ meta: MapMeta) {
        let map = AudioEvents.map(meta)
        self.map = map
        paused = false
        pending.removeAll(keepingCapacity: true)
        guard let session else { return }
        session.engine.leaveMap()
        session.engine.enterMap(map)
        logDecodeFailures(session)
    }

    /// game.ts unloadMap.
    func leaveMap() {
        map = nil
        pending.removeAll(keepingCapacity: true)
        session?.engine.leaveMap()
    }

    /// game.ts pause / resume / endMatch.
    func setPaused(_ paused: Bool) {
        self.paused = paused
        session?.engine.setPaused(paused)
    }

    /// One frame, after the sim (game.ts calls `audio.update(dt)` near the end of its frame).
    func frame(_ dt: Double, settings: IronvaleUI.Settings) {
        let a = settings.audio
        host.apply(master: a.master, effects: a.effects, ambience: a.ambience, interface: a.interface, hrtf: a.hrtf,
                   showHitMarkers: settings.gameplay.showHitMarkers)
        if let session, session.output != nil {
            report?.delivered(pending)
            session.frame(dt: dt, events: pending)
            report?.frame(dt, voicesPlaying: session.engine.voicePool?.playing ?? 0)
        }
        pending.removeAll(keepingCapacity: true)
        // The web emits the snapshot after `audio.update`, so it is heard on the next frame.
        snapshotTimer += dt
        if snapshotTimer >= Self.snapshotInterval {
            snapshotTimer = 0
            pending.append(.matchState(playing: game.phase == .playing, health: Double(game.snapshot.health)))
        }
    }

    func stop() {
        rerouteTask?.cancel()
        watcher?.stop()
        watcher = nil
        unsubscribe?()
        unsubscribe = nil
        dropOutput()
    }

    // MARK: Output device

    private func scheduleReroute(force: Bool = false) {
        rerouteTask?.cancel()
        rerouteTask = Task { [weak self] in
            try? await Task.sleep(for: Self.rerouteDelay)
            if Task.isCancelled { return }
            self?.reroute(force: force)
        }
    }

    /// Put playback on the current default output, rebuilding the session when the rate differs.
    private func reroute(force: Bool = false) {
        guard let next = OutputDevice.systemDefault() else {
            if session?.output != nil { Self.logger.error("No audio output device; playing silent") }
            dropOutput()
            device = nil
            watcher?.watchRate(of: nil)
            return
        }
        let rate = AudioOutput.sampleRate(of: next) ?? AudioOutput.hardwareSampleRate()
        let running = session?.output?.engine.isRunning ?? false
        if !force, running, next == device, session?.core.sampleRate == rate { return }
        if session?.core.sampleRate != rate {
            dropOutput()
            session = makeSession(sampleRate: rate)
        }
        device = next
        watcher?.watchRate(of: next)
        guard let session else { return }
        startOutput(session, on: next, rate: rate)
    }

    private func makeSession(sampleRate: Double) -> AudioSession? {
        do {
            let session = try AudioSession(repo: repositoryRoot, host: host, sampleRate: sampleRate)
            session.engine.unlock()
            if let map { session.engine.enterMap(map) }
            if paused { session.engine.setPaused(true) }
            logDecodeFailures(session)
            return session
        } catch {
            Self.logger.error("Audio unavailable: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    private func startOutput(_ session: AudioSession, on device: AudioObjectID, rate: Double) {
        let name = OutputDevice.name(of: device)
        let builtIn = OutputDevice.isBuiltIn(device)
        do {
            do {
                try session.startOutput(bufferFrames: builtIn ? Self.builtInBufferFrames : nil, device: device)
            } catch where builtIn {
                // A device that refuses 128 frames still plays at its own size.
                Self.logger.error("Could not set a \(Self.builtInBufferFrames)-frame buffer on \(name, privacy: .public): \(String(describing: error), privacy: .public)")
                try session.startOutput(bufferFrames: nil, device: device)
            }
        } catch {
            Self.logger.error("Audio output could not start on \(name, privacy: .public): \(String(describing: error), privacy: .public)")
            return
        }
        observeConfiguration(session)
        let buffer = session.output?.bufferFrames.map { "\($0)" } ?? "?"
        let route = "\"\(name)\" \(Int(rate)) Hz, \(buffer)-frame buffer"
        Self.logger.info("Audio output: \(route, privacy: .public)")
        report?.route = route
        report?.watch(session)
    }

    /// The engine stops itself when its device's configuration changes under it; start it again.
    private func observeConfiguration(_ session: AudioSession) {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: session.output?.engine,
                                                                queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.session?.output?.engine.isRunning == false else { return }
                self.scheduleReroute(force: true)
            }
        }
    }

    private func dropOutput() {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        session?.stopOutput()
    }

    private func logDecodeFailures(_ session: AudioSession) {
        let failures = session.library.failures
        if failures.isEmpty { return }
        Self.logger.error("\(failures.count) sounds could not be decoded: \(failures.prefix(5).joined(separator: "; "), privacy: .public)")
    }
}
