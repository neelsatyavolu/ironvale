// Stand-in guns for the first-person view (src/weapons/view/fallback.ts at commit 185029e). The
// shapes are not hand-copied: native/Tools/sim-fixtures builds them with the TypeScript builder and
// writes native/Contract/sim/fallback-guns.json, which this file turns into triangle lists.
import Foundation
import IronvaleContract
import simd

public struct FallbackGunData: Decodable, Sendable {
    public struct Shape: Decodable, Sendable {
        public let kind: String
        /// Column-major gun-space matrix.
        public let matrix: [Float]
        public let color: UInt32
        public let roughness: Float
        public let metalness: Float
        public let opacity: Float
        public let part: String?
        public let size: [Float]?
        public let radius: Float?
        public let height: Float?
        public let sides: Int?
    }

    public let shapes: [Shape]
    public let muzzle: [Float]
    public let ejection: [Float]
    public let sight: [Float]
    public let cycleTravel: Float

    public static func loadAll(contractDirectory: URL) throws -> [String: FallbackGunData] {
        let url = contractDirectory.appending(path: "sim/fallback-guns.json")
        do {
            return try JSONDecoder().decode([String: FallbackGunData].self, from: Data(contentsOf: url))
        } catch {
            throw ContractError.unreadable("sim/fallback-guns.json", error)
        }
    }
}

/// One vertex of `IVViewModelVertex` in ViewModel.metal (48 bytes, packed).
public struct ViewModelVertex: Sendable {
    public var position: (Float, Float, Float)
    public var normal: (Float, Float, Float)
    public var color: (Float, Float, Float, Float)
    public var material: (Float, Float)
}

public enum FallbackGunMesh {
    /// Opaque triangles first, then the translucent lens shapes.
    public static func vertices(_ gun: FallbackGunData) -> [ViewModelVertex] {
        let ordered = gun.shapes.filter { $0.opacity >= 1 } + gun.shapes.filter { $0.opacity < 1 }
        var out: [ViewModelVertex] = []
        for shape in ordered {
            let m = matrix(shape.matrix)
            let normalMatrix = simd_float3x3(columns: (m.columns.0.xyz, m.columns.1.xyz, m.columns.2.xyz)).inverse.transpose
            let color = linear(shape.color)
            for (p, n) in triangles(shape) {
                let wp = m * SIMD4(p, 1)
                let wn = simd_normalize(normalMatrix * n)
                out.append(ViewModelVertex(position: (wp.x, wp.y, wp.z), normal: (wn.x, wn.y, wn.z),
                                           color: (color.x, color.y, color.z, shape.opacity),
                                           material: (shape.roughness, shape.metalness)))
            }
        }
        return out
    }

    static func matrix(_ e: [Float]) -> simd_float4x4 {
        simd_float4x4(columns: (SIMD4(e[0], e[1], e[2], e[3]), SIMD4(e[4], e[5], e[6], e[7]),
                                SIMD4(e[8], e[9], e[10], e[11]), SIMD4(e[12], e[13], e[14], e[15])))
    }

    /// three's `Color.setHex` puts sRGB hex into linear working space.
    static func linear(_ hex: UInt32) -> SIMD3<Float> {
        func channel(_ c: UInt32) -> Float {
            let s = Float(c & 0xff) / 255
            return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
        }
        return SIMD3(channel(hex >> 16), channel(hex >> 8), channel(hex))
    }

    /// `BoxGeometry(w, h, d)` and `CylinderGeometry(r, r, h, sides)` (axis along Y), as position/normal pairs.
    static func triangles(_ shape: FallbackGunData.Shape) -> [(SIMD3<Float>, SIMD3<Float>)] {
        var tris: [(SIMD3<Float>, SIMD3<Float>)] = []
        func quad(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>, _ d: SIMD3<Float>, _ n: SIMD3<Float>) {
            tris += [(a, n), (b, n), (c, n), (a, n), (c, n), (d, n)]
        }
        if shape.kind == "box", let s = shape.size {
            let h = SIMD3(s[0], s[1], s[2]) * 0.5
            for axis in 0 ..< 3 {
                for sign: Float in [-1, 1] {
                    var n = SIMD3<Float>(repeating: 0)
                    n[axis] = sign
                    let u = (axis + 1) % 3, v = (axis + 2) % 3
                    func corner(_ du: Float, _ dv: Float) -> SIMD3<Float> {
                        var p = SIMD3<Float>(repeating: 0)
                        p[axis] = sign * h[axis]
                        p[u] = du * h[u]
                        p[v] = dv * h[v]
                        return p
                    }
                    if sign > 0 {
                        quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), n)
                    } else {
                        quad(corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1), n)
                    }
                }
            }
        } else if let r = shape.radius, let height = shape.height {
            let sides = max(3, shape.sides ?? 16)
            let y = height / 2
            for i in 0 ..< sides {
                let a0 = Float(i) / Float(sides) * 2 * .pi, a1 = Float(i + 1) / Float(sides) * 2 * .pi
                let p0 = SIMD3(sin(a0) * r, 0, cos(a0) * r), p1 = SIMD3(sin(a1) * r, 0, cos(a1) * r)
                let n0 = simd_normalize(SIMD3(sin(a0), 0, cos(a0))), n1 = simd_normalize(SIMD3(sin(a1), 0, cos(a1)))
                let top = SIMD3<Float>(0, y, 0), bottom = SIMD3<Float>(0, -y, 0)
                tris += [(p0 + top, n0), (p0 + bottom, n0), (p1 + bottom, n1), (p0 + top, n0), (p1 + bottom, n1), (p1 + top, n1)]
                tris += [(top, SIMD3(0, 1, 0)), (p0 + top, SIMD3(0, 1, 0)), (p1 + top, SIMD3(0, 1, 0))]
                tris += [(bottom, SIMD3(0, -1, 0)), (p1 + bottom, SIMD3(0, -1, 0)), (p0 + bottom, SIMD3(0, -1, 0))]
            }
        }
        return tris
    }
}

extension SIMD4 where Scalar == Float {
    var xyz: SIMD3<Float> { SIMD3(x, y, z) }
}
