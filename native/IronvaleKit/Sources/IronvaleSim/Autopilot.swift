// `--autopilot script.json` (PLAN.md 5.4 layer 4, M4 exit check): an input script for deterministic
// movement and firing. Each step holds binding codes (the web's `KeyboardEvent.code` strings, plus
// Mouse0/Mouse2) for some seconds of game time, presses codes on its first frame, and turns the view
// by a pixel delta every frame. The script drives the same `BoundInput` the keyboard and mouse do.
import Foundation

public struct AutopilotScript: Codable, Sendable, Equatable {
    public struct Step: Codable, Sendable, Equatable {
        /// Logged when the step starts, so the event log can be read against the script.
        public var mark: String?
        public var seconds: Double
        public var hold: [String]?
        public var press: [String]?
        /// Pixels per frame, as a mouse would send.
        public var look: [Double]?
        /// Wait (up to `seconds`) until the player is alive again.
        public var untilAlive: Bool?
    }

    public var map: String?
    public var difficulty: String?
    public var preset: String?
    public var steps: [Step]

    public static func load(_ url: URL) throws -> AutopilotScript {
        try JSONDecoder().decode(AutopilotScript.self, from: Data(contentsOf: url))
    }
}

/// Plays a script into an `InputFrame`, one game frame at a time.
public final class Autopilot {
    public let script: AutopilotScript
    public private(set) var index = 0
    private var elapsed = 0.0
    private var started = false
    /// Called with a step's `mark` when it begins.
    public var onMark: ((String) -> Void)?

    public init(script: AutopilotScript) {
        self.script = script
    }

    public var finished: Bool { index >= script.steps.count }

    /// The device state for the next frame of `dt` seconds.
    public func next(dt: Double, playerAlive: Bool) -> InputFrame {
        var frame = InputFrame(locked: true)
        while index < script.steps.count {
            let step = script.steps[index]
            if !started {
                started = true
                elapsed = 0
                if let mark = step.mark { onMark?(mark) }
                frame.pressed.formUnion(step.press ?? [])
            }
            let done = step.untilAlive == true ? (playerAlive && elapsed > 0) || elapsed >= step.seconds : elapsed >= step.seconds
            if !done { break }
            index += 1
            started = false
        }
        guard index < script.steps.count else { return frame }
        let step = script.steps[index]
        frame.held = Set(step.hold ?? []).union(frame.pressed)
        if let look = step.look, look.count == 2 {
            frame.lookX = look[0]
            frame.lookY = look[1]
        }
        elapsed += dt
        return frame
    }
}

/// Every GameEvent as one JSON line: `{"t": seconds, "event": name, ...}` (the app's event log).
public final class EventLog {
    public private(set) var lines: [String] = []
    private let handle: FileHandle?

    public init(path: String?) throws {
        if let path {
            FileManager.default.createFile(atPath: path, contents: nil)
            guard let handle = FileHandle(forWritingAtPath: path) else {
                throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: path])
            }
            self.handle = handle
        } else {
            handle = nil
        }
    }

    public func write(time: Double, kind: String, fields: [String: String] = [:]) {
        var parts = ["\"t\":\(String(format: "%.4f", time))", "\"event\":\"\(kind)\""]
        for key in fields.keys.sorted() { parts.append("\"\(key)\":\"\(fields[key]!)\"") }
        let line = "{" + parts.joined(separator: ",") + "}"
        lines.append(line)
        handle?.write(Data((line + "\n").utf8))
    }

    public func record(_ event: GameEvent, time: Double) {
        write(time: time, kind: event.name, fields: Self.fields(event))
    }

    public func close() { try? handle?.close() }

    static func fields(_ event: GameEvent) -> [String: String] {
        switch event {
        case let .shotFired(shooterId, weapon, _, _, local): ["shooter": "\(shooterId)", "weapon": weapon, "local": "\(local)"]
        case let .bulletTrace(_, weapon, _, _, _): ["weapon": weapon]
        case let .bulletImpact(_, weapon, hit): ["weapon": weapon, "surface": hit.surface.name]
        case let .combatantHit(weapon, targetId, attackerId, hit, _, fatal):
            ["weapon": weapon, "target": "\(targetId)", "attacker": "\(attackerId)", "zone": hit.zone.rawValue, "fatal": "\(fatal)"]
        case let .dryFire(_, weapon, _): ["weapon": weapon]
        case let .weaponAction(_, weapon, stage, _, _): ["weapon": weapon, "stage": stage]
        case let .weaponSwitch(_, weapon, _): ["weapon": weapon]
        case let .casingEjected(kind, _, _): ["kind": kind]
        case let .aimChanged(aiming, weapon): ["aiming": "\(aiming)", "weapon": weapon]
        case let .footstep(_, _, surface, running, _): ["surface": surface.name, "running": "\(running)"]
        case let .landed(_, _, surface, speed, _): ["surface": surface.name, "speed": String(format: "%.2f", speed)]
        case let .playerHurt(amount, health, _): ["amount": String(format: "%.2f", amount), "health": String(format: "%.2f", health)]
        case let .died(victimId, killerId, weaponId, _): ["victim": "\(victimId)", "killer": "\(killerId)", "weapon": weaponId]
        case let .spawned(id): ["combatant": "\(id)"]
        case let .grenadeBounced(_, _, speed, surface): ["surface": surface.name, "speed": String(format: "%.2f", speed)]
        case let .grenadeExploded(ownerId, position, _):
            ["owner": "\(ownerId)", "position": String(format: "%.2f,%.2f,%.2f", position.x, position.y, position.z)]
        case let .grenadeThrown(ownerId, _, _, _): ["owner": "\(ownerId)"]
        case .nearMiss, .jumped: [:]
        }
    }
}

