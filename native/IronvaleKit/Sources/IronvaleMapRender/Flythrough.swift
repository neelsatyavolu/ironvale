// A fixed 60 s camera loop through Railyard's lanes for the M3 frame-time check. Waypoints are
// feet positions taken from scripts/dev/map-railyard-shot.mjs VIEWS; the camera follows a closed
// Catmull-Rom spline at eye height, looking along the path with a slight downward pitch.
import IronvaleRender
import simd

public struct Flythrough: Sendable {
    public static let railyard: [SIMD2<Float>] = [
        SIMD2(-3, 45.5), SIMD2(4, 30), SIMD2(4, 6), SIMD2(4, -24), SIMD2(-14, -42), SIMD2(-34, -38),
        SIMD2(-30, -2), SIMD2(-30, 15), SIMD2(-15.5, 33), SIMD2(12.2, 22), SIMD2(27, 44), SIMD2(34, 30),
        SIMD2(26.6, -27), SIMD2(12.2, -19), SIMD2(-7, 13),
    ]

    public let waypoints: [SIMD2<Float>]
    public let duration: Double

    public init(waypoints: [SIMD2<Float>] = Self.railyard, duration: Double = 60) {
        precondition(waypoints.count >= 4, "a closed Catmull-Rom loop needs four waypoints")
        self.waypoints = waypoints
        self.duration = duration
    }

    private func point(_ u: Float) -> SIMD2<Float> {
        let n = waypoints.count
        let scaled = u * Float(n)
        let i = Int(scaled.rounded(.down))
        let t = scaled - Float(i)
        func p(_ k: Int) -> SIMD2<Float> { waypoints[((i + k) % n + n) % n] }
        let (p0, p1, p2, p3) = (p(-1), p(0), p(1), p(2))
        let t2 = t * t, t3 = t2 * t
        return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
    }

    /// Pose at `time` seconds; the loop repeats every `duration`.
    public func pose(at time: Double) -> CameraPose {
        let u = Float((time / duration).truncatingRemainder(dividingBy: 1))
        let here = point(u)
        let ahead = point((u + 0.004).truncatingRemainder(dividingBy: 1))
        let d = ahead - here
        // Yaw 0 looks down -Z; Ry(yaw) turns -Z to (-sin yaw, 0, -cos yaw).
        let yaw = atan2(-d.x, -d.y)
        return CameraPose(eye: SIMD3(here.x, CameraPose.standEye, here.y), yaw: yaw, pitch: -0.03)
    }
}
