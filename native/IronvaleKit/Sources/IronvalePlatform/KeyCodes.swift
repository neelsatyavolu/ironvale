// macOS virtual key codes (Carbon HIToolbox Events.h, kVK_*) to the browser's `KeyboardEvent.code`
// strings, so a bindings JSON means the same keys in both builds (PLAN.md 3.10).
public enum KeyCodes {
    public static func code(forKeyCode keyCode: UInt16) -> String? { table[keyCode] }

    static let table: [UInt16: String] = [
        0x00: "KeyA", 0x0B: "KeyB", 0x08: "KeyC", 0x02: "KeyD", 0x0E: "KeyE", 0x03: "KeyF", 0x05: "KeyG", 0x04: "KeyH",
        0x22: "KeyI", 0x26: "KeyJ", 0x28: "KeyK", 0x25: "KeyL", 0x2E: "KeyM", 0x2D: "KeyN", 0x1F: "KeyO", 0x23: "KeyP",
        0x0C: "KeyQ", 0x0F: "KeyR", 0x01: "KeyS", 0x11: "KeyT", 0x20: "KeyU", 0x09: "KeyV", 0x0D: "KeyW", 0x07: "KeyX",
        0x10: "KeyY", 0x06: "KeyZ",
        0x1D: "Digit0", 0x12: "Digit1", 0x13: "Digit2", 0x14: "Digit3", 0x15: "Digit4", 0x17: "Digit5", 0x16: "Digit6",
        0x1A: "Digit7", 0x1C: "Digit8", 0x19: "Digit9",
        0x24: "Enter", 0x30: "Tab", 0x31: "Space", 0x33: "Backspace", 0x35: "Escape", 0x75: "Delete",
        0x1B: "Minus", 0x18: "Equal", 0x21: "BracketLeft", 0x1E: "BracketRight", 0x2A: "Backslash", 0x29: "Semicolon",
        0x27: "Quote", 0x32: "Backquote", 0x2B: "Comma", 0x2F: "Period", 0x2C: "Slash",
        0x7B: "ArrowLeft", 0x7C: "ArrowRight", 0x7D: "ArrowDown", 0x7E: "ArrowUp",
        0x73: "Home", 0x77: "End", 0x74: "PageUp", 0x79: "PageDown",
        0x38: "ShiftLeft", 0x3C: "ShiftRight", 0x3B: "ControlLeft", 0x3E: "ControlRight",
        0x3A: "AltLeft", 0x3D: "AltRight", 0x37: "MetaLeft", 0x36: "MetaRight", 0x39: "CapsLock",
        0x7A: "F1", 0x78: "F2", 0x63: "F3", 0x76: "F4", 0x60: "F5", 0x61: "F6", 0x62: "F7", 0x64: "F8",
        0x65: "F9", 0x6D: "F10", 0x67: "F11", 0x6F: "F12",
        0x52: "Numpad0", 0x53: "Numpad1", 0x54: "Numpad2", 0x55: "Numpad3", 0x56: "Numpad4", 0x57: "Numpad5",
        0x58: "Numpad6", 0x59: "Numpad7", 0x5B: "Numpad8", 0x5C: "Numpad9", 0x4C: "NumpadEnter",
    ]

    /// Modifier keys arrive as flagsChanged events; these are the codes that report through them.
    static let modifiers: Set<String> = ["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight",
                                         "MetaLeft", "MetaRight", "CapsLock"]
}
