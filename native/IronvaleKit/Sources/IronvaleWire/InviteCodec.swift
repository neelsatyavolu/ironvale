// Ported from src/net/invite.ts at commit cbe0add.
//
// Copy-and-paste connection codes: a WebRTC session description deflated (raw DEFLATE, no zlib
// header, as CompressionStream('deflate-raw')) and written in URL-safe base64 without padding.
// The host's invite starts with `IVH1.`, the guest's reply with `IVG1.`.
import Compression
import Foundation
import IronvaleCore

public enum InviteKind: String, Sendable { case offer, answer }

public enum InviteError: String, Error, Sendable { case empty, malformed, tooLong = "too-long", wrongKind = "wrong-kind" }

public enum InviteCodec {
    public static let maxCodeChars = 6000
    /// A data-only description with a dozen candidates is under 2 KB.
    static let maxSdpBytes = 12_000

    public static func prefix(_ kind: InviteKind) -> String {
        switch kind {
        case .offer: "IVH1."
        case .answer: "IVG1."
        }
    }

    public static func encode(kind: InviteKind, sdp: String) -> String {
        prefix(kind) + base64URL(deflate(Array(sdp.utf8)))
    }

    /// Unpack a pasted code. `expected` is the kind this side is waiting for.
    public static func decode(_ text: String, expected: InviteKind) -> Result<String, InviteError> {
        let code = String(String.UnicodeScalarView(text.unicodeScalars.filter { !JS.isWhitespace($0) }))
        if code.isEmpty { return .failure(.empty) }
        if code.utf16.count > maxCodeChars { return .failure(.tooLong) }
        let other: InviteKind = expected == .offer ? .answer : .offer
        if code.hasPrefix(prefix(other)) { return .failure(.wrongKind) }
        guard code.hasPrefix(prefix(expected)) else { return .failure(.malformed) }
        let body = Array(code.utf8.dropFirst(prefix(expected).utf8.count))
        guard !body.isEmpty, body.allSatisfy(isBodyByte), let packed = fromBase64URL(body),
              let bytes = inflate(packed, limit: maxSdpBytes) else { return .failure(.malformed) }
        // `v=0` first, then printable ASCII and line breaks only.
        guard bytes.starts(with: Array("v=0".utf8)),
              bytes.allSatisfy({ (0x20...0x7E).contains($0) || $0 == 0x0D || $0 == 0x0A }) else { return .failure(.malformed) }
        return .success(String(decoding: bytes, as: UTF8.self))
    }

    private static func isBodyByte(_ byte: UInt8) -> Bool {
        (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte) || (0x30...0x39).contains(byte) || byte == 0x2D || byte == 0x5F
    }

    // MARK: Base64url

    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)

    static func base64URL(_ bytes: [UInt8]) -> String {
        var out: [UInt8] = []
        out.reserveCapacity((bytes.count * 4 + 2) / 3)
        var index = 0
        while index < bytes.count {
            let b0 = UInt32(bytes[index])
            let b1 = index + 1 < bytes.count ? UInt32(bytes[index + 1]) : 0
            let b2 = index + 2 < bytes.count ? UInt32(bytes[index + 2]) : 0
            let triple = b0 << 16 | b1 << 8 | b2
            let available = min(3, bytes.count - index) + 1
            for slot in 0..<available {
                out.append(alphabet[Int(triple >> (18 - 6 * slot) & 0x3F)])
            }
            index += 3
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// `atob` after mapping `-_` to `+/`: forgiving base64, no padding required, leftover bits
    /// dropped, a length of 1 mod 4 refused.
    static func fromBase64URL(_ text: [UInt8]) -> [UInt8]? {
        guard text.count % 4 != 1 else { return nil }
        var out: [UInt8] = []
        out.reserveCapacity(text.count * 3 / 4)
        var buffer: UInt32 = 0
        var bits = 0
        for character in text {
            guard let value = alphabet.firstIndex(of: character) else { return nil }
            buffer = buffer << 6 | UInt32(value)
            bits += 6
            if bits >= 8 {
                bits -= 8
                out.append(UInt8(truncatingIfNeeded: buffer >> UInt32(bits)))
            }
        }
        return out
    }

    // MARK: Raw DEFLATE (COMPRESSION_ZLIB in Compression.framework is raw DEFLATE)

    static func deflate(_ input: [UInt8]) -> [UInt8] {
        // A raw-DEFLATE encoder never fails on valid memory; nil here would be a framework fault.
        process(input, operation: COMPRESSION_STREAM_ENCODE, limit: Int.max)!
    }

    /// Inflate, or nil when the data is not one complete DEFLATE stream (truncated, corrupt, or
    /// followed by trailing bytes) or unpacks to more than `limit` bytes.
    static func inflate(_ input: [UInt8], limit: Int) -> [UInt8]? {
        process(input, operation: COMPRESSION_STREAM_DECODE, limit: limit)
    }

    private static func process(_ input: [UInt8], operation: compression_stream_operation, limit: Int) -> [UInt8]? {
        let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { stream.deallocate() }
        guard compression_stream_init(stream, operation, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else { return nil }
        defer { compression_stream_destroy(stream) }
        let chunk = 4096
        let scratch = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
        defer { scratch.deallocate() }
        var output: [UInt8] = []
        return input.withUnsafeBufferPointer { source -> [UInt8]? in
            stream.pointee.src_ptr = source.baseAddress ?? UnsafePointer(scratch)
            stream.pointee.src_size = source.count
            while true {
                stream.pointee.dst_ptr = scratch
                stream.pointee.dst_size = chunk
                let status = compression_stream_process(stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                let produced = chunk - stream.pointee.dst_size
                output.append(contentsOf: UnsafeBufferPointer(start: scratch, count: produced))
                if output.count > limit { return nil }
                switch status {
                case COMPRESSION_STATUS_END:
                    // Bytes after the final block are junk the web's DecompressionStream refuses.
                    return stream.pointee.src_size == 0 ? output : nil
                case COMPRESSION_STATUS_OK:
                    // No progress with input exhausted means the stream was cut off.
                    if produced == 0 && stream.pointee.src_size == 0 { return nil }
                default:
                    return nil
                }
            }
        }
    }
}
