// Ported from src/net/room-code.ts at commit cbe0add.
import Foundation
import Security

/// Room codes: six characters that are easy to read aloud (no I, L, O, 0 or 1).
public enum RoomCode {
    public static let alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    public static let length = 6
    /// The query parameter an invite link carries the room code in.
    public static let joinParam = "join"
    private static let letters = Array(alphabet)

    /// A code from `random` (values in [0, 1)), as `makeRoomCode(random)`.
    public static func make(random: () -> Double) -> String {
        var code = ""
        for _ in 0..<length {
            let index = Int((random() * Double(letters.count)).rounded(.down))
            code.append(letters.indices.contains(index) ? letters[index] : "A")
        }
        return code
    }

    /// A code from the system's secure random source (`crypto.getRandomValues` on the web).
    public static func make() -> String {
        make {
            var word: UInt32 = 0
            let status = withUnsafeMutableBytes(of: &word) { SecRandomCopyBytes(kSecRandomDefault, 4, $0.baseAddress!) }
            precondition(status == errSecSuccess, "SecRandomCopyBytes failed: \(status)")
            return Double(word) / 4_294_967_296
        }
    }

    /// Upper-case what was typed and drop everything but A-Z and 0-9.
    public static func normalize(_ text: String) -> String {
        String(String.UnicodeScalarView(text.uppercased().unicodeScalars.filter {
            ("A"..."Z").contains($0) || ("0"..."9").contains($0)
        }))
    }

    public static func isValid(_ code: String) -> Bool {
        code.utf16.count == length && code.unicodeScalars.allSatisfy { alphabet.unicodeScalars.contains($0) }
    }

    /// The room code in what a guest typed or pasted: a bare code, or a whole invite link
    /// (the first `?join=`, `&join=` or `#join=` followed by `[A-Za-z0-9-]+`).
    public static func from(_ text: String) -> String {
        let units = Array(text.utf16)
        let key = Array("\(joinParam)=".utf16)
        var start = 0
        while start + 1 + key.count <= units.count {
            let mark = units[start]
            if mark == 0x3F || mark == 0x26 || mark == 0x23, Array(units[start + 1..<start + 1 + key.count]) == key {
                let valueStart = start + 1 + key.count
                var end = valueStart
                while end < units.count, isCodeCharacter(units[end]) { end += 1 }
                if end > valueStart { return normalize(String(decoding: units[valueStart..<end], as: UTF16.self)) }
            }
            start += 1
        }
        return normalize(text)
    }

    private static func isCodeCharacter(_ unit: UInt16) -> Bool {
        (0x41...0x5A).contains(unit) || (0x61...0x7A).contains(unit) || (0x30...0x39).contains(unit) || unit == 0x2D
    }

    /// The link a host sends: `page` with its query and fragment replaced by `?join=CODE`.
    public static func inviteLink(code: String, page: String) -> String? {
        guard var components = URLComponents(string: page), components.scheme != nil, components.host != nil else { return nil }
        components.query = nil
        components.fragment = nil
        if components.path.isEmpty { components.path = "/" }
        components.queryItems = [URLQueryItem(name: joinParam, value: code)]
        return components.string
    }
}
