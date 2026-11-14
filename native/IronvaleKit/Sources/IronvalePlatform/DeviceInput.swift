// Ported from the device side of src/core/input.ts and src/platform (pointer lock) at commit 185029e:
// keys and buttons as `KeyboardEvent.code` strings (press / release bookkeeping, wheel gestures) and
// look deltas while the pointer is captured. Look deltas come from GCMouse raw input when the
// "raw input" setting is on, from NSEvent deltas otherwise (PLAN.md 3.10).
import AppKit
import CoreGraphics
import GameController
import os

/// One frame of device state; `IronvaleSim.BoundInput` maps it to actions.
public struct DeviceFrame: Sendable, Equatable {
    public var held: Set<String>
    public var pressed: Set<String>
    public var lookX: Double
    public var lookY: Double
    public var locked: Bool
}

/// Thread-safe accumulator for GCMouse deltas (its handler runs on the GameController queue).
final class LookAccumulator: Sendable {
    private let state = OSAllocatedUnfairLock(initialState: (x: 0.0, y: 0.0))

    func add(_ dx: Double, _ dy: Double) { state.withLock { $0.x += dx; $0.y += dy } }

    func take() -> (Double, Double) {
        state.withLock { value in
            defer { value = (0, 0) }
            return (value.x, value.y)
        }
    }
}

private struct EventBox: @unchecked Sendable {
    let event: NSEvent?
}

@MainActor
public final class DeviceInput {
    public struct Options: Sendable {
        /// Single deltas larger than this are glitches, not hand movement (`LOOK_SPIKE_PX`).
        public var lookSpike: Double
        public var wheelThreshold: Double
        public var wheelQuietSeconds: Double

        public init(lookSpike: Double, wheelThreshold: Double, wheelQuietSeconds: Double) {
            self.lookSpike = lookSpike
            self.wheelThreshold = wheelThreshold
            self.wheelQuietSeconds = wheelQuietSeconds
        }
    }

    private static let logger = Logger(subsystem: "dev.n3el.ironvale", category: "input")
    /// GCMouse raw deltas instead of NSEvent deltas.
    public var rawInput = true
    /// Called when capture starts or ends (Escape, focus loss, miniaturise).
    public var onLockChange: ((Bool) -> Void)?
    /// When false the monitor passes every event through (menus and SwiftUI own the keyboard).
    public var gameHasKeyboard = false
    public private(set) var locked = false

    private let options: Options
    private var held = Set<String>()
    private var pressed = Set<String>()
    private var lookX = 0.0
    private var lookY = 0.0
    private let raw = LookAccumulator()
    private var wheelAccum = 0.0
    private var wheelLast = 0.0
    private var wheelBlocked = false
    private var monitor: Any?
    private var observers: [NSObjectProtocol] = []
    private weak var window: NSWindow?

    public init(options: Options) {
        self.options = options
    }

