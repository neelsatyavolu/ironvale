// A minimal Object3D for the view-model rig: a transform hierarchy with three's matrix update rules
// (matrix = compose(position, quaternion, scale); matrixWorld = parent.matrixWorld * matrix).
// The gun and arms scene graphs come from their baked IVM node trees (ViewModelAssets.swift).
import simd

public final class RigNode {
    public let name: String
    public private(set) weak var parent: RigNode?
    public private(set) var children: [RigNode] = []
    public var position = RVec3.zero
    public var quaternion = RQuat.identity
    public var scale = RVec3(1, 1, 1)
    public var visible = true
    public private(set) var matrixWorld = matrix_identity_double4x4
    /// Index of the IVM node this came from (nil for nodes the rig makes itself).
    public let source: Int?

    public init(name: String, source: Int? = nil) {
        self.name = name
        self.source = source
    }

    public func add(_ child: RigNode) {
        child.parent?.remove(child)
        child.parent = self
        children.append(child)
    }

    public func remove(_ child: RigNode) {
        children.removeAll { $0 === child }
        if child.parent === self { child.parent = nil }
    }

    public var matrix: simd_double4x4 { RMat.compose(position, quaternion, scale) }

    /// `updateMatrixWorld(true)`: this node and every descendant, from the parent's current world matrix.
    public func updateMatrixWorld() {
        matrixWorld = (parent?.matrixWorld ?? matrix_identity_double4x4) * matrix
        for child in children { child.updateMatrixWorld() }
    }

    /// `updateWorldMatrix(true, false)`: the ancestors and this node, not the children.
    public func updateWorldMatrixFromRoot() {
        parent?.updateWorldMatrixFromRoot()
        matrixWorld = (parent?.matrixWorld ?? matrix_identity_double4x4) * matrix
    }

    public var worldPosition: RVec3 { RMat.position(matrixWorld) }
    public var worldQuaternion: RQuat { RMat.decompose(matrixWorld).quaternion }

    /// Depth-first, parents before children (three's `traverse`).
    public func traverse(_ body: (RigNode) -> Void) {
        body(self)
        for child in children { child.traverse(body) }
    }

    public func first(where predicate: (RigNode) -> Bool) -> RigNode? {
        if predicate(self) { return self }
        for child in children {
            if let found = child.first(where: predicate) { return found }
        }
        return nil
    }

    public func named(_ name: String) -> RigNode? { first { $0.name == name } }
}
