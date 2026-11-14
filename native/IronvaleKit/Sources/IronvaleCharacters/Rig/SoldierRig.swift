// Ported from src/characters/rig.ts at commit f14381f: everything soldiers share, built once from
// the baked soldier and carbine IVM models (native/Tools/asset-bake) instead of a glTF scene.
import Foundation
import IronvaleAssets
import simd

public enum Team: String, Sendable, CaseIterable { case alpha, bravo }

public struct ArmRig: Sendable {
    public let setup: ArmSetup
    public let shoulder: Int
    public let upper: Int
    public let lower: Int
    public let hand: Int
}

public struct FingerRig: Sendable {
    public let name: String
    public let node: Int
    /// Local rotation with the fingers wrapped around a grip.
    public let grip: Quat
}

public final class SoldierRig: Sendable {
    public enum BuildError: Error, CustomStringConvertible {
        case missing(String)
        public var description: String {
            switch self { case .missing(let what): "soldier model: \(what)" }
        }
    }

    public let tables: CharacterTables
    public let model: IVMModel
    public let carbine: IVMModel
    public let clips: [String: ClipData]
    /// Parent of each clip bone as an index into `clipBones`, -1 for the hips.
    public let parents: [Int]
    public let offsets: [Vec3]
    public let restLocal: [Quat]
    public let restModel: [Quat]
    public let left: ArmRig
    public let right: ArmRig
    public let fingers: [FingerRig]
    /// IVM node index of each clip bone.
    public let boneNodes: [Int]
    /// For each IVM node: the clip bone it is, or -1.
    public let nodeBone: [Int]
    /// Local rotation of every IVM node in a posed soldier when it is not a clip bone (fingers gripping).
    public let nodeLocalRotation: [Quat]
    public let nodeLocalTranslation: [Vec3]
    public let nodeLocalScale: [Vec3]
    /// The skinned mesh's skin and its joint nodes.
    public let skin: IVMModel.Skin
    public let skinnedMesh: Int
    /// Inverse bind matrix of each skin joint.
    public let inverseBindMatrices: [simd_float4x4]

