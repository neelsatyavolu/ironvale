// IVM: Ironvale's native model container (PLAN.md 3.5). native/Tools/asset-bake converts glTF
// binaries into it offline (ivm.mjs is the writer), so the client needs no glTF loader.
//
// Layout, little-endian, every item padded to 4 bytes. `str` is u32 byte length + UTF-8 + padding.
//   header      u32 magic "IVM1", u32 version (1), u32 counts: nodes, meshes, skins, materials,
//               textures, animations
//   textures    str name, str uri (relative to the .ivm), u32 colorSpace (0 linear, 1 sRGB),
//               u32 width, u32 height
//   materials   str name, f32x4 baseColor, f32 metallic, f32 roughness, f32 normalScale,
//               f32x3 emissive, u32 flags (bit 0 double-sided, bits 1-2 alpha mode 0 opaque,
//               1 mask, 2 blend), f32 alphaCutoff, i32 texture index for baseColor, normal,
//               metallicRoughness, occlusion, emissive (-1 none)
//   meshes      str name, u32 primitive count, then per primitive: i32 material, u32 vertex count,
//               u32 attribute mask (1 normal, 2 uv0, 4 tangent, 8 joints, 16 weights), f32x3 min,
//               f32x3 max, position f32x3[n], then the masked streams in that order (normal f32x3,
//               uv f32x2, tangent f32x4, joints u16x4, weights f32x4 normalised to sum 1),
//               u32 index count, u32 index size (2 or 4), indices
//   nodes       depth-first, parents first: str name, i32 parent, i32 mesh, i32 skin,
//               f64x3 translation, f64x4 rotation (x y z w), f64x3 scale (glTF keeps these as
//               JSON numbers; f64 keeps them exact)
//   skins       str name, i32 skeleton node, u32 joint count, i32 joint node[count],
//               f32x16 inverse bind matrix[count] (column-major)
//   animations  str name, u32 channel count, then per channel: i32 node, u32 path (0 translation,
//               1 rotation, 2 scale, 3 weights), u32 interpolation (0 linear, 1 step, 2 cubic),
//               u32 key count, u32 components, f32 times[keys], f32 values[keys x components
//               (x 3 for cubic)]
import Foundation

public struct IVMModel: Sendable {
    public static let magic: UInt32 = 0x314d_5649
    public static let version: UInt32 = 1

    public struct Texture: Sendable {
        public let name: String
        public let uri: String
        public let srgb: Bool
        public let width: Int
        public let height: Int
    }

    public enum AlphaMode: UInt32, Sendable { case opaque = 0, mask = 1, blend = 2 }

    public struct Material: Sendable {
        public let name: String
        public let baseColor: SIMD4<Float>
        public let metallic: Float
        public let roughness: Float
        public let normalScale: Float
        public let emissive: SIMD3<Float>
        public let doubleSided: Bool
        public let alphaMode: AlphaMode
        public let alphaCutoff: Float
        public let baseColorTexture: Int?
        public let normalTexture: Int?
        public let metallicRoughnessTexture: Int?
        public let occlusionTexture: Int?
        public let emissiveTexture: Int?
    }

    public struct Primitive: Sendable {
        public let material: Int?
        public let vertexCount: Int
        public let boundsMin: SIMD3<Float>
        public let boundsMax: SIMD3<Float>
        /// Tightly packed streams; empty when the attribute is absent.
        public let positions: [Float]
        public let normals: [Float]
        public let uvs: [Float]
        public let tangents: [Float]
        public let joints: [UInt16]
        public let weights: [Float]
        public let indices: [UInt32]
    }

    public struct Mesh: Sendable {
        public let name: String
        public let primitives: [Primitive]
    }

    public struct Node: Sendable {
        public let name: String
        public let parent: Int?
        public let mesh: Int?
        public let skin: Int?
        public let translation: SIMD3<Double>
        /// x, y, z, w.
        public let rotation: SIMD4<Double>
        public let scale: SIMD3<Double>
    }

    public struct Skin: Sendable {
        public let name: String
        public let skeleton: Int?
        public let joints: [Int]
        /// Column-major 4x4 per joint.
        public let inverseBindMatrices: [Float]
    }

    public enum Path: UInt32, Sendable { case translation = 0, rotation = 1, scale = 2, weights = 3 }
    public enum Interpolation: UInt32, Sendable { case linear = 0, step = 1, cubicSpline = 2 }

