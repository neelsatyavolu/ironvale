// Ported from src/net/ice.ts at commit cbe0add.
import IronvaleCore

/// One `RTCIceServer`.
public struct IceServer: Sendable, Equatable {
    public var urls: [String]
    public var username: String?
    public var credential: String?

    public init(urls: [String], username: String? = nil, credential: String? = nil) {
        self.urls = urls
        self.username = username
        self.credential = credential
    }
}

public enum IceServers {
    /// Free STUN servers that need no account.
    public static let stun = IceServer(urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"])

    /// `parseIceServers`: a JSON array of `{urls, username?, credential?}`; entries that do not look
    /// like ICE servers are left out, and at most six are read.
    public static func parse(_ raw: String?) -> [IceServer] {
        guard let raw, !raw.isEmpty, let data = JSONValue.parse(raw), let list = data.array else { return [] }
        return list.prefix(TransportLimits.maxExtraServers).compactMap { entry in
            guard let fields = entry.object, let urls = validURLs(fields["urls"]) else { return nil }
            return IceServer(urls: urls, username: fields["username"]?.string, credential: fields["credential"]?.string)
        }
    }

    /// `iceServers(extra)`: STUN first, then the configured extras.
    public static func configured(extra: String?) -> [IceServer] {
        [stun] + parse(extra)
    }

    /// The servers as JSON, in the `RTCIceServer` shape (fixtures and logs).
    public static func json(_ servers: [IceServer]) -> JSONValue {
        .array(servers.map { server in
            var pairs: [(String, JSONValue)] = [("urls", .array(server.urls.map(JSONValue.string)))]
            if let username = server.username { pairs.append(("username", .string(username))) }
            if let credential = server.credential { pairs.append(("credential", .string(credential))) }
            return .object(JSONObject(pairs))
        })
    }

    private static func validURLs(_ value: JSONValue?) -> [String]? {
        let list: [JSONValue]
        switch value {
        case .string(let url)?: list = [.string(url)]
        case .array(let items)?: list = items
        default: return nil
        }
        guard !list.isEmpty, list.count <= 8 else { return nil }
        let urls = list.compactMap(\.string)
        guard urls.count == list.count, urls.allSatisfy(isValidURL) else { return nil }
        return urls
    }

    private static func isValidURL(_ url: String) -> Bool {
        JS.length(url) < 200 && (url.hasPrefix("stun:") || url.hasPrefix("turn:") || url.hasPrefix("turns:"))
    }
}