    public init(model: IVMModel, carbine: IVMModel, tables: CharacterTables = .shared) throws {
        self.tables = tables
        self.model = model
        self.carbine = carbine
        let bones = tables.clipBones
        func node(_ name: String) throws -> Int {
            guard let index = model.node(named: name) else { throw BuildError.missing("no bone \"\(name)\"") }
            return index
        }
        let boneNodes = try bones.map(node)
        var nodeBone = [Int](repeating: -1, count: model.nodes.count)
        for (bone, index) in boneNodes.enumerated() { nodeBone[index] = bone }

        let localQ = model.nodes.map { Quat($0.rotation.x, $0.rotation.y, $0.rotation.z, $0.rotation.w) }
        let localP = model.nodes.map(\.translation)
        let localS = model.nodes.map(\.scale)
        // Rest pose in model space (nodes are stored parents first).
        var worldQ = [Quat](repeating: .identity, count: model.nodes.count)
        var worldP = [Vec3](repeating: .zero, count: model.nodes.count)
        var worldS = [Vec3](repeating: Vec3(1, 1, 1), count: model.nodes.count)
        for (i, n) in model.nodes.enumerated() {
            if let p = n.parent {
                worldQ[i] = worldQ[p] * localQ[i]
                worldS[i] = worldS[p] * localS[i]
                worldP[i] = worldP[p] + worldQ[p].rotate(localP[i] * worldS[p])
            } else {
                worldQ[i] = localQ[i]
                worldP[i] = localP[i]
                worldS[i] = localS[i]
            }
        }
        // The skeleton maths treats the hips' parent space as model space: everything above must be identity.
        var above = model.nodes[boneNodes[0]].parent
        while let a = above {
            guard localQ[a] == .identity, localP[a] == .zero, localS[a] == Vec3(1, 1, 1) else {
                throw BuildError.missing("hips ancestor \(model.nodes[a].name) is not an identity transform")
            }
            above = model.nodes[a].parent
        }
        func rest(_ name: String) throws -> JointRest {
            let i = try node(name)
            return JointRest(q: worldQ[i], p: worldP[i])
        }

        var clips: [String: ClipData] = [:]
        for name in tables.clipMeta.keys.sorted() {
            guard let animation = model.animations.first(where: { $0.name == name }) else { throw BuildError.missing("no clip \"\(name)\"") }
            func track(_ nodeIndex: Int, _ path: IVMModel.Path) throws -> [Float] {
                guard let channel = animation.channels.first(where: { $0.node == nodeIndex && $0.path == path }) else {
                    throw BuildError.missing("clip \(name) is missing the track \(model.nodes[nodeIndex].name).\(path)")
                }
                return channel.values
            }
            let hips = try track(boneNodes[0], .translation)
            let frames = hips.count / 3
            var rotations = [Float](repeating: 0, count: frames * bones.count * 4)
            for (bone, nodeIndex) in boneNodes.enumerated() {
                let values = try track(nodeIndex, .rotation)
                guard values.count >= frames * 4 else { throw BuildError.missing("clip \(name) track \(bones[bone]) is short") }
                for frame in 0..<frames {
                    for k in 0..<4 { rotations[(frame * bones.count + bone) * 4 + k] = values[frame * 4 + k] }
                }
            }
            clips[name] = ClipData(bones: bones.count, frames: frames, fps: tables.clipFps, loop: tables.clip(name).loop,
                                   rotations: rotations, hips: hips)
        }
        self.clips = clips

        parents = boneNodes.map { index in
            guard let parent = model.nodes[index].parent else { return -1 }
            return nodeBone[parent]
        }
        offsets = boneNodes.map { localP[$0] }
        restLocal = boneNodes.map { localQ[$0] }
        restModel = boneNodes.map { worldQ[$0] }

        func arm(_ side: ArmSide) throws -> ArmRig {
            let s = side == .left ? "Left" : "Right"
            let setup = ArmIK.calibrate(ArmRest(side: side, upper: try rest("\(s)Arm"), lower: try rest("\(s)ForeArm"),
                                                hand: try rest("\(s)Hand"), fingers: try rest("\(s)HandIndex1").p,
                                                thumb: try rest("\(s)HandThumb1").p), tables: tables)
            return ArmRig(setup: setup, shoulder: tables.boneIndex("\(s)Shoulder"), upper: tables.boneIndex("\(s)Arm"),
                          lower: tables.boneIndex("\(s)ForeArm"), hand: tables.boneIndex("\(s)Hand"))
        }
        left = try arm(.left)
        right = try arm(.right)

        // Fingers: in the T-pose they curl downwards, about the model's Z axis.
        var fingers: [FingerRig] = []
        for s in ["Left", "Right"] {
            let sign: Double = s == "Right" ? -1 : 1
            func curl(_ name: String, _ axis: Vec3, _ angle: Double) {
                guard let i = model.node(named: name) else { return }
                let local = worldQ[i].inverse.rotate(axis)
                fingers.append(FingerRig(name: name, node: i, grip: localQ[i] * Quat.axisAngle(local, angle)))
            }
            for (joint, angle) in (tables.fingerCurl[s] ?? []).enumerated() {
                curl("\(s)HandIndex\(joint + 1)", Vec3(0, 0, 1), sign * angle)
            }
            for (joint, angle) in (tables.thumbFold[s] ?? []).enumerated() {
                curl("\(s)HandThumb\(joint + 1)", Vec3(sign * 0.5, -0.6, -0.6).normalizedThree, -sign * angle)
            }
        }
        self.fingers = fingers
        var posedLocal = localQ
        for finger in fingers { posedLocal[finger.node] = finger.grip }
        nodeLocalRotation = posedLocal
        nodeLocalTranslation = localP
        nodeLocalScale = localS
        self.boneNodes = boneNodes
        self.nodeBone = nodeBone

        guard let meshNode = model.nodes.firstIndex(where: { $0.mesh != nil && $0.skin != nil }),
              let skinIndex = model.nodes[meshNode].skin, let meshIndex = model.nodes[meshNode].mesh
        else { throw BuildError.missing("no skinned mesh") }
        skin = model.skins[skinIndex]
        skinnedMesh = meshIndex
        let ibm = skin.inverseBindMatrices
        inverseBindMatrices = (0..<skin.joints.count).map { j in
            let m = Array(ibm[(j * 16)..<(j * 16 + 16)])
            return simd_float4x4(columns: (SIMD4(m[0], m[1], m[2], m[3]), SIMD4(m[4], m[5], m[6], m[7]),
                                           SIMD4(m[8], m[9], m[10], m[11]), SIMD4(m[12], m[13], m[14], m[15])))
        }
        guard !carbine.meshes.isEmpty else { throw BuildError.missing("carbine has no mesh") }
    }

    /// Loads soldier.ivm and carbine.ivm from a baked characters directory.
    public convenience init(directory: URL, tables: CharacterTables = .shared) throws {
        try self.init(model: IVMModel(contentsOf: directory.appending(path: "soldier.ivm")),
                      carbine: IVMModel(contentsOf: directory.appending(path: "carbine.ivm")), tables: tables)
    }

    /// native/BakedAssets/characters under the repository root found from `start`.
    public static func bakedDirectory(repositoryRoot: URL) -> URL {
        repositoryRoot.appending(path: "native/BakedAssets/characters")
    }
}
