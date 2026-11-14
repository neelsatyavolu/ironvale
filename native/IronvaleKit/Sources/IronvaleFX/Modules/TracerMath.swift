// Ported from src/fx/tracer-math.ts at commit a487033.
import Darwin

public enum TracerMath {
    /// Fastest a tracer is drawn travelling, in m/s.
    public static let maxVisibleSpeed = 340.0
    public static let minVisibleSpeed = 55.0
    static let minTravelSeconds = 0.075
    static let streakSeconds = 0.018
    static let minStreak = 0.8
    static let maxStreak = 7.0
    static let maxPathFraction = 0.6
    static let localTracerEvery = 3
    static let pelletTracerEvery = 4

    /// Speed the streak is drawn at for a shot that travels `distance` metres.
    public static func visibleSpeed(_ muzzleVelocity: Double, _ distance: Double) -> Double {
        min(muzzleVelocity, maxVisibleSpeed, max(minVisibleSpeed, distance / minTravelSeconds))
    }

    /// Length of the streak in metres.
    public static func length(_ speed: Double, _ distance: Double) -> Double {
        let streak = min(maxStreak, max(minStreak, speed * streakSeconds))
        return min(streak, distance * maxPathFraction)
    }

    /// Whether the local player's `index`-th projectile shows a tracer. Bots always show theirs.
    public static func showLocal(_ index: Int, _ pellets: Int) -> Bool {
        pellets > 1 ? index % pelletTracerEvery == 1 : index % localTracerEvery == 0
    }
}
