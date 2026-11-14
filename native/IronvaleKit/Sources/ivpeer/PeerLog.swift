// JSON-lines log shared in shape with native/Tools/interop/node-peer.ts, so the interop test can
// compare the two sides: {"at":ms,"kind":...,...}. Frames are logged as sent and as received.
import Foundation
import IronvaleCore
import IronvaleNet

@MainActor
final class PeerLog {
    private let handle: FileHandle?

    init(path: String?) {
        guard let path else {
            handle = nil
            return
        }
        FileManager.default.createFile(atPath: path, contents: nil)
        handle = FileHandle(forWritingAtPath: path)
    }

    func write(_ kind: String, _ fields: [(String, JSONValue)] = []) {
        let line = JSONValue.object(JSONObject([("at", .number(NetClock.now().rounded())), ("kind", .string(kind))] + fields)).stringify()
        if let handle {
            handle.write(Data((line + "\n").utf8))
        } else {
            print(line)
        }
    }

    func frame(_ kind: String, _ channel: NetTap.Channel, _ frame: NetTap.Frame, reason: String? = nil) {
        var fields: [(String, JSONValue)] = [("ch", .string(channel.rawValue))]
        switch frame {
        case .text(let text): fields += [("frame", .string("text")), ("data", .string(text))]
        case .binary(let bytes): fields += [("frame", .string("binary")), ("data", .string(Self.hex(bytes)))]
        }
        if let reason { fields.append(("reason", .string(reason))) }
        write(kind, fields)
    }

    static func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    func close() {
        try? handle?.close()
    }
}
