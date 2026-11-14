// Unit meshes for the solid effects, built as three builds them: CylinderGeometry(1, 1, 1, 10, 1)
// for casings (casings.ts) and SphereGeometry(r, 12, 8) scaled 1.3 in y for grenade bodies
// (grenade.ts). Non-indexed triangles of (position, normal), 6 floats per vertex.
import Darwin

enum FXGeometry {
    static func cylinder(segments: Int = 10) -> [Float] {
        var out: [Float] = []
        func push(_ p: D3, _ n: D3) { out += [Float(p.x), Float(p.y), Float(p.z), Float(n.x), Float(n.y), Float(n.z)] }
        for i in 0..<segments {
            let a0 = Double(i) / Double(segments) * .pi * 2, a1 = Double(i + 1) / Double(segments) * .pi * 2
            let p0 = D3(sin(a0), 0, cos(a0)), p1 = D3(sin(a1), 0, cos(a1))
            let t0 = D3(p0.x, 0.5, p0.z), b0 = D3(p0.x, -0.5, p0.z), t1 = D3(p1.x, 0.5, p1.z), b1 = D3(p1.x, -0.5, p1.z)
            // Side (counter-clockwise seen from outside).
            push(t0, p0); push(b0, p0); push(t1, p1)
            push(b0, p0); push(b1, p1); push(t1, p1)
            // Caps.
            push(D3(0, 0.5, 0), .up); push(t0, .up); push(t1, .up)
            push(D3(0, -0.5, 0), D3(0, -1, 0)); push(b1, D3(0, -1, 0)); push(b0, D3(0, -1, 0))
        }
        return out
    }

    static func sphere(radius: Double, widthSegments: Int = 12, heightSegments: Int = 8, scaleY: Double = 1.3) -> [Float] {
        var grid: [[(D3, D3)]] = []
        for iy in 0...heightSegments {
            let v = Double(iy) / Double(heightSegments)
            var row: [(D3, D3)] = []
            for ix in 0...widthSegments {
                let u = Double(ix) / Double(widthSegments)
                let n = D3(-cos(u * .pi * 2) * sin(v * .pi), cos(v * .pi), sin(u * .pi * 2) * sin(v * .pi))
                // geometry.scale(1, 1.3, 1): positions stretch, normals take the inverse scale.
                row.append((D3(n.x * radius, n.y * radius * scaleY, n.z * radius), D3(n.x, n.y / scaleY, n.z).normalized()))
            }
            grid.append(row)
        }
        var out: [Float] = []
        func push(_ e: (D3, D3)) { out += [Float(e.0.x), Float(e.0.y), Float(e.0.z), Float(e.1.x), Float(e.1.y), Float(e.1.z)] }
        for iy in 0..<heightSegments {
            for ix in 0..<widthSegments {
                let a = grid[iy][ix + 1], b = grid[iy][ix], c = grid[iy + 1][ix], d = grid[iy + 1][ix + 1]
                if iy != 0 { push(a); push(b); push(d) }
                if iy != heightSegments - 1 { push(b); push(c); push(d) }
            }
        }
        return out
    }
}
