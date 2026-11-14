// Reader for map-export's render capture (native/Tools/map-export/page/render.ts):
// render/scene.json, format "ironvale-map-render" version 1, plus render/buffers.bin.
// This is the M2 flat format; IVM replaces it once asset-bake exists (PLAN.md 3.5).
import Foundation

public struct MapRenderScene: Decodable, Sendable {
    public struct Accessor: Decodable, Sendable {
        public let offset: Int
        public let byteLength: Int
        public let count: Int
        public let itemSize: Int
        public let type: String
        public let normalized: Bool
    }

    public struct Geometry: Decodable, Sendable {
        public struct Range: Decodable, Sendable {
            public let start: Int
            public let count: Int
        }
        public let name: String
        public let attributes: [String: Int]
        public let index: Int?
        public let drawRange: Range
    }

    public struct Texture: Decodable, Sendable {
        public let kind: String
        public let uri: String?
        public let colorSpace: String?
        public let flipY: Bool
        public let repeatUV: [Double]
        public let offset: [Double]
        public let rotation: Double

        enum CodingKeys: String, CodingKey {
            case kind, uri, colorSpace, flipY, offset, rotation
            case repeatUV = "repeat"
        }
    }

    public struct Material: Decodable, Sendable {
        public let type: String
        public let name: String
        public let color: UInt32?
        public let emissive: UInt32?
        public let emissiveIntensity: Double?
        public let roughness: Double?
        public let metalness: Double?
        public let opacity: Double?
        public let transparent: Bool?
        public let alphaTest: Double?
        public let side: Int?
        public let depthWrite: Bool?
        public let depthTest: Bool?
        public let vertexColors: Bool?
        public let fog: Bool?
        public let polygonOffset: Bool?
        public let polygonOffsetFactor: Double?
        public let polygonOffsetUnits: Double?
        public let envMapIntensity: Double?
        public let aoMapIntensity: Double?
        public let normalScale: [Double]?
        public let visible: Bool?
        public let colorWrite: Bool?
        public let maps: [String: Int]
        /// TSL node slots the web material overrides; each is a map-specific surface program (M9).
        public let nodes: [String]
    }

    public struct Instances: Decodable, Sendable {
        public let count: Int
        public let matrices: Int
        public let colors: Int?
    }

    public struct Mesh: Decodable, Sendable {
        public let name: String
        public let path: String
        public let type: String
        public let geometry: Int
        public let material: MaterialRef
        public let matrixWorld: [Double]
        public let castShadow: Bool
        public let receiveShadow: Bool
        public let renderOrder: Int
        public let frustumCulled: Bool
        public let instances: Instances?
    }

    /// A mesh's material: one index, or one per geometry group.
    public enum MaterialRef: Decodable, Sendable {
        case single(Int)
        case multiple([Int])

        public init(from decoder: any Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let one = try? container.decode(Int.self) { self = .single(one) } else { self = .multiple(try container.decode([Int].self)) }
        }
    }

    public struct Light: Decodable, Sendable {
        public let type: String
        public let color: UInt32?
        public let intensity: Double
        public let position: [Double]
        public let distance: Double?
        public let decay: Double?
        public let angle: Double?
        public let penumbra: Double?
        public let groundColor: UInt32?
        public let target: [Double]?
    }

    public let format: String
    public let version: Int
    public let mapId: String
    public let accessors: [Accessor]
    public let geometries: [Geometry]
    public let textures: [Texture]
    public let materials: [Material]
    public let meshes: [Mesh]
    public let lights: [Light]

    public enum LoadError: Error, CustomStringConvertible {
        case wrongFormat(String, Int)
        case accessorOutOfRange(Int)

        public var description: String {
            switch self {
            case .wrongFormat(let format, let version): "render/scene.json is \(format) v\(version), expected ironvale-map-render v1"
            case .accessorOutOfRange(let index): "accessor \(index) lies outside buffers.bin"
            }
        }
    }

    /// Decodes `render/scene.json` and checks every accessor fits `bufferLength` bytes.
    public static func load(sceneJSON: Data, bufferLength: Int) throws -> MapRenderScene {
        let scene = try JSONDecoder().decode(MapRenderScene.self, from: sceneJSON)
        guard scene.format == "ironvale-map-render", scene.version == 1 else {
            throw LoadError.wrongFormat(scene.format, scene.version)
        }
        for (i, a) in scene.accessors.enumerated() where a.offset < 0 || a.offset + a.byteLength > bufferLength {
            throw LoadError.accessorOutOfRange(i)
        }
        return scene
    }
}

/// Why the generic PBR path leaves a mesh out (each is a map-specific program, PLAN.md M9).
public enum GenericSkipReason: String, Sendable {
    /// Custom vertex program, such as the Railyard sky dome (src/maps/railyard/sky.ts).
    case customVertex = "vertexNode"
    /// Opacity comes only from a TSL node (decal shapes, chain-link); drawn opaque it would cover the scene.
    case nodeOpacity = "opacityNode without an alpha texture"
    case invisible = "material not visible"
}

extension MapRenderScene.Material {
    public var genericSkipReason: GenericSkipReason? {
        if visible == false || colorWrite == false { return .invisible }
        if nodes.contains("vertexNode") || nodes.contains("positionNode") { return .customVertex }
        if nodes.contains("opacityNode"), maps["map"] == nil, maps["alphaMap"] == nil { return .nodeOpacity }
        return nil
    }

    public var isUnlit: Bool { type.hasPrefix("MeshBasic") }

    /// The albedo comes from a TSL colour program and no colour texture was exported, so
    /// `color` says nothing about it (three replaces `color * map` with `colorNode`; vertex and
    /// instance colours still multiply in). Until M9 ports the program, such surfaces are drawn
    /// with `placeholderAlbedo` rather than the meaningless white `color`.
    public var hasNodeAlbedo: Bool { nodes.contains("colorNode") && maps["map"] == nil }

    /// sRGB 0.5 grey, in linear.
    public static let placeholderAlbedo = SIMD3<Float>(repeating: 0.214)
}
