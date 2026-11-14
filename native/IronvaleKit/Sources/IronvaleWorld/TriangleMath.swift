// Ported at commit 185029e from the code src/world/collision.ts runs on every query:
//   three.js r187 src/math/Ray.js (intersectTriangle, at), Triangle.js (getNormal, getBarycoord,
//   containsPoint, closestPointToPoint), Plane.js, Line3.js;
//   three-mesh-bvh 0.9.18 src/math/ExtendedTriangle.js (closestPointToSegment) and
//   src/math/MathUtilities.js (closestPointLineToLine, closestPointsSegmentToSegment).
// Operation order follows the JavaScript exactly; see Vec3.swift.

/// A line segment (`Line3`).
public struct Segment: Sendable, Equatable {
    public var start: Vec3
    public var end: Vec3

    public init(start: Vec3, end: Vec3) {
        self.start = start
        self.end = end
    }

    /// `Line3.delta`.
    @inline(__always) var delta: Vec3 { end - start }

    /// `Line3.at`: `delta * t + start`.
    @inline(__always) func at(_ t: Double) -> Vec3 { delta.scaled(t) + start }

    /// `Line3.closestPointToPointParameter(point, true)`.
    @inline(__always) func closestParameterClamped(to point: Vec3) -> Double {
        let startP = point - start
        let startEnd = end - start
        let startEnd2 = startEnd.dot(startEnd)
        if startEnd2 == 0 { return 0 }
        let t = startEnd.dot(startP) / startEnd2
        return jsMax(0, jsMin(1, t))
    }

    /// `Line3.closestPointToPoint(point, true, target)`.
    @inline(__always) func closestPointClamped(to point: Vec3) -> Vec3 {
        let t = closestParameterClamped(to: point)
        return delta.scaled(t) + start
    }
}

/// A triangle with the derived plane `ExtendedTriangle.update()` computes.
public struct Triangle3: Sendable {
    public let a: Vec3
    public let b: Vec3
    public let c: Vec3

    public init(_ a: Vec3, _ b: Vec3, _ c: Vec3) {
        self.a = a
        self.b = b
        self.c = c
    }

    /// `Triangle.getNormal`.
    public var normal: Vec3 { Triangle3.normal(a, b, c) }

    static func normal(_ a: Vec3, _ b: Vec3, _ c: Vec3) -> Vec3 {
        let target = (c - b).cross(a - b)
        let lengthSq = target.lengthSq
        if lengthSq > 0 { return target.scaled(1 / lengthSq.squareRoot()) }
        return .zero
    }

    /// `Triangle.containsPoint` through `getBarycoord`.
    func contains(_ point: Vec3) -> Bool {
        let v0 = c - a
        let v1 = b - a
        let v2 = point - a
        let dot00 = v0.dot(v0)
        let dot01 = v0.dot(v1)
        let dot02 = v0.dot(v2)
        let dot11 = v1.dot(v1)
        let dot12 = v1.dot(v2)
        let denom = dot00 * dot11 - dot01 * dot01
        if denom == 0 { return false }
        let invDenom = 1 / denom
        let u = (dot11 * dot02 - dot01 * dot12) * invDenom
        let v = (dot00 * dot12 - dot01 * dot02) * invDenom
        let x = 1 - u - v
        let y = v
        return x >= 0 && y >= 0 && (x + y) <= 1
    }

    /// `Triangle.prototype.closestPointToPoint` (Ericson 5.1.5, three's AB-degenerate guard).
    func closestPoint(to p: Vec3) -> Vec3 {
        let vab = b - a
        let vac = c - a
        let vap = p - a
        let d1 = vab.dot(vap)
        let d2 = vac.dot(vap)
        if d1 <= 0 && d2 <= 0 { return a }

        let vbp = p - b
        let d3 = vab.dot(vbp)
        let d4 = vac.dot(vbp)
        if d3 >= 0 && d4 <= d3 { return b }

        let vc = d1 * d4 - d3 * d2
        if vc <= 0 && d1 >= 0 && d3 <= 0 && d1 - d3 > 0 {
            let v = d1 / (d1 - d3)
            return a.adding(vab, scaledBy: v)
        }

        let vcp = p - c
        let d5 = vab.dot(vcp)
        let d6 = vac.dot(vcp)
        if d6 >= 0 && d5 <= d6 { return c }

        let vb = d5 * d2 - d1 * d6
        if vb <= 0 && d2 >= 0 && d6 <= 0 {
            let w = d2 / (d2 - d6)
            return a.adding(vac, scaledBy: w)
        }

        let va = d3 * d6 - d5 * d4
        if va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0 {
            let vbc = c - b
            let w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
            return b.adding(vbc, scaledBy: w)
        }

        let denom = 1 / (va + vb + vc)
        let v = vb * denom
        let w = vc * denom
        return a.adding(vab, scaledBy: v).adding(vac, scaledBy: w)
    }

