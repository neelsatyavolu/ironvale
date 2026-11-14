// ivpeer: the headless native net peer for interop tests (PLAN.md 5.4 layer 3). It runs the real
// IronvaleNet session over the real WebRTC transport against one peer (another ivpeer, or the Node
// reference peer in native/Tools/interop), then the scripted match. No Game is needed: the match
// is exchanged with IronvaleWire codecs only.
import Foundation
import IronvaleContract
import IronvaleCore
import IronvaleNet
import IronvaleTransportWebRTC
import IronvaleWire

@MainActor
final class PeerController {
    private let options: PeerOptions
    private let log: PeerLog
    private let contract: Contract
    private let scenario: Scenario
    private var session: NetLobbySession!
    private var script: MatchScript!
    private var ticker: DispatchSourceTimer?
    private var lastPhase: LobbyPhase = .idle
    private var codeWritten = ""
    private var waitingForCode = false
    private var readySent = false
    private var byeSent = false
    private var finished = false
    private var candidatesSent = 0
    private var codeLengths: [Int] = []
    private var peerRejections = 0

    init(options: PeerOptions) throws {
        self.options = options
        log = PeerLog(path: options.log)
        contract = try Contract.load()
        let me = options.role == .host ? Wire.host : Wire.guest
        let scenarioPath = options.scenario ?? ContractLocation.sourceTreeDirectory
            .deletingLastPathComponent().appendingPathComponent("Tools/interop/scenario.json").path
        scenario = try Scenario.load(path: scenarioPath, me: me, peer: me == Wire.host ? Wire.guest : Wire.host)
    }

