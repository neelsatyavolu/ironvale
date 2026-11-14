import Foundation
import Testing
@testable import IronvaleRender

private func header(_ width: Int, _ height: Int) -> [UInt8] {
    Array("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y \(height) +X \(width)\n".utf8)
}

@Test func decodesFlatScanlines() throws {
    // Two pixels: (128,64,32, e=129) -> value * 2^(129-128) / 255; e=0 is black.
    let data = Data(header(2, 1) + [128, 64, 32, 129, 200, 200, 200, 0])
    let hdr = try RadianceHDR.decode(data)
    #expect(hdr.width == 2 && hdr.height == 1)
    #expect(abs(hdr.pixels[0] - 128 * 2 / 255) < 1e-5)
    #expect(abs(hdr.pixels[2] - 32 * 2 / 255) < 1e-5)
    #expect(hdr.pixels[3...5].allSatisfy { $0 == 0 })
}

@Test func decodesRunLengthScanlines() throws {
    // Width 8, new-style RLE: each channel is one run of 8 (count 128 + 8).
    let line: [UInt8] = [2, 2, 0, 8] + [136, 10] + [136, 20] + [136, 30] + [136, 128]
    let hdr = try RadianceHDR.decode(Data(header(8, 1) + line))
    for x in 0..<8 {
        #expect(abs(hdr.pixels[x * 3] - 10.0 / 255) < 1e-6)
        #expect(abs(hdr.pixels[x * 3 + 2] - 30.0 / 255) < 1e-6)
    }
}

@Test func rejectsBadFiles() {
    #expect(throws: RadianceHDR.DecodeError.self) { try RadianceHDR.decode(Data("P6\n".utf8)) }
    #expect(throws: RadianceHDR.DecodeError.self) { try RadianceHDR.decode(Data(header(8, 2) + [2, 2, 0, 8, 136])) }
}
