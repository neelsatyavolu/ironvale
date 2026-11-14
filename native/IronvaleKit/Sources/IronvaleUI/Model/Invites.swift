// The player name kept between launches (`readName`/`setName` in src/net/session.ts at cbe0add, key
// `ironvale.net.v1`), and invite links: `ironvale://join?code=CODE` opened by macOS, or a pasted
// `https://ironvale.n3el.dev/?join=CODE` (PLAN.md 3.12, 3.13).
import Foundation
import IronvaleWire

public enum PlayerName {
    public static let storageKey = "ironvale.net.v1"
    public static let fallback = "Player"

    /// The stored name, cleaned as `sanitizeName` does; "Player" when there is none or it is not an object.
    @MainActor public static func read(_ storage: StringStore?) -> String {
        guard let raw = storage?.string(forKey: storageKey), let stored = JSValue.parse(raw), stored.isRecord else { return fallback }
        if case let .string(name)? = stored["name"] { return Sanitize.name(name, fallback: fallback) }
        return fallback
    }

    /// Cleans `raw`, stores `{"name": ...}` and returns the clean name.
    @MainActor @discardableResult
    public static func save(_ raw: String?, to storage: StringStore?) -> String {
        let name = raw.map { Sanitize.name($0, fallback: fallback) } ?? fallback
        storage?.set(JSValue.object([("name", .string(name))]).stringify(), forKey: storageKey)
        return name
    }
}

public enum InviteLink {
    public static let scheme = "ironvale"

    /// The room code an opened URL carries: `ironvale://join?code=CODE` (or `ironvale://join/CODE`), or a web
    /// invite `https://<host>/?join=CODE`. Nil for anything else or a code that is not a room code.
    public static func code(from url: URL) -> String? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        if parts.scheme?.lowercased() == scheme {
            let path = parts.path.split(separator: "/").map(String.init)
            guard parts.host?.lowercased() == "join" || path.first?.lowercased() == "join" else { return nil }
            let raw = parts.queryItems?.first { $0.name == "code" || $0.name == RoomCode.joinParam }?.value ?? path.last { $0.lowercased() != "join" }
            return raw.flatMap(valid)
        }
        guard parts.scheme == "https" || parts.scheme == "http" else { return nil }
        return code(fromText: url.absoluteString)
    }

    /// A pasted invite: text holding `?join=`, `&join=` or `#join=` and a room code after it.
    public static func code(fromText text: String) -> String? {
        let marks = ["?", "&", "#"].map { "\($0)\(RoomCode.joinParam)=" }
        guard marks.contains(where: text.contains) else { return nil }
        return valid(RoomCode.from(text))
    }

    /// `ironvale://join?code=CODE`.
    public static func appURL(code: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = scheme
        parts.host = "join"
        parts.queryItems = [URLQueryItem(name: "code", value: code)]
        return parts.url
    }

    private static func valid(_ raw: String) -> String? {
        let code = RoomCode.from(raw)
        return RoomCode.isValid(code) ? code : nil
    }
}
