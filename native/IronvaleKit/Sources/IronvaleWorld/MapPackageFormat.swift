// Readers for the collision files native/Tools/map-export writes (layout documented in
// native/Tools/map-export/page/collision.ts). All values are little-endian.
import Foundation

public enum MapFormatError: Error, CustomStringConvertible, Equatable {
    case invalid(String)

    public var description: String {
        switch self {
        case let .invalid(message): "map package: \(message)"
        }
    }
}

/// Sequential little-endian reader over a byte buffer.
public struct ByteReader {
    private let bytes: [UInt8]
    public private(set) var offset = 0

    public init(_ data: Data) {
        bytes = [UInt8](data)
    }

    public var remaining: Int { bytes.count - offset }

    mutating func need(_ count: Int) throws {
        guard count >= 0, offset + count <= bytes.count else {
            throw MapFormatError.invalid("truncated at byte \(offset), needed \(count) more")
        }
    }

    public mutating func magic(_ expected: String) throws {
        try need(4)
        let found = String(decoding: bytes[offset ..< offset + 4], as: UTF8.self)
        guard found == expected else { throw MapFormatError.invalid("expected \(expected), found \(found)") }
        offset += 4
    }

    public mutating func u32() throws -> UInt32 {
        try need(4)
        let value = UInt32(bytes[offset]) | UInt32(bytes[offset + 1]) << 8 | UInt32(bytes[offset + 2]) << 16 | UInt32(bytes[offset + 3]) << 24
        offset += 4
        return value
    }

    public mutating func count() throws -> Int { Int(try u32()) }

    public mutating func u32s(_ n: Int) throws -> [UInt32] {
        try need(n * 4)
        var out = [UInt32](repeating: 0, count: n)
        out.withUnsafeMutableBytes { dst in
            bytes.withUnsafeBytes { src in
                dst.copyMemory(from: UnsafeRawBufferPointer(rebasing: src[offset ..< offset + n * 4]))
            }
        }
        offset += n * 4
        return out.map { UInt32(littleEndian: $0) }
    }

    public mutating func f32s(_ n: Int) throws -> [Float] {
        try u32s(n).map { Float(bitPattern: $0) }
    }

    public mutating func f64() throws -> Double {
        try need(8)
        var bits: UInt64 = 0
        for k in 0 ..< 8 { bits |= UInt64(bytes[offset + k]) << (8 * UInt64(k)) }
        offset += 8
        return Double(bitPattern: bits)
    }

    public mutating func u8s(_ n: Int) throws -> [UInt8] {
        try need(n)
        let out = Array(bytes[offset ..< offset + n])
        offset += n
        return out
    }

    public mutating func skip(_ n: Int) throws {
        try need(n)
        offset += n
    }
}

/// The collision part of a map package: collision.bin, boundary.bin and bvh.bin.
public enum CollisionPackage {
    /// Reads the three files and returns a world that walks the serialized trees.
    public static func load(collision: Data, boundary: Data, bvh: Data) throws -> CollisionWorld {
        var c = ByteReader(collision)
        try c.magic("IVC1")
        guard try c.u32() == 1 else { throw MapFormatError.invalid("collision.bin version") }
        let triangles = try c.count()
        _ = try c.u32()
        let positions = try c.f32s(triangles * 9)
        let surfaceBytes = try c.u8s(triangles)
        let surfaces = try surfaceBytes.map { byte -> Surface in
            guard let s = Surface(rawValue: byte) else { throw MapFormatError.invalid("unknown surface \(byte)") }
            return s
        }

        var b = ByteReader(boundary)
        try b.magic("IVB1")
        guard try b.u32() == 1 else { throw MapFormatError.invalid("boundary.bin version") }
        let boundaryTriangles = try b.count()
        _ = try b.u32()
        let boundaryPositions = try b.f32s(boundaryTriangles * 9)
        guard b.remaining == 0 else { throw MapFormatError.invalid("boundary.bin has trailing bytes") }

        var t = ByteReader(bvh)
        try t.magic("IVT1")
        guard try t.u32() == 1, try t.u32() == 2 else { throw MapFormatError.invalid("bvh.bin header") }
        _ = try t.u32()
        let mainTree = try readTree(&t, positions: positions)
        let boundaryTree = try readTree(&t, positions: boundaryPositions)
        guard let mainTree else { throw MapFormatError.invalid("bvh.bin has no main tree") }
        guard (boundaryTree == nil) == boundaryPositions.isEmpty else {
            throw MapFormatError.invalid("boundary tree and boundary triangles disagree")
        }
        return try CollisionWorld(main: mainTree, boundary: boundaryTree, surfaces: surfaces)
    }

    static func readTree(_ r: inout ByteReader, positions: [Float]) throws -> TriangleBVH? {
        let present = try r.u32()
        let indexCount = try r.count()
        let nodeBytes = try r.count()
        _ = try r.u32()
        guard present == 1 else { return nil }
        guard nodeBytes % (wordsPerNode * 4) == 0 else { throw MapFormatError.invalid("BVH node bytes \(nodeBytes)") }
        let index = try r.u32s(indexCount)
        let nodes = try r.u32s(nodeBytes / 4)
        return try TriangleBVH(positions: positions, index: index, nodes: nodes)
    }
}