    /// `ExtendedTriangle.closestPointToSegment`: distance, closest point on the triangle, and
    /// closest point on the segment. Returns nil only when no candidate compares below infinity
    /// (NaN input), where the JavaScript would leave its targets untouched.
    public func closestPoints(to segment: Segment) -> (distance: Double, onTriangle: Vec3, onSegment: Vec3)? {
        // ExtendedTriangle.update(): plane from the normal and a.
        let n = normal
        let constant = -a.dot(n)
        let start = segment.start
        let end = segment.end
        let startDist = n.dot(start) + constant
        let endDist = n.dot(end) + constant
        if startDist * endDist < 0, let hit = Triangle3.intersectPlane(normal: n, constant: constant, segment), contains(hit) {
            return (0, hit, hit)
        }

        var closestSq = Double.infinity
        var best: (Vec3, Vec3)?
        func checkEdge(_ from: Vec3, _ to: Vec3) {
            let (p1, p2) = closestPointsSegmentToSegment(Segment(start: from, end: to), segment)
            let distSq = p1.distanceToSquared(p2)
            if distSq < closestSq {
                closestSq = distSq
                best = (p1, p2)
            }
        }
        checkEdge(a, b)
        checkEdge(b, c)
        checkEdge(c, a)

        let toStart = closestPoint(to: start)
        var distSq = start.distanceToSquared(toStart)
        if distSq < closestSq {
            closestSq = distSq
            best = (toStart, start)
        }
        let toEnd = closestPoint(to: end)
        distSq = end.distanceToSquared(toEnd)
        if distSq < closestSq {
            closestSq = distSq
            best = (toEnd, end)
        }
        guard let best else { return nil }
        return (closestSq.squareRoot(), best.0, best.1)
    }

    /// `Plane.intersectLine(line, target, true)`.
    static func intersectPlane(normal n: Vec3, constant: Double, _ line: Segment) -> Vec3? {
        let direction = line.delta
        let denominator = n.dot(direction)
        if denominator == 0 {
            if n.dot(line.start) + constant == 0 { return line.start }
            return nil
        }
        let t = -(line.start.dot(n) + constant) / denominator
        if t < 0 || t > 1 { return nil }
        return line.start.adding(direction, scaledBy: t)
    }
}

/// `closestPointLineToLine` (MathGeoLib), returning the two line parameters.
@inline(__always) func closestPointLineToLine(_ l1: Segment, _ l2: Segment) -> (Double, Double) {
    let v02 = l1.start - l2.start
    let v10 = l1.end - l1.start
    let v32 = l2.end - l2.start
    let d0232 = v02.dot(v32)
    let d3210 = v32.dot(v10)
    let d3232 = v32.dot(v32)
    let d0210 = v02.dot(v10)
    let d1010 = v10.dot(v10)
    let denom = d1010 * d3232 - d3210 * d3210
    let d: Double = denom != 0 ? (d0232 * d3210 - d0210 * d3232) / denom : 0
    let d2 = (d0232 + d * d3210) / d3232
    return (d, d2)
}