/// Writes every GameEvent of a game to an `EventLog`, plus the crouch state changes (no GameEvent
/// exists for those) and autopilot step marks.
public final class GameRecorder {
    public let log: EventLog
    private let game: Game
    private var crouching = false
    private var unsubscribe: (() -> Void)?

    public init(game: Game, log: EventLog) {
        self.game = game
        self.log = log
        unsubscribe = game.events.on { [weak self] event in
            guard let self else { return }
            log.record(event, time: self.game.time)
        }
    }

    deinit { unsubscribe?() }

    public func mark(_ text: String) { log.write(time: game.time, kind: "mark", fields: ["step": text]) }

    /// After each game frame.
    public func frame() {
        if game.player.crouching != crouching {
            crouching = game.player.crouching
            log.write(time: game.time, kind: crouching ? "crouched" : "stood")
        }
    }
}

/// Drives a game from an autopilot script: the script's codes go through the same bindings as the keyboard.
public final class AutopilotRunner {
    public let autopilot: Autopilot
    public let recorder: GameRecorder
    private let game: Game
    private let input: BoundInput

    public init(script: AutopilotScript, game: Game, input: BoundInput, log: EventLog) {
        autopilot = Autopilot(script: script)
        self.game = game
        self.input = input
        recorder = GameRecorder(game: game, log: log)
        let recorder = recorder
        autopilot.onMark = { recorder.mark($0) }
    }

    public var finished: Bool { autopilot.finished }

    /// One frame: feed the script's input, run the game, record.
    public func frame(_ dt: Double) {
        input.frame = autopilot.next(dt: dt, playerAlive: game.player.alive)
        game.frame(dt)
        recorder.frame()
    }

    /// The M4 exit sequence: each of these must appear in the log, in this order.
    public static func expectedSequence(weapons: [String]) -> [(event: String, field: (String, String)?)] {
        var sequence: [(String, (String, String)?)] = [("spawned", nil), ("footstep", nil), ("crouched", nil), ("jumped", nil), ("landed", nil)]
        for (i, weapon) in weapons.enumerated() {
            if i > 0 { sequence.append(("weaponSwitch", ("weapon", weapon))) }
            sequence.append(("shotFired", ("weapon", weapon)))
        }
        sequence += [("weaponAction", ("stage", "magOut")), ("weaponAction", ("stage", "magIn")), ("grenadeThrown", nil),
                     ("grenadeExploded", nil), ("playerHurt", nil), ("died", nil), ("spawned", nil)]
        return sequence
    }

    /// Checks log lines against `expectedSequence`; returns the steps that were not found in order.
    public static func missing(in lines: [String], weapons: [String]) -> [String] {
        var cursor = 0
        var missing: [String] = []
        for (event, field) in expectedSequence(weapons: weapons) {
            let needle = "\"event\":\"\(event)\""
            let extra = field.map { "\"\($0.0)\":\"\($0.1)\"" }
            if let found = lines[cursor...].firstIndex(where: { $0.contains(needle) && (extra.map($0.contains) ?? true) }) {
                cursor = found + 1
            } else {
                missing.append(extra.map { "\(event) \($0)" } ?? event)
            }
        }
        return missing
    }
}
