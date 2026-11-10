// Native input and window facts for scripts/dev/app-check.mjs.
// Build: swiftc -O scripts/dev/app-input.swift -o <somewhere>/app-input
// Posting events needs Accessibility permission for the terminal that runs it.
//
//   window <pid>                              {"id","x","y","w","h"} of the app's main window
//   cursor                                    {"visible","x","y"}
//   frontmost                                 pid of the frontmost app
//   idle                                      seconds since the last key, click or scroll
//   click <pid> <x> <y>                       left click at a global point
//   key <pid> <keycode> [holdMs]              key down, hold, key up
//   move <pid> <dx> <dy> <count> <ms> [hid]   mouse-moved events carrying deltas
//
// Events go straight to the process (they cannot land in another app). With `hid`
// they go through the system event stream instead, as a real mouse would, and
// only if the app is frontmost.
import ApplicationServices
import Cocoa

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func json(_ value: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}

let args = CommandLine.arguments.dropFirst().map { $0 }
guard let command = args.first else { fail("usage: app-input <window|cursor|frontmost|idle|click|key|move> ...") }
func int(_ index: Int) -> Int {
  guard index < args.count, let value = Int(args[index]) else { fail("argument \(index) must be a whole number") }
  return value
}
func number(_ index: Int) -> Double {
  guard index < args.count, let value = Double(args[index]) else { fail("argument \(index) must be a number") }
  return value
}

let source = CGEventSource(stateID: .hidSystemState)
let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1

switch command {
case "window":
  let pid = int(1)
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let match = list.first { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
  guard let window = match, let bounds = window[kCGWindowBounds as String] as? [String: Double] else { fail("no window for pid \(pid)") }
  json(["id": window[kCGWindowNumber as String] as? Int ?? 0, "x": bounds["X"] ?? 0, "y": bounds["Y"] ?? 0, "w": bounds["Width"] ?? 0, "h": bounds["Height"] ?? 0])

case "cursor":
  let position = CGEvent(source: nil)?.location ?? .zero
  // Swift hides this old call; it still answers, and nothing newer reports cursor visibility.
  typealias IsVisible = @convention(c) () -> UInt32
  let visible = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGCursorIsVisible").map { unsafeBitCast($0, to: IsVisible.self)() != 0 }
  json(["visible": visible as Any? ?? NSNull(), "x": position.x, "y": position.y])

case "frontmost":
  print(frontmost)

case "idle":
  // Keys, clicks and scrolling only: pointer movement alone is ignored, because something on a
  // busy Mac (a resting hand, another tool) often nudges the pointer every second or so.
  let kinds: [CGEventType] = [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
  print(kinds.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? 0)

case "click":
  let pid = pid_t(int(1))
  let point = CGPoint(x: number(2), y: number(3))
  for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
    guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { fail("could not make the event") }
    if type != .mouseMoved { event.setIntegerValueField(.mouseEventClickState, value: 1) }
    event.postToPid(pid)
    usleep(60_000)
  }

case "key":
  let pid = pid_t(int(1))
  let code = CGKeyCode(int(2))
  let hold = args.count > 3 ? int(3) : 60
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { fail("could not make the event") }
  down.postToPid(pid)
  usleep(useconds_t(hold * 1000))
  up.postToPid(pid)

case "move":
  let pid = pid_t(int(1))
  let (dx, dy, count, interval) = (int(2), int(3), int(4), int(5))
  let hid = args.count > 6 && args[6] == "hid"
  if hid && frontmost != pid { fail("the app is not frontmost; not posting to the system stream") }
  let position = CGEvent(source: nil)?.location ?? .zero
  for _ in 0..<count {
    guard let event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: position, mouseButton: .left) else { fail("could not make the event") }
    event.setIntegerValueField(.mouseEventDeltaX, value: Int64(dx))
    event.setIntegerValueField(.mouseEventDeltaY, value: Int64(dy))
    if hid { event.post(tap: .cghidEventTap) } else { event.postToPid(pid) }
    usleep(useconds_t(interval * 1000))
  }

default:
  fail("unknown command \(command)")
}