    func run() {
        let relay = options.signal.flatMap { RelayClient(url: $0, origin: options.origin) }
        let maps = Set(contract.maps.playable + contract.maps.developer)
        let hooks = MatchHooks(
            knownMaps: { maps },
            beginMatch: { [weak self] config, role in self?.beginMatch(config, role: role) },
            matchEvent: { [weak self] event, now in self?.script.received(event, now: now) },
            matchBinary: { [weak self] message, now in self?.script.received(message, now: now) },
            chat: { [weak self] name, text, mine in
                self?.log.write("chat", [("name", .string(name)), ("text", .string(text)), ("mine", .bool(mine))])
                self?.script.chat(text, mine: mine)
            }
        )
        session = NetLobbySession(
            relay: relay, makeLink: WebRTCPeerLink.make, hooks: hooks, localName: options.name,
            extraIceServers: IceServers.parse(options.iceServers), relayOnly: options.relayOnly
        )
        script = MatchScript(scenario: scenario, session: session, log: log, contract: contract, role: options.role)
        session.tap = makeTap()
        session.onChange = { [weak self] state in self?.changed(state) }
        log.write("start", [
            ("role", .string(options.role.rawValue)), ("method", .string(options.method.rawValue)),
            ("origin", .string(options.origin)), ("relayOnly", .bool(options.relayOnly)),
        ])

        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(4))
        timer.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.tick() } }
        timer.resume()
        ticker = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + options.timeoutSeconds) { [weak self] in
            MainActor.assumeIsolated { self?.finish(ok: false, reason: "timed out") }
        }

        if options.role == .host {
            session.setConfig { $0 = scenario.config }
            session.host(options.method)
        } else {
            readCode { [weak self] code in
                guard let self else { return }
                self.session.join(self.options.method, code: code)
            }
        }
    }

    private func makeTap() -> NetTap {
        var tap = NetTap()
        tap.sent = { [weak self] channel, frame in self?.log.frame("sent", channel, frame) }
        tap.received = { [weak self] channel, frame in self?.log.frame("recv", channel, frame) }
        tap.rejected = { [weak self] channel, frame, reason in
            self?.peerRejections += 1
            self?.log.frame("reject", channel, frame, reason: reason)
        }
        tap.signal = { [weak self] outgoing, message in
            guard let self else { return }
            switch message {
            case .candidate(let candidate):
                if outgoing { self.candidatesSent += 1 }
                self.log.write(outgoing ? "signal-out" : "signal-in", [("type", .string("candidate")), ("candidate", .string(candidate.candidate))])
            case .offer(let sdp), .answer(let sdp):
                let embedded = sdp.components(separatedBy: "\r\n").filter { $0.hasPrefix("a=candidate:") }.count
                if outgoing { self.candidatesSent += embedded }
                let type = if case .offer = message { "offer" } else { "answer" }
                self.log.write(outgoing ? "signal-out" : "signal-in", [
                    ("type", .string(type)), ("sdpChars", .number(Double(sdp.utf16.count))), ("candidates", .number(Double(embedded))),
                ])
            }
        }
        tap.relayServers = { [weak self] result in
            self?.log.write("ice", [
                ("status", result.status.map { .number(Double($0)) } ?? .null),
                ("servers", .number(Double(result.servers.count))),
            ])
        }
        return tap
    }

    private func changed(_ state: NetLobbyState) {
        if state.phase != lastPhase {
            lastPhase = state.phase
            log.write("phase", [("phase", .string(state.phase.rawValue))])
        }
        if !state.code.isEmpty, state.code != codeWritten {
            codeWritten = state.code
            codeLengths.append(state.code.utf16.count)
            log.write("code", [("chars", .number(Double(state.code.utf16.count)))])
            writeCode(state.code)
            if options.role == .host, options.method == .manual, !waitingForCode {
                waitingForCode = true
                readCode { [weak self] reply in self?.session.acceptReply(reply) }
            }
        }
        if let error = state.error {
            handleError(error)
            return
        }
        guard state.phase == .connected else { return }
        if options.role == .guest, state.config == scenario.config, !readySent {
            readySent = true
            session.setReady(true)
        }
        if options.role == .host, state.peerReady, session.match == nil {
            session.start()
        }
    }

    private func handleError(_ error: NetFailure) {
        log.write("error", [("error", .string(error.rawValue))])
        if let expected = options.expectError {
            finish(ok: error == expected, reason: "error \(error.rawValue), expected \(expected.rawValue)")
            return
        }
        // The guest ends the script with bye: the host sees the peer leave, which is the success path.
        if error == .peerLeft, script.finSent, script.finReceived {
            finish(ok: true, reason: "peer said bye after the script")
        } else {
            finish(ok: false, reason: "session failed: \(error.rawValue)")
        }
    }

    private func beginMatch(_ config: NetMatchConfig, role: PeerRole) {
        log.write("begin-match", [("map", .string(config.mapId)), ("mode", .string(config.mode.rawValue))])
        // No map to load: the match is ready on the next turn of the run loop.
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                self?.session.attachMatch()
                self?.session.matchLoaded()
            }
        }
    }

    private func tick() {
        guard !finished else { return }
        let now = NetClock.now()
        if session.goAt.isFinite, !script.running {
            log.write("go", [("goAt", .number(session.goAt.rounded()))])
            script.start(now: now)
        }
        script.tick(now: now)
        session.update(running: script.running)
        if options.role == .guest, script.finSent, script.finReceived, !byeSent {
            byeSent = true
            session.send(.bye(.ended))
            // Leave time for the reliable channel to deliver it before the process exits.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                MainActor.assumeIsolated { self?.finish(ok: true, reason: "script complete") }
            }
        }
    }

    private func writeCode(_ code: String) {
        guard let path = options.codeOut else { return }
        let temporary = path + ".tmp"
        do {
            try code.write(toFile: temporary, atomically: false, encoding: .utf8)
            _ = try FileManager.default.replaceItemAt(URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: temporary))
        } catch {
            finish(ok: false, reason: "cannot write \(path): \(error)")
        }
    }

    /// Polls `--code-in` until the other peer has written its code there.
    private func readCode(_ done: @escaping @MainActor (String) -> Void) {
        guard let path = options.codeIn else {
            finish(ok: false, reason: "this role needs --code-in")
            return
        }
        if let code = try? String(contentsOfFile: path, encoding: .utf8), !code.isEmpty {
            log.write("code-in", [("chars", .number(Double(code.utf16.count)))])
            done(code)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            MainActor.assumeIsolated { self?.readCode(done) }
        }
    }

    private func finish(ok: Bool, reason: String) {
        guard !finished else { return }
        finished = true
        ticker?.cancel()
        let rejections = (script?.rejections ?? 0) + peerRejections
        let success = ok && rejections == 0
        log.write("done", [
            ("ok", .bool(success)), ("reason", .string(reason)),
            ("rejections", .number(Double(rejections))),
            ("candidatesSent", .number(Double(candidatesSent))),
            ("codeChars", .array(codeLengths.map { .number(Double($0)) })),
            ("statesSent", .number(Double(script?.statesSent ?? 0))),
            ("statesReceived", .number(Double(script?.statesReceived ?? 0))),
            ("rttMs", .number(Double(session?.state.rttMs ?? -1))),
        ])
        log.close()
        exit(success ? 0 : 1)
    }
}

do {
    let options = try PeerOptions.parse(Array(CommandLine.arguments.dropFirst()))
    let controller = try MainActor.assumeIsolated { try PeerController(options: options) }
    MainActor.assumeIsolated { controller.run() }
    dispatchMain()
} catch {
    FileHandle.standardError.write(Data("ivpeer: \(error)\n\(PeerOptions.usage)\n".utf8))
    exit(2)
}
