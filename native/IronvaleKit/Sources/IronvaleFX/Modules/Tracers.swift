// Ported from src/fx/tracers.ts (CPU side) at commit a487033; Shaders/FXTracers.metal flies them.
import Darwin

/// Bullet streaks. Each is written once and flown by the vertex shader.
public final class Tracers {
    /// Floats per tracer: start + birth, direction + path length, speed, streak length, width, brightness.
    public static let stride = 12
    public static let capacity = 96
    static let width = 0.03
    static let localStartAhead = 2.2
    static let minPath = 1.5

    public let data = FloatStore(count: Tracers.capacity * Tracers.stride)
    private var ring = RingPool(capacity: Tracers.capacity)
    private var dirty = DirtyRange()
    private var localRounds = 0
    private unowned let env: FxEnv

    init(env: FxEnv) { self.env = env }

    /// Fly a streak from `from` along unit `direction` for `distance` metres.
    func add(_ from: D3, _ direction: D3, _ distance: Double, _ speed: Double, _ streak: Double, _ brightness: Double) {
        let slot = ring.next()
        let d = data.row(slot, Self.stride)
        d[0] = Float(from.x); d[1] = Float(from.y); d[2] = Float(from.z); d[3] = Float(env.now)
        d[4] = Float(direction.x); d[5] = Float(direction.y); d[6] = Float(direction.z); d[7] = Float(distance)
        d[8] = Float(speed); d[9] = Float(streak); d[10] = Float(Self.width); d[11] = Float(brightness)
        dirty.mark(slot)
    }

    func onTrace(weapon: FXWeapon, from: D3, to: D3, local: Bool) {
        guard env.live else { return }
        if local {
            let index = localRounds
            localRounds += 1
            if !TracerMath.showLocal(index, weapon.pellets) { return }
        }
        var direction = to - from
        var distance = direction.length
        if distance < Self.minPath { return }
        direction = direction * (1 / distance)
        var start = from
        if local {
            let skip = min(Self.localStartAhead, distance * 0.3)
            start = start.adding(direction, skip)
            distance -= skip
        }
        let speed = TracerMath.visibleSpeed(weapon.muzzleVelocity, distance)
        add(start, direction, distance, speed, TracerMath.length(speed, distance), local ? 0.75 : 1)
    }

    func flush() -> (start: Int, count: Int)? { dirty.take() }

    func clear() {
        data.zero()
        ring.reset()
        localRounds = 0
        _ = dirty.take()
    }
}
