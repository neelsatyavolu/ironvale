// Ported from src/fx/grenade-arc.ts at commit a487033: the predicted path of the grenade being
// aimed, a ribbon facing the eye, and a ring where it will go off. Shaders/FXGrenadeArc.metal draws them.
import Darwin
import IronvaleSim
import IronvaleWorld

public final class GrenadeArc {
    static let skipPoints = 2
    static let halfWidthPerMetre = 0.0011
    static let minHalfWidth = 0.0025
    static let markerRadiusPerMetre = 0.016
    static let minMarkerRadius = 0.1
    /// ARC_COLOR 0xf7f5ef at 0.7 and MARKER_COLOR 0x4c8dff at 0.95.
    public static let arcColor = linearFromHex(0xf7f5ef), arcOpacity = 0.7
    public static let markerColor = linearFromHex(0x4c8dff), markerOpacity = 0.95

    public let capacity: Int
    /// Ribbon vertices: two per path point (xyz each), the first `used` points after the skipped ones.
    public let positions: FloatStore
    public private(set) var count = 0
    public private(set) var ribbonVisible = false
    public private(set) var markerVisible = false
    public private(set) var marker = D3.zero
    public private(set) var markerScale = 1.0
    /// Ribbon index count (the geometry's draw range).
    public private(set) var drawCount = 0
    private var points: [D3]
    private var lastOrigin = D3(.infinity, 0, 0)
    private var lastVelocity = D3.zero
    private var lastEye = D3.zero
    private let math: GrenadeMath

    init(math: GrenadeMath) {
        self.math = math
        capacity = math.g.maxArcPoints
        positions = FloatStore(count: capacity * 2 * 3)
        points = [D3](repeating: .zero, count: capacity)
    }

    func hide() {
        ribbonVisible = false
        markerVisible = false
    }

    /// Draw the path of a throw from `origin` at `velocity`. Call every frame while aiming.
    func show(origin: D3, velocity: D3, camera: FXCamera, world: CollisionWorld?) {
        let eye = camera.position
        let moved = origin != lastOrigin || velocity != lastVelocity
        if moved {
            lastOrigin = origin
            lastVelocity = velocity
            count = predict(origin, velocity, world)
        }
        if moved || eye != lastEye {
            lastEye = eye
            build(eye)
        }
        ribbonVisible = count - Self.skipPoints >= 2
        markerVisible = true
    }

    /// grenade-math.ts predictArc, into the fixed point buffer (float32, as the web's Float32Array).
    private func predict(_ origin: D3, _ velocity: D3, _ world: CollisionWorld?) -> Int {
        let g = math.g
        var body = GrenadeBody(position: origin.vec3, velocity: velocity.vec3)
        var n = 0
        var time = 0.0
        while n < capacity {
            points[n] = D3(Double(Float(body.position.x)), Double(Float(body.position.y)), Double(Float(body.position.z)))
            n += 1
            if time >= g.fuse || body.resting { break }
            if let world { math.step(&body, world: world, dt: g.step) } else {
                body.velocity.y -= g.gravity * g.step
                body.position = body.position.adding(body.velocity, scaledBy: g.step)
            }
            time += g.step
        }
        return n
    }

    private func build(_ eye: D3) {
        marker = points[count - 1]
        markerScale = max(Self.minMarkerRadius, marker.distance(eye) * Self.markerRadiusPerMetre)
        let used = count - Self.skipPoints
        if used < 2 { return }
        for i in 0..<used {
            let point = points[i + Self.skipPoints]
            let before = points[max(Self.skipPoints, i + Self.skipPoints - 1)]
            let after = points[min(count - 1, i + Self.skipPoints + 1)]
            let tangent = after - before
            var side = point - eye
            let half = max(Self.minHalfWidth, side.length * Self.halfWidthPerMetre)
            side = side.cross(tangent)
            let length = side.length
            // Looking straight along the path there is no sideways direction; any will do.
            side = length < 1e-6 ? D3(half, 0, 0) : side * (half / length)
            let o = i * 6
            positions[o] = Float(point.x - side.x); positions[o + 1] = Float(point.y - side.y); positions[o + 2] = Float(point.z - side.z)
            positions[o + 3] = Float(point.x + side.x); positions[o + 4] = Float(point.y + side.y); positions[o + 5] = Float(point.z + side.z)
        }
        drawCount = (used - 1) * 6
    }
}
