// The minimap's layout raster per map (`buildLayout` over the bots' NavGrid), baked from src/ by
// native/Tools/ui-fixtures/hud-fixtures.test.ts into Resources/HUD/minimap-<map>.bin, and painted the
// way minimap.ts `paintLayout` paints it: CELL_PIXELS texels per cell, walls grey, floor a faint tint.
import Foundation

public struct MinimapLayout: Sendable {
    public let nx: Int
    public let nz: Int
    public let originX: Double
    public let originZ: Double
    /// Metres per cell.
    public let cell: Double
    /// One byte per cell, row by row along +Z: HUDMath.cellFloor, cellWall or cellSolid.
    public let cells: [UInt8]

    /// minimap.ts CELL_PIXELS.
    public static let cellPixels = 3

    public struct DecodeError: Error, CustomStringConvertible { public let description: String }

    /// "IVL1", u32 nx, u32 nz, u32 0, f64 originX, f64 originZ, f64 cell, then nx * nz bytes.
    public init(data: Data) throws {
        let bytes = [UInt8](data)
        guard bytes.count >= 40, bytes[0..<4] == [0x49, 0x56, 0x4C, 0x31] else { throw DecodeError(description: "not a minimap layout") }
        func u32(_ at: Int) -> Int { Int(bytes[at]) | Int(bytes[at + 1]) << 8 | Int(bytes[at + 2]) << 16 | Int(bytes[at + 3]) << 24 }
        func f64(_ at: Int) -> Double {
            var bits: UInt64 = 0
            for i in 0..<8 { bits |= UInt64(bytes[at + i]) << (8 * UInt64(i)) }
            return Double(bitPattern: bits)
        }
        nx = u32(4)
        nz = u32(8)
        originX = f64(16)
        originZ = f64(24)
        cell = f64(32)
        guard nx > 0, nz > 0, cell > 0, bytes.count == 40 + nx * nz else { throw DecodeError(description: "bad minimap layout size") }
        cells = Array(bytes[40...])
    }

    public static func load(directory: URL, mapId: String) throws -> MinimapLayout {
        try MinimapLayout(data: Data(contentsOf: directory.appending(path: "minimap-\(mapId).bin")))
    }

    /// RGBA8, premultiplied, `nx * cellPixels` by `nz * cellPixels`, as the web's layout canvas.
    public func paint() -> (width: Int, height: Int, pixels: [UInt8]) {
        let c = HUDConstants.shared
        let wall = HUDColor(css: c.minimapWall), floor = HUDColor(css: c.minimapFloor)
        func premul(_ color: HUDColor) -> [UInt8] {
            [color.r * color.a, color.g * color.a, color.b * color.a, color.a].map { UInt8(($0 * 255).rounded()) }
        }
        let wallPx = premul(wall), floorPx = premul(floor)
        let k = Self.cellPixels
        let width = nx * k, height = nz * k
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for iz in 0..<nz {
            for ix in 0..<nx {
                let kind = cells[iz * nx + ix]
                guard kind != HUDMath.cellSolid else { continue }
                let px = kind == HUDMath.cellWall ? wallPx : floorPx
                for dy in 0..<k {
                    var o = ((iz * k + dy) * width + ix * k) * 4
                    for _ in 0..<k {
                        pixels[o] = px[0]; pixels[o + 1] = px[1]; pixels[o + 2] = px[2]; pixels[o + 3] = px[3]
                        o += 4
                    }
                }
            }
        }
        return (width, height, pixels)
    }
}
