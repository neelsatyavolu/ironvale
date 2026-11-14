import AppKit

/// How the app shows itself. Automated runs (check scripts, captures, benchmarks,
/// interop tests) run in the background: no Dock icon, no focus stealing, and
/// fully transparent windows. macOS keeps the display link of an alpha-0 window
/// running at full rate (it is not occluded), so frame timing is unaffected.
///
/// Background mode is on when IRONVALE_BACKGROUND=1 or any automation flag is
/// passed; IRONVALE_SHOW=1 forces normal windows (to watch a test run).
@MainActor
enum Presentation {
    private static let automationFlags: Set<String> = [
        "--frames", "--frame-log", "--autopilot", "--flythrough", "--capture",
        "--offscreen", "--autohost", "--autojoin", "--duel-map", "--duel-shot",
        "--duel-hide", "--event-log", "--match-log", "--code-out", "--soldier-bench",
    ]

    static let background: Bool = {
        let env = ProcessInfo.processInfo.environment
        if env["IRONVALE_SHOW"] == "1" { return false }
        if env["IRONVALE_BACKGROUND"] == "1" { return true }
        return CommandLine.arguments.contains { automationFlags.contains($0) }
    }()

    static var activationPolicy: NSApplication.ActivationPolicy {
        background ? .accessory : .regular
    }

    /// Replaces `makeKeyAndOrderFront` + `NSApp.activate()`.
    static func present(_ window: NSWindow, activate: Bool = true) {
        guard background else {
            window.makeKeyAndOrderFront(nil)
            if activate { NSApp.activate() }
            return
        }
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.orderFrontRegardless()
    }

    /// Replaces a bare `NSApp.activate()`.
    static func activate() {
        if !background { NSApp.activate() }
    }

    /// Replaces a bare `window.orderFront(nil)`.
    static func orderFront(_ window: NSWindow) {
        if background { window.orderFrontRegardless() } else { window.orderFront(nil) }
    }
}
