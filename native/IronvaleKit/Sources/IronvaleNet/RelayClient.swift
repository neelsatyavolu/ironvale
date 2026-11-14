// Ported from src/net/signaling.ts (signalUrl, signalReachable) and src/net/ice.ts
// (fetchRelayServers) at commit cbe0add. Every request carries the client's Origin header,
// which the relay checks against ALLOWED_ORIGINS (PLAN.md 3.11.1).
import Foundation
import IronvaleCore

/// The relay's base URL and the HTTP calls made to it before signaling opens.
public struct RelayClient: Sendable {
    /// Normalised base URL, `ws(s)://` or `http(s)://`, no trailing slash.
    public let baseURL: String
    public let origin: String

    /// nil when `url` is not a relay URL (`signalUrl` returns '' and the room method is off).
    public init?(url: String, origin: String = RelayDefaults.origin) {
        guard let base = Self.normalize(url) else { return nil }
        self.baseURL = base
        self.origin = origin
    }

    public static func normalize(_ url: String) -> String? {
        var text = url.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        let schemes = ["ws://", "wss://", "http://", "https://"]
        return schemes.contains(where: text.hasPrefix) ? text : nil
    }

    /// `toHttp`: ws -> http, wss -> https.
    public var httpBase: String { baseURL.hasPrefix("ws") ? "http" + baseURL.dropFirst(2) : baseURL }
    /// `toWs`: http -> ws, https -> wss.
    public var wsBase: String { baseURL.hasPrefix("http") ? "ws" + baseURL.dropFirst(4) : baseURL }

    public func roomURL(code: String, role: PeerRole) -> URL? {
        URL(string: "\(wsBase)/room/\(code)?role=\(role.rawValue)")
    }

    /// `signalReachable`: true when `/health` answers 2xx within 2.5 s.
    public func healthy() async -> Bool {
        guard let result = await get("/health", timeoutMs: TransportLimits.healthTimeoutMs) else { return false }
        return (200..<300).contains(result.status)
    }

    /// The outcome of asking `/ice` for TURN servers.
    public struct RelayServers: Sendable {
        public let servers: [IceServer]
        /// HTTP status, or nil when the relay did not answer in time.
        public let status: Int?
    }

    /// `fetchRelayServers`: short-lived TURN servers, empty on any failure (the game then tries
    /// STUN only). The status is kept so a 429 can be told apart from a missing TURN key.
    public func relayServers() async -> RelayServers {
        guard let result = await get("/ice", timeoutMs: TransportLimits.relayTimeoutMs) else {
            return RelayServers(servers: [], status: nil)
        }
        guard (200..<300).contains(result.status), let body = JSONValue.parse(String(decoding: result.body, as: UTF8.self)) else {
            return RelayServers(servers: [], status: result.status)
        }
        let list = body["iceServers"] ?? .array([])
        return RelayServers(servers: IceServers.parse(list.stringify()), status: result.status)
    }

    private func get(_ path: String, timeoutMs: Double) async -> (status: Int, body: Data)? {
        guard let url = URL(string: httpBase + path) else { return nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeoutMs / 1000)
        request.setValue(origin, forHTTPHeaderField: "Origin")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            return (http.statusCode, data)
        } catch {
            return nil
        }
    }
}
