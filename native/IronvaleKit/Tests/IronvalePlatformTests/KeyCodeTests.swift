// Every key the web bindings name (native/Contract/sim/sim.json, from src/core/input.ts) must come
// from some macOS key code, and no two key codes may share a `KeyboardEvent.code`.
import Foundation
@testable import IronvalePlatform
import Testing

@Test func everyBoundKeyHasAKeyCode() throws {
    let simJSON = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appending(path: "Contract/sim/sim.json")
    let root = try JSONSerialization.jsonObject(with: Data(contentsOf: simJSON)) as! [String: Any]
    let bindings = (root["input"] as! [String: Any])["bindings"] as! [String: [String: [String]]]
    let known = Set(KeyCodes.table.values)
    let pointer: Set<String> = ["Mouse0", "Mouse2", "WheelUp", "WheelDown"]
    for (preset, actions) in bindings {
        for (action, codes) in actions {
            for code in codes where !pointer.contains(code) {
                #expect(known.contains(code), "\(preset).\(action): \(code) has no macOS key code")
            }
        }
    }
}

@Test func keyCodesAreUnique() {
    #expect(Set(KeyCodes.table.values).count == KeyCodes.table.count)
    #expect(KeyCodes.code(forKeyCode: 0x0D) == "KeyW")
    #expect(KeyCodes.code(forKeyCode: 0x31) == "Space")
    #expect(KeyCodes.code(forKeyCode: 0x38) == "ShiftLeft")
}