    public struct Channel: Sendable {
        public let node: Int
        public let path: Path
        public let interpolation: Interpolation
        public let components: Int
        public let times: [Float]
        public let values: [Float]
    }

    public struct Animation: Sendable {
        public let name: String
        public let channels: [Channel]
    }

    public let textures: [Texture]
    public let materials: [Material]
    public let meshes: [Mesh]
    public let nodes: [Node]
    public let skins: [Skin]
    public let animations: [Animation]

    public enum ReadError: Error, CustomStringConvertible, Equatable {
        case badMagic
        case unsupportedVersion(UInt32)
        case truncated(at: Int, need: Int)
        case invalid(String)

        public var description: String {
            switch self {
            case .badMagic: "not an IVM file"
            case .unsupportedVersion(let v): "IVM version \(v) is not supported (reader is \(IVMModel.version))"
            case .truncated(let at, let need): "IVM truncated: needed \(need) bytes at offset \(at)"
            case .invalid(let why): "IVM invalid: \(why)"
            }
        }
    }

    public init(contentsOf url: URL) throws {
        try self.init(data: Data(contentsOf: url, options: .mappedIfSafe))
    }

    public init(data: Data) throws {
        var r = Reader(data: data)
        guard try r.u32() == Self.magic else { throw ReadError.badMagic }
        let version = try r.u32()
        guard version == Self.version else { throw ReadError.unsupportedVersion(version) }
        let nodeCount = try r.count(), meshCount = try r.count(), skinCount = try r.count()
        let materialCount = try r.count(), textureCount = try r.count(), animationCount = try r.count()

        textures = try (0..<textureCount).map { _ in
            Texture(name: try r.str(), uri: try r.str(), srgb: try r.u32() == 1, width: try r.count(), height: try r.count())
        }
        func textureRef(_ value: Int32) throws -> Int? {
            if value < 0 { return nil }
            guard Int(value) < textureCount else { throw ReadError.invalid("texture index \(value)") }
            return Int(value)
        }
        materials = try (0..<materialCount).map { _ in
            let name = try r.str()
            let base = try r.f32s(4)
            let mr = try r.f32s(3)
            let emissive = try r.f32s(3)
            let flags = try r.u32()
            let cutoff = try r.f32s(1)[0]
            guard let alpha = AlphaMode(rawValue: (flags >> 1) & 3) else { throw ReadError.invalid("alpha mode") }
            return Material(
                name: name, baseColor: SIMD4(base[0], base[1], base[2], base[3]), metallic: mr[0], roughness: mr[1],
                normalScale: mr[2], emissive: SIMD3(emissive[0], emissive[1], emissive[2]), doubleSided: flags & 1 != 0,
                alphaMode: alpha, alphaCutoff: cutoff,
                baseColorTexture: try textureRef(r.i32()), normalTexture: try textureRef(r.i32()),
                metallicRoughnessTexture: try textureRef(r.i32()), occlusionTexture: try textureRef(r.i32()),
                emissiveTexture: try textureRef(r.i32()))
        }
        meshes = try (0..<meshCount).map { _ in
            let name = try r.str()
            let primitives = try (0..<r.count()).map { _ -> Primitive in
                let material = try r.i32()
                let n = try r.count()
                let mask = try r.u32()
                let lo = try r.f32s(3), hi = try r.f32s(3)
                let positions = try r.f32s(n * 3)
                let normals = mask & 1 != 0 ? try r.f32s(n * 3) : []
                let uvs = mask & 2 != 0 ? try r.f32s(n * 2) : []
                let tangents = mask & 4 != 0 ? try r.f32s(n * 4) : []
                let joints = mask & 8 != 0 ? try r.u16s(n * 4) : []
                let weights = mask & 16 != 0 ? try r.f32s(n * 4) : []
                let indexCount = try r.count()
                let indexSize = try r.u32()
                let indices: [UInt32]
                switch indexSize {
                case 2: indices = try r.u16s(indexCount).map(UInt32.init)
                case 4: indices = try r.u32s(indexCount)
                default: throw ReadError.invalid("index size \(indexSize)")
                }
                if let bad = indices.first(where: { Int($0) >= n }) { throw ReadError.invalid("index \(bad) >= \(n) vertices") }
                guard material < materialCount else { throw ReadError.invalid("material index \(material)") }
                return Primitive(material: material < 0 ? nil : Int(material), vertexCount: n,
                                 boundsMin: SIMD3(lo[0], lo[1], lo[2]), boundsMax: SIMD3(hi[0], hi[1], hi[2]),
                                 positions: positions, normals: normals, uvs: uvs, tangents: tangents,
                                 joints: joints, weights: weights, indices: indices)
            }
            return Mesh(name: name, primitives: primitives)
        }
        nodes = try (0..<nodeCount).map { index in
            let name = try r.str()
            let parent = try r.i32(), mesh = try r.i32(), skin = try r.i32()
            let trs = try r.f64s(10)
            guard parent < Int32(index), mesh < Int32(meshCount), skin < Int32(skinCount) else {
                throw ReadError.invalid("node \(name) references out of range")
            }
            return Node(name: name, parent: parent < 0 ? nil : Int(parent), mesh: mesh < 0 ? nil : Int(mesh),
                        skin: skin < 0 ? nil : Int(skin), translation: SIMD3(trs[0], trs[1], trs[2]),
                        rotation: SIMD4(trs[3], trs[4], trs[5], trs[6]), scale: SIMD3(trs[7], trs[8], trs[9]))
        }
        skins = try (0..<skinCount).map { _ in
            let name = try r.str()
            let skeleton = try r.i32()
            let count = try r.count()
            let joints = try (0..<count).map { _ in Int(try r.i32()) }
            guard joints.allSatisfy({ $0 >= 0 && $0 < nodeCount }) else { throw ReadError.invalid("skin \(name) joint out of range") }
            return Skin(name: name, skeleton: skeleton < 0 ? nil : Int(skeleton), joints: joints,
                        inverseBindMatrices: try r.f32s(count * 16))
        }
        animations = try (0..<animationCount).map { _ in
            let name = try r.str()
            let channels = try (0..<r.count()).map { _ -> Channel in
                let node = try r.i32()
                guard let path = Path(rawValue: try r.u32()), let interpolation = Interpolation(rawValue: try r.u32()) else {
                    throw ReadError.invalid("animation \(name) channel kind")
                }
                let keys = try r.count(), components = try r.count()
                guard node >= 0, node < Int32(nodeCount) else { throw ReadError.invalid("animation \(name) node \(node)") }
                let times = try r.f32s(keys)
                let values = try r.f32s(keys * components * (interpolation == .cubicSpline ? 3 : 1))
                return Channel(node: Int(node), path: path, interpolation: interpolation, components: components,
                               times: times, values: values)
            }
            return Animation(name: name, channels: channels)
        }
        guard r.offset == data.count else { throw ReadError.invalid("\(data.count - r.offset) trailing bytes") }
    }