    /// Starts listening to the window's events and to GCMouse.
    public func attach(to window: NSWindow) {
        self.window = window
        let mask: NSEvent.EventTypeMask = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown,
                                           .rightMouseUp, .otherMouseDown, .otherMouseUp, .mouseMoved, .leftMouseDragged,
                                           .rightMouseDragged, .scrollWheel]
        // Local monitors run on the main thread; the box carries the non-Sendable event across the isolation check.
        monitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            let box = EventBox(event: event)
            return MainActor.assumeIsolated { EventBox(event: self?.handle(box.event) ?? box.event) }.event
        }
        let center = NotificationCenter.default
        for name in [NSWindow.didResignKeyNotification, NSWindow.didMiniaturizeNotification, NSApplication.didHideNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.release() }
            })
        }
        observers.append(center.addObserver(forName: .GCMouseDidConnect, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                for mouse in GCMouse.mice() { self?.bind(mouse) }
            }
        })
        bind(GCMouse.current)
        for mouse in GCMouse.mice() { bind(mouse) }
    }

    private func bind(_ mouse: GCMouse?) {
        guard let input = mouse?.mouseInput else { return }
        let raw = raw
        // GCMouse reports y up; the web's movementY is down.
        input.mouseMovedHandler = { _, dx, dy in raw.add(Double(dx), -Double(dy)) }
        Self.logger.info("GCMouse bound for raw look input")
    }

    /// Hides and freezes the cursor and starts taking look input (the web's pointer lock).
    public func capture() {
        guard !locked else { return }
        locked = true
        _ = raw.take()
        CGAssociateMouseAndMouseCursorPosition(0)
        NSCursor.hide()
        if let window, let screen = window.screen {
            // Park the hidden cursor over the window so a click cannot land on another app.
            let frame = window.frame
            let point = CGPoint(x: frame.midX, y: screen.frame.maxY - frame.midY)
            CGWarpMouseCursorPosition(point)
        }
        onLockChange?(true)
    }

    /// Gives the cursor back and drops every held key (`releaseAll` on lock loss).
    public func release() {
        guard locked else { return }
        locked = false
        CGAssociateMouseAndMouseCursorPosition(1)
        NSCursor.unhide()
        held.removeAll()
        onLockChange?(false)
    }

    /// The state for this frame; pressed codes are cleared after reading (`endFrame`).
    public func takeFrame() -> DeviceFrame {
        var dx = lookX, dy = lookY
        lookX = 0
        lookY = 0
        let (rx, ry) = raw.take()
        if rawInput, locked {
            dx = abs(rx) > options.lookSpike || abs(ry) > options.lookSpike ? 0 : rx
            dy = abs(rx) > options.lookSpike || abs(ry) > options.lookSpike ? 0 : ry
        }
        let frame = DeviceFrame(held: held, pressed: pressed, lookX: locked ? dx : 0, lookY: locked ? dy : 0, locked: locked)
        pressed.removeAll()
        held.remove("WheelUp")
        held.remove("WheelDown")
        return frame
    }

    private func press(_ code: String) {
        if !held.contains(code) { pressed.insert(code) }
        held.insert(code)
    }

    /// Returns nil to swallow the event while the game has the keyboard.
    private func handle(_ event: NSEvent?) -> NSEvent? {
        guard let event else { return nil }
        switch event.type {
        case .keyDown:
            guard gameHasKeyboard, let code = KeyCodes.code(forKeyCode: event.keyCode) else { return event }
            if code == "Escape", locked {
                release()
                return nil
            }
            if !event.isARepeat { press(code) }
            return nil
        case .keyUp:
            guard let code = KeyCodes.code(forKeyCode: event.keyCode) else { return event }
            held.remove(code)
            return gameHasKeyboard ? nil : event
        case .flagsChanged:
            guard let code = KeyCodes.code(forKeyCode: event.keyCode), KeyCodes.modifiers.contains(code) else { return event }
            if held.contains(code) { held.remove(code) } else if gameHasKeyboard { press(code) }
            return event
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            guard gameHasKeyboard else { return event }
            if !locked {
                capture()
                return nil
            }
            press("Mouse\(Self.button(event))")
            return nil
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            held.remove("Mouse\(Self.button(event))")
            return locked ? nil : event
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged:
            guard locked else { return event }
            if !rawInput, abs(event.deltaX) <= options.lookSpike, abs(event.deltaY) <= options.lookSpike {
                lookX += event.deltaX
                lookY += event.deltaY
            }
            return nil
        case .scrollWheel:
            guard locked else { return event }
            wheel(event)
            return nil
        default:
            return event
        }
    }

    /// The browser's button numbers: 0 primary, 1 middle, 2 secondary.
    private static func button(_ event: NSEvent) -> Int {
        switch event.type {
        case .leftMouseDown, .leftMouseUp: event.modifierFlags.contains(.control) ? 2 : 0
        case .rightMouseDown, .rightMouseUp: 2
        default: 1
        }
    }

    /// One switch per gesture, then wait for the stream (and trackpad momentum) to go quiet.
    private func wheel(_ event: NSEvent) {
        if event.modifierFlags.contains(.control) { return }
        let now = event.timestamp
        let quiet = now - wheelLast > options.wheelQuietSeconds
        wheelLast = now
        if quiet {
            wheelBlocked = false
            wheelAccum = 0
        }
        if wheelBlocked { return }
        // A browser's deltaY is positive scrolling down, which is AppKit's negative scrollingDeltaY.
        wheelAccum += -event.scrollingDeltaY
        if abs(wheelAccum) < options.wheelThreshold { return }
        press(wheelAccum > 0 ? "WheelDown" : "WheelUp")
        wheelAccum = 0
        wheelBlocked = true
    }
}
