// M4 launch arguments, read alongside LaunchOptions and MapRenderOptions:
//   --autopilot PATH   play the input script at PATH (native/ci/m4-autopilot.json) in a solo match,
//                      write the event log, check the M4 event sequence, quit (exit 1 when it fails)
//   --map ID           with --autopilot or --play: the map to play (default: the script's, else range)
//   --play             start a solo match on --map straight away (no menu)
//   --event-log PATH   write every GameEvent as a JSON line
//   --offscreen        with --autopilot: no window or display link; fixed 1/120 s frames rendered offscreen
//   --bots N           with --autopilot or --play: a skirmish against N bots (M7b); with --autopilot the run
//                      checks the bot scenario (BotScenarioMonitor) instead of the M4 event sequence
// With neither --autopilot nor --play nor --map, the app opens the menu (IronvaleUI RootView).
import Foundation

struct GameOptions {
    var autopilotPath: String?
    var eventLogPath: String?
    var play = false
    var mapId: String?
    var offscreen = false
    var botCount = 0
    /// Any argument that selects an M3 renderer mode (capture, flythrough, benchmark).
    var rendererMode = false

    static func parse(_ arguments: some Sequence<String>) -> GameOptions {
        var options = GameOptions()
        var iterator = arguments.makeIterator()
        while let arg = iterator.next() {
            switch arg {
            case "--autopilot": options.autopilotPath = iterator.next()
            case "--event-log": options.eventLogPath = iterator.next()
            case "--play": options.play = true
            case "--map": options.mapId = iterator.next()
            case "--offscreen": options.offscreen = true
            case "--bots": options.botCount = iterator.next().flatMap { Int($0) } ?? 0
            case "--capture", "--flythrough": options.rendererMode = true
            default: continue
            }
        }
        return options
    }

    /// The game owns this launch: an autopilot or play request, or a plain launch that shows the menu.
    var wantsGame: Bool {
        if rendererMode { return false }
        return autopilotPath != nil || play || mapId == nil
    }
}
