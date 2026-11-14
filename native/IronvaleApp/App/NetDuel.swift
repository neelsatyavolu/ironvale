// M6 launch arguments: a two-player duel against a web page, driven end to end for the layer 4
// harness (PLAN.md 5.4 layer 4, native/Tools/interop/duel.test.ts). The app connects through the
// relay, plays the match with DuelPilot as its input and writes a match log, then quits.
//   --autohost             host a duel with a room code (written to --code-out)
//   --autojoin CODE        join the room CODE as the guest
//   --signal URL           the relay (default: RelayDefaults)
//   --duel-map ID          host: the map; guest: wait for the host to choose it before Ready
//   --kill-target N        host: kills to win (default 10)
//   --net-name NAME        the player's name in the lobby (default "Native")
//   --code-out PATH        host: write the room code here
//   --match-log PATH       JSON lines: lobby steps, kills and deaths, rejections, the result
//   --duel-shot PATH       one PNG of this app's view while it aims at the other player
//   --duel-hide S          S seconds in, stop the display link for 10 s (the match must go on)
import AppKit
import Foundation
import IronvaleCore
import IronvaleMapRender
import IronvaleNet
import IronvaleRender
import IronvaleSim
import IronvaleTransportWebRTC
import IronvaleWire
import Metal
import os

struct NetDuelOptions {
    var host = false
    var joinCode: String?
    var signal: String?
    var mapId: String?
    var killTarget = 10
    var name = "Native"
    var codeOut: String?
    var matchLog: String?
    var shotPath: String?
    var hideAt: Double?

    static func parse(_ arguments: some Sequence<String>) -> NetDuelOptions? {
        var options = NetDuelOptions()
        var iterator = arguments.makeIterator()
        while let arg = iterator.next() {
            switch arg {
            case "--autohost": options.host = true
            case "--autojoin": options.joinCode = iterator.next()
            case "--signal": options.signal = iterator.next()
            case "--duel-map": options.mapId = iterator.next()
            case "--kill-target": options.killTarget = iterator.next().flatMap { Int($0) } ?? options.killTarget
            case "--net-name": options.name = iterator.next() ?? options.name
            case "--code-out": options.codeOut = iterator.next()
            case "--match-log": options.matchLog = iterator.next()
            case "--duel-shot": options.shotPath = iterator.next()
            case "--duel-hide": options.hideAt = iterator.next().flatMap { Double($0) }
            default: continue
            }
        }
        return options.host || options.joinCode != nil ? options : nil
    }
}

@MainActor
final class NetDuel {
    private static let logger = Logger(subsystem: "dev.n3el.ironvale", category: "duel")
    /// Stay connected this long after the result so the last death reaches the other machine.
    static let lingerSeconds = 3.0
    /// Give up when the match has not ended after this long.
    static let timeoutSeconds = 600.0

    let match: NetMatch
    let pilot: DuelPilot
    private let options: NetDuelOptions
    private let game: Game
    private let log: EventLog
    private let started = Date()
    private var lastPhase: LobbyPhase = .idle
    private var codeWritten = false
    private var readySent = false
    private var startSent = false
    private var rejections = 0
    private var hitsSent = 0
    private var shotsSent = 0
    private var finishing = false
    private var shotTaken = false
    private let input: BoundInput
    /// Uptime of the last simulated frame, from the display link or the watchdog.
    private var lastTick = ProcessInfo.processInfo.systemUptime
    private var watchdog: DispatchSourceTimer?
    private var watchdogTicks = 0
    private var stalled = false
    private var frames = 0
    private var statesSent = 0
    private var lastBeat = 0.0
    private weak var window: NSWindow?
    static let hideSeconds = 10.0
    /// macOS stops the display link for a covered or hidden window. A match keeps simulating and
    /// sending state anyway (owner decision Q5, PLAN.md 13), or the other player times this one out
    /// after 5 s: when no frame has run for this long, the watchdog runs one without drawing.
    static let stallSeconds = 0.1

