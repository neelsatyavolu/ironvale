import Foundation

/// Decoder for Radiance RGBE (.hdr) files, as three's RGBELoader: the "-Y H +X W" orientation
/// and new-style run-length scanlines. Rows come out top to bottom.
public struct RadianceHDR: Sendable {
    public let width: Int
    public let height: Int
    /// Linear RGB, three floats per pixel, row-major from the top.
    public let pixels: [Float]

    public enum DecodeError: Error, CustomStringConvertible {
        case notRadiance, badHeader(String), unsupportedFormat(String), truncated(row: Int)

        public var description: String {
            switch self {
            case .notRadiance: "not a Radiance HDR file"
            case .badHeader(let line): "bad HDR resolution line: \(line)"
            case .unsupportedFormat(let format): "unsupported HDR format \(format)"
            case .truncated(let row): "HDR data ends early at row \(row)"
            }
        }
    }

    public static func load(_ url: URL) throws -> RadianceHDR {
        try decode(Data(contentsOf: url))
    }

    public static func decode(_ data: Data) throws -> RadianceHDR {
        let bytes = [UInt8](data)
        var pos = 0
        func line() -> String {
            let start = pos
            while pos < bytes.count, bytes[pos] != 0x0a { pos += 1 }
            let text = String(decoding: bytes[start..<pos], as: UTF8.self)
            pos += 1
            return text
        }
        guard line().hasPrefix("#?") else { throw DecodeError.notRadiance }
        while pos < bytes.count {
            let header = line()
            if header.isEmpty { break }
            if header.hasPrefix("FORMAT="), header != "FORMAT=32-bit_rle_rgbe" { throw DecodeError.unsupportedFormat(header) }
        }
        let resolution = line().split(separator: " ")
        guard resolution.count == 4, resolution[0] == "-Y", resolution[2] == "+X",
              let height = Int(resolution[1]), let width = Int(resolution[3]), width > 0, height > 0
        else { throw DecodeError.badHeader(resolution.joined(separator: " ")) }

        var rgbe = [UInt8](repeating: 0, count: width * height * 4)
        var scan = [UInt8](repeating: 0, count: width * 4)
        for row in 0..<height {
            guard pos + 4 <= bytes.count else { throw DecodeError.truncated(row: row) }
            let isRLE = width >= 8 && width < 32768 && bytes[pos] == 2 && bytes[pos + 1] == 2 && (bytes[pos + 2] & 0x80) == 0
            if !isRLE {
                // Flat (uncompressed) scanline.
                let count = width * 4
                guard pos + count <= bytes.count else { throw DecodeError.truncated(row: row) }
                rgbe.replaceSubrange(row * count..<(row + 1) * count, with: bytes[pos..<pos + count])
                pos += count
                continue
            }
            pos += 4
            for channel in 0..<4 {
                var x = 0
                while x < width {
                    guard pos < bytes.count else { throw DecodeError.truncated(row: row) }
                    var count = Int(bytes[pos]); pos += 1
                    if count > 128 {
                        count -= 128
                        guard pos < bytes.count, x + count <= width else { throw DecodeError.truncated(row: row) }
                        let value = bytes[pos]; pos += 1
                        for _ in 0..<count { scan[x * 4 + channel] = value; x += 1 }
                    } else {
                        guard count > 0, pos + count <= bytes.count, x + count <= width else { throw DecodeError.truncated(row: row) }
                        for _ in 0..<count { scan[x * 4 + channel] = bytes[pos]; pos += 1; x += 1 }
                    }
                }
            }
            rgbe.replaceSubrange(row * width * 4..<(row + 1) * width * 4, with: scan)
        }

        var pixels = [Float](repeating: 0, count: width * height * 3)
        for i in 0..<(width * height) {
            let e = rgbe[i * 4 + 3]
            guard e != 0 else { continue }
            let scale = ldexpf(1, Int32(e) - 128) / 255 // three RGBELoader
            pixels[i * 3] = Float(rgbe[i * 4]) * scale
            pixels[i * 3 + 1] = Float(rgbe[i * 4 + 1]) * scale
            pixels[i * 3 + 2] = Float(rgbe[i * 4 + 2]) * scale
        }
        return RadianceHDR(width: width, height: height, pixels: pixels)
    }
}