    public func node(named name: String) -> Int? { nodes.firstIndex { $0.name == name } }
}

private struct Reader {
    let data: Data
    var offset = 0

    private mutating func take(_ n: Int) throws -> Range<Int> {
        let padded = (n + 3) & ~3
        guard n >= 0, offset + padded <= data.count else { throw IVMModel.ReadError.truncated(at: offset, need: padded) }
        defer { offset += padded }
        return (data.startIndex + offset)..<(data.startIndex + offset + n)
    }

    private mutating func array<T: FixedWidthInteger>(_ n: Int, of: T.Type) throws -> [T] {
        let range = try take(n * MemoryLayout<T>.size)
        return data[range].withUnsafeBytes { raw in
            (0..<n).map { T(littleEndian: raw.loadUnaligned(fromByteOffset: $0 * MemoryLayout<T>.size, as: T.self)) }
        }
    }

    mutating func u32() throws -> UInt32 { try array(1, of: UInt32.self)[0] }
    mutating func i32() throws -> Int32 { try array(1, of: Int32.self)[0] }
    mutating func count() throws -> Int {
        let value = try u32()
        guard value < 1 << 28 else { throw IVMModel.ReadError.invalid("count \(value)") }
        return Int(value)
    }
    mutating func u16s(_ n: Int) throws -> [UInt16] { try array(n, of: UInt16.self) }
    mutating func u32s(_ n: Int) throws -> [UInt32] { try array(n, of: UInt32.self) }
    mutating func f32s(_ n: Int) throws -> [Float] { try array(n, of: UInt32.self).map(Float.init(bitPattern:)) }
    mutating func f64s(_ n: Int) throws -> [Double] { try array(n, of: UInt64.self).map(Double.init(bitPattern:)) }
    mutating func str() throws -> String {
        let n = try count()
        let range = try take(n)
        guard let text = String(data: data[range], encoding: .utf8) else { throw IVMModel.ReadError.invalid("string at \(offset)") }
        return text
    }
}