    init(options: NetDuelOptions, game: Game, input: BoundInput, startGame: @escaping (MatchConfig) -> Bool) throws {
        self.options = options
        self.game = game
        self.input = input
        log = try EventLog(path: options.matchLog)
        let contract = game.data.contract
        let relay = RelayClient(url: options.signal ?? RelayDefaults.url)
        match = NetMatch(game: game, relay: relay, makeLink: WebRTCPeerLink.make, localName: options.name,
                         knownMaps: Set(contract.maps.playable + contract.maps.developer))
        pilot = DuelPilot(game: game, match: match)
        match.startGame = startGame
        match.log = { [weak self] kind, fields in
            if kind == "reject" { self?.rejections += 1 }
            self?.write(kind, fields)
        }
        var tap = NetTap()
        tap.rejected = { [weak self] channel, _, reason in
            self?.rejections += 1
            self?.write("reject", ["channel": channel.rawValue, "reason": reason])
        }
        tap.sent = { [weak self] channel, frame in self?.countSent(channel, frame) }
        match.session.tap = tap
        match.session.onChange = { [weak self] state in self?.changed(state) }
        game.events.on { [weak self] event in self?.observe(event) }
    }

    /// `displayLink(false)` stops the frame loop's display link and `displayLink(true)` starts it again.
    func start(window: NSWindow, displayLink: @escaping @MainActor (Bool) -> Void) {
        self.window = window
        if let at = options.hideAt {
            // Test hook for Q5: no display link for hideSeconds, as macOS does to a hidden or covered
            // window (minimising or ordering out cannot be scripted reliably for a background app).
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                MainActor.assumeIsolated {
                    self?.write("hidden", ["seconds": "\(Self.hideSeconds)"])
                    displayLink(false)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.hideSeconds) { [weak self] in
                    MainActor.assumeIsolated {
                        self?.write("shown", ["stalledTicks": "\(self?.watchdogTicks ?? 0)"])
                        displayLink(true)
                    }
                }
            }
        }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 1, repeating: .milliseconds(16))
        timer.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                let idle = ProcessInfo.processInfo.systemUptime - self.lastTick
                // Once stalled, run every 16 ms until the display link is back.
                if self.stalled || idle > Self.stallSeconds {
                    self.stalled = true
                    self.watchdogTicks += 1
                    self.tick(min(idle, Self.stallSeconds), fromWatchdog: true)
                }
            }
        }
        timer.resume()
        watchdog = timer
        write("start", ["role": options.host ? "host" : "guest", "map": options.mapId ?? "", "signal": options.signal ?? RelayDefaults.url])
        if options.host {
            let target = options.killTarget, mapId = options.mapId
            match.session.setConfig { config in
                config.mode = .duel
                config.killTarget = target
                config.duelBot = .none
                if let mapId { config.mapId = mapId }
            }
            match.session.host(.room)
        } else if let code = options.joinCode {
            match.session.join(.room, code: code)
        }
    }

    /// One frame of the match: the pilot's input, the game, then the end-of-match check.
    func tick(_ dt: Double, fromWatchdog: Bool = false) {
        if !fromWatchdog { stalled = false }
        lastTick = ProcessInfo.processInfo.systemUptime
        frames += 1
        if lastTick - lastBeat >= 5 {
            lastBeat = lastTick
            write("beat", ["phase": game.phase.rawValue, "frames": "\(frames)", "watchdogTicks": "\(watchdogTicks)",
                           "statesSent": "\(statesSent)", "visible": "\(window?.isVisible ?? false)",
                           "occluded": "\(!(window?.occlusionState.contains(.visible) ?? false))", "inMatch": "\(match.inMatch)",
                           "frozen": "\(match.frozen)"])
        }
        input.frame = pilot.next()
        game.frame(dt)
        frame()
    }

    private func frame() {
        if finishing { return }
        if game.phase == .won || game.phase == .lost {
            finish(ok: true, reason: "match over")
        } else if Date().timeIntervalSince(started) > Self.timeoutSeconds {
            finish(ok: false, reason: "timed out")
        }
    }

    /// `--duel-shot PATH`: once, while this player is aiming at the other one a few kills in, the
    /// path to write the frame to (the remote soldier as this app draws it).
    func takeShotRequest() -> String? {
        guard let path = options.shotPath, !shotTaken, game.kills + game.deaths >= 3, pilot.aimingAtRemote else { return nil }
        shotTaken = true
        write("screenshot", ["path": path])
        return path
    }

    /// Renders `pose` once more into a CPU-visible texture and writes it as PNG (a one-off stall).
    static func capture(renderer: MapRenderer, pose: CameraPose, time: Double, device: any MTLDevice, to path: String) {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm, width: renderer.settings.internalWidth, height: renderer.settings.internalHeight, mipmapped: false)
        descriptor.usage = [.renderTarget]
        descriptor.storageMode = .shared
        guard let output = device.makeTexture(descriptor: descriptor), let queue = device.makeCommandQueue(),
              let commands = queue.makeCommandBuffer() else { return }
        renderer.encode(commandBuffer: commands, pose: pose, time: time, output: output)
        commands.commit()
        commands.waitUntilCompleted()
        do {
            try TextureCapture.writePNG(output, to: URL(fileURLWithPath: path))
        } catch {
            logger.error("duel screenshot failed: \(error, privacy: .public)")
        }
    }

    private func changed(_ state: NetLobbyState) {
        if state.phase != lastPhase {
            lastPhase = state.phase
            write("phase", ["phase": state.phase.rawValue])
        }
        if options.host, !state.code.isEmpty, !codeWritten {
            codeWritten = true
            write("code", ["code": state.code])
            if let path = options.codeOut { try? state.code.write(toFile: path, atomically: true, encoding: .utf8) }
        }
        if let error = state.error {
            write("error", ["error": error.rawValue])
            if !finishing, game.phase != .won, game.phase != .lost { finish(ok: false, reason: "session failed: \(error.rawValue)") }
            return
        }
        guard state.phase == .connected, !state.inMatch else { return }
        if !options.host, !readySent, state.config.mode == .duel, state.config.killTarget == options.killTarget,
           options.mapId == nil || state.config.mapId == options.mapId {
            readySent = true
            write("ready", ["map": state.config.mapId, "killTarget": "\(state.config.killTarget)"])
            match.session.setReady(true)
        }
        if options.host, state.peerReady, !startSent {
            startSent = true
            write("startMatch", ["map": state.config.mapId])
            match.session.start()
        }
    }

    private func countSent(_ channel: NetTap.Channel, _ frame: NetTap.Frame) {
        switch frame {
        case .text(let text) where text.contains("\"t\":\"hit\""): hitsSent += 1
        case .binary where channel == .events: shotsSent += 1
        case .binary where channel == .state: statesSent += 1
        default: break
        }
    }

    private func observe(_ event: GameEvent) {
        guard case let .died(victimId, killerId, weaponId, headshot) = event else { return }
        let victim = victimId == game.player.id ? "local" : victimId == match.partnerId ? "peer" : "\(victimId)"
        let killer = killerId == game.player.id ? "local" : killerId == match.partnerId ? "peer" : "\(killerId)"
        write("died", ["victim": victim, "killer": killer, "weapon": weaponId, "headshot": "\(headshot)",
                       "kills": "\(game.kills)", "deaths": "\(game.deaths)"])
    }

    private func finish(ok: Bool, reason: String) {
        finishing = true
        write("result", ["ok": "\(ok)", "reason": reason, "phase": game.phase.rawValue, "kills": "\(game.kills)",
                         "deaths": "\(game.deaths)", "rejections": "\(rejections)", "hitsSent": "\(hitsSent)",
                         "shotsSent": "\(shotsSent)", "watchdogTicks": "\(watchdogTicks)", "role": match.role.rawValue, "map": match.config?.mapId ?? game.config?.mapId ?? ""])
        Self.logger.info("duel finished: \(reason, privacy: .public), \(self.game.kills)-\(self.game.deaths)")
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.lingerSeconds) { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { exit(ok ? 0 : 1) }
                self.match.session.send(.bye(.ended))
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    MainActor.assumeIsolated {
                        self.log.close()
                        exit(ok && self.rejections == 0 ? 0 : 1)
                    }
                }
            }
        }
    }

    private func write(_ kind: String, _ fields: [String: String]) {
        let clean = fields.mapValues { $0.replacingOccurrences(of: "\"", with: "'") }
        log.write(time: Date().timeIntervalSince(started), kind: kind, fields: clean)
    }
}
