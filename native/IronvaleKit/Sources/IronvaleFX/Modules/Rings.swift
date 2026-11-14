// Ported from src/fx/rings.ts (CPU side) at commit a487033; Shaders/FXRings.metal draws them.
import Darwin

/// Expanding rings lying flat on a surface: rain landing and bullets hitting water.
public final class Rings {
    /// Floats per ring: centre + birth, normal + life, start size, end size, opacity, spare.
    public static let stride = 12
    public static let capacity = 320

    public let data = FloatStore(count: Rings.capacity * Rings.stride)
    private var ring = RingPool(capacity: Rings.capacity)
    private var dirty = DirtyRange()
    private unowned let env: FxEnv

    init(env: FxEnv) { self.env = env }

    /// A ring growing from `size` to `sizeEnd` metres across over `life` seconds, after `delay`.
    func add(_ point: D3, _ normal: D3, _ size: Double, _ sizeEnd: Double, _ life: Double, _ alpha: Double, _ delay: Double) {
        let slot = ring.next()
        let d = data.row(slot, Self.stride)
        d[0] = Float(point.x); d[1] = Float(point.y); d[2] = Float(point.z); d[3] = Float(env.now + delay)
        d[4] = Float(normal.x); d[5] = Float(normal.y); d[6] = Float(normal.z); d[7] = Float(life)
        d[8] = Float(size); d[9] = Float(sizeEnd); d[10] = Float(alpha)
        dirty.mark(slot)
    }

    func flush() -> (start: Int, count: Int)? { dirty.take() }

    func clear() {
        data.zero()
        ring.reset()
        _ = dirty.take()
    }
}