/// `closestPointsSegmentToSegment`: closest point on `l1`, closest point on `l2`.
func closestPointsSegmentToSegment(_ l1: Segment, _ l2: Segment) -> (Vec3, Vec3) {
    let (d, d2) = closestPointLineToLine(l1, l2)
    if d >= 0 && d <= 1 && d2 >= 0 && d2 <= 1 {
        return (l1.at(d), l2.at(d2))
    } else if d >= 0 && d <= 1 {
        let target2 = d2 < 0 ? l2.at(0) : l2.at(1)
        return (l1.closestPointClamped(to: target2), target2)
    } else if d2 >= 0 && d2 <= 1 {
        let target1 = d < 0 ? l1.at(0) : l1.at(1)
        return (target1, l2.closestPointClamped(to: target1))
    } else {
        let p = d < 0 ? l1.start : l1.end
        let p2 = d2 < 0 ? l2.start : l2.end
        let closestPoint = l1.closestPointClamped(to: p2)
        let closestPoint2 = l2.closestPointClamped(to: p)
        if closestPoint.distanceToSquared(p2) <= closestPoint2.distanceToSquared(p) {
            return (closestPoint, p2)
        }
        return (p, closestPoint2)
    }
}

/// A ray (`Ray`); `direction` is expected to be unit length, as collision.ts makes it.
public struct Ray3: Sendable {
    public var origin: Vec3
    public var direction: Vec3

    public init(origin: Vec3, direction: Vec3) {
        self.origin = origin
        self.direction = direction
    }

    @inline(__always) func at(_ t: Double) -> Vec3 { origin.adding(direction, scaledBy: t) }

    /// `Ray.intersectTriangle(a, b, c, false)`: watertight, double-sided.
    func intersectTriangle(_ a: Vec3, _ b: Vec3, _ c: Vec3) -> Vec3? {
        let dx = direction.x, dy = direction.y, dz = direction.z
        let aox = a.x - origin.x, aoy = a.y - origin.y, aoz = a.z - origin.z
        let box = b.x - origin.x, boy = b.y - origin.y, boz = b.z - origin.z
        let cox = c.x - origin.x, coy = c.y - origin.y, coz = c.z - origin.z
        let adx = abs(dx), ady = abs(dy), adz = abs(dz)

        let dkx, dky, dkz: Double
        let akx, aky, akz, bkx, bky, bkz, ckx, cky, ckz: Double
        if adx >= ady && adx >= adz {
            dkz = dx; akz = aox; bkz = box; ckz = cox
            if dx >= 0 {
                dkx = dy; dky = dz
                akx = aoy; aky = aoz; bkx = boy; bky = boz; ckx = coy; cky = coz
            } else {
                dkx = dz; dky = dy
                akx = aoz; aky = aoy; bkx = boz; bky = boy; ckx = coz; cky = coy
            }
        } else if ady >= adz {
            dkz = dy; akz = aoy; bkz = boy; ckz = coy
            if dy >= 0 {
                dkx = dz; dky = dx
                akx = aoz; aky = aox; bkx = boz; bky = box; ckx = coz; cky = cox
            } else {
                dkx = dx; dky = dz
                akx = aox; aky = aoz; bkx = box; bky = boz; ckx = cox; cky = coz
            }
        } else {
            dkz = dz; akz = aoz; bkz = boz; ckz = coz
            if dz >= 0 {
                dkx = dx; dky = dy
                akx = aox; aky = aoy; bkx = box; bky = boy; ckx = cox; cky = coy
            } else {
                dkx = dy; dky = dx
                akx = aoy; aky = aox; bkx = boy; bky = box; ckx = coy; cky = cox
            }
        }
        if dkz == 0 { return nil }

        let sx = dkx / dkz, sy = dky / dkz, sz = 1 / dkz
        let ax = akx - sx * akz, ay = aky - sy * akz
        let bx = bkx - sx * bkz, by = bky - sy * bkz
        let cx = ckx - sx * ckz, cy = cky - sy * ckz
        let u = cx * by - cy * bx
        let v = ax * cy - ay * cx
        let w = bx * ay - by * ax
        if (u < 0 || v < 0 || w < 0) && (u > 0 || v > 0 || w > 0) { return nil }
        let det = u + v + w
        if det == 0 { return nil }
        let tScaled = sz * (u * akz + v * bkz + w * ckz)
        if det > 0 ? tScaled < 0 : tScaled > 0 { return nil }
        return at(tScaled / det)
    }
}
