// The baked view-model models (native/Tools/viewmodel-export/bake.mjs -> native/BakedAssets/viewmodel):
// one IVM per gun from the gun-export GLBs and one for the first-person arms, turned into rig scene
// graphs with three's GLTFLoader node naming, plus each gun's anchor names (native/MapPackages/guns/<id>.json,
// written by map-export with the GunModel it built in Chrome).
import Foundation
import IronvaleAssets

public struct GunExportMeta: Decodable, Sendable {
    public let id: String
    public let cycleTravel: Double
    public let anchors: [String: String?]
}

public struct BakedMaterialExtras: Decodable, Sendable {
    public let name: String
    public let unlit: Bool
    public let clearcoat: Float
    public let clearcoatRoughness: Float
}

public struct ViewModelManifest: Decodable, Sendable {
    public struct Model: Decodable, Sendable {
        public let id: String
        public let ivmSha256: String
        public let materials: [BakedMaterialExtras]
    }

    public let models: [Model]
}

/// One loaded model: the IVM and its node tree as rig nodes (index-aligned with `model.nodes`).
public final class RigModel {
    public let id: String
    public let ivm: IVMModel
    /// The glTF scene: a group holding the model's root nodes.
    public let scene: RigNode
    public let nodes: [RigNode]
    public let extras: [BakedMaterialExtras]

    public init(id: String, ivm: IVMModel, extras: [BakedMaterialExtras]) {
        self.id = id
        self.ivm = ivm
        self.extras = extras
        scene = RigNode(name: "scene")
        var used: [String: Int] = [:]
        var built: [RigNode] = []
        for (index, node) in ivm.nodes.enumerated() {
            let rig = RigNode(name: Self.uniqueName(node.name, used: &used), source: index)
            rig.position = node.translation
            rig.quaternion = RQuat(node.rotation.x, node.rotation.y, node.rotation.z, node.rotation.w)
            rig.scale = node.scale
            built.append(rig)
            if let parent = node.parent { built[parent].add(rig) } else { scene.add(rig) }
        }
        nodes = built
    }

    /// GLTFLoader names: PropertyBinding.sanitizeNodeName (whitespace to `_`, `[ ] . : /` dropped), made unique with `_N`.
    static func uniqueName(_ raw: String, used: inout [String: Int]) -> String {
        var name = String(raw.map { $0.isWhitespace ? "_" : $0 })
        name.removeAll { "[].:/".contains($0) }
        if let count = used[name] {
            used[name] = count + 1
            return "\(name)_\(count + 1)"
        }
        used[name] = 0
        return name
    }
}

public enum ViewModelAssets {
    public enum LoadError: Error, CustomStringConvertible {
        case missing(String)

        public var description: String {
            switch self { case .missing(let what): "View model asset missing: \(what)" }
        }
    }

    public static func bakedDirectory(repositoryRoot: URL) -> URL { repositoryRoot.appending(path: "native/BakedAssets/viewmodel") }

    public static func manifest(_ directory: URL) throws -> ViewModelManifest {
        let url = directory.appending(path: "manifest.json")
        guard let data = try? Data(contentsOf: url) else {
            throw LoadError.missing("\(url.path) (run node native/Tools/viewmodel-export/bake.mjs)")
        }
        return try JSONDecoder().decode(ViewModelManifest.self, from: data)
    }

    public static func model(_ id: String, directory: URL, manifest: ViewModelManifest) throws -> RigModel {
        guard let entry = manifest.models.first(where: { $0.id == id }) else { throw LoadError.missing("\(id) in the bake manifest") }
        let ivm = try IVMModel(contentsOf: directory.appending(path: "\(id).ivm"))
        return RigModel(id: id, ivm: ivm, extras: entry.materials)
    }

    /// The gun's GunModel from its baked scene graph and the anchor names map-export recorded.
    public static func gun(_ model: RigModel, metaDirectory: URL) throws -> GunModel {
        let url = metaDirectory.appending(path: "\(model.id).json")
        guard let data = try? Data(contentsOf: url) else { throw LoadError.missing(url.path) }
        let meta = try JSONDecoder().decode(GunExportMeta.self, from: data)
        guard model.scene.children.count == 1, let root = model.scene.children.first else {
            throw LoadError.missing("\(model.id): a single root node")
        }
        model.scene.remove(root)
        func find(_ role: String) throws -> RigNode? {
            guard let name = meta.anchors[role] ?? nil else { return nil }
            guard let node = root.named(name) else { throw LoadError.missing("\(model.id): anchor \(role) (\(name))") }
            return node
        }
        func require(_ role: String) throws -> RigNode {
            guard let node = try find(role) else { throw LoadError.missing("\(model.id): anchor \(role)") }
            return node
        }
        var parts: [String: RigNode] = [:]
        for name in GunModel.partNames { parts[name] = try find(name) }
        return GunModel(id: model.id, root: root, muzzle: try require("muzzle"), ejection: try require("ejection"),
                        sight: try require("sight"), parts: parts, cycleTravel: meta.cycleTravel,
                        gripTrigger: try require("gripTrigger"), gripSupport: try require("gripSupport"))
    }
}
