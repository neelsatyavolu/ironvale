// Ported from src/fx/particles.ts (CPU side) at commit a487033; the vertex animation is
// Shaders/FXParticles.metal.
import Darwin

/// Everything needed to launch one particle (particles.ts ParticleSpawn).
public struct ParticleSpawn: Sendable {
    public var x = 0.0, y = 0.0, z = 0.0
    public var vx = 0.0, vy = 0.0, vz = 0.0
    public var life = 1.0
    public var size = 0.1, sizeEnd = 0.1
    public var rotation = 0.0, spin = 0.0
    public var r = 1.0, g = 1.0, b = 1.0, a = 1.0
    public var sprite = 0
    public var gravity = 0.0
    public var drag = 1.0
    public var stretch = 0.0

    public init() {}

    @inline(__always) mutating func at(_ p: D3) { x = p.x; y = p.y; z = p.z }
    @inline(__always) mutating func velocity(_ v: D3) { vx = v.x; vy = v.y; vz = v.z }
    @inline(__always) mutating func color(_ c: D3, _ scale: Double = 1) { r = c.x * scale; g = c.y * scale; b = c.z * scale }
}

/// Sprites animated in the vertex shader; each is written once, at birth.
public final class ParticlePool {
    /// Floats per particle: origin+birth, velocity+life, shape, colour, physics.
    public static let stride = 20
    static let minDrag = 0.05

    public let capacity: Int
    public let additive: Bool
    public let fadePower: Float
    public let data: FloatStore
    /// The last spawn written; emitters start from it, as the web's shared `spawn` object carries over.
    public private(set) var spawn = ParticleSpawn()
    private var ring: RingPool
    private var dirty = DirtyRange()
    private unowned let env: FxEnv

    init(env: FxEnv, capacity: Int, additive: Bool, fadePower: Float) {
        self.env = env
        self.capacity = capacity
        self.additive = additive
        self.fadePower = fadePower
        ring = RingPool(capacity: capacity)
        data = FloatStore(count: capacity * Self.stride)
    }

    /// Launch `s`. Recycles the oldest particle when the pool is full.
    func emit(_ s: ParticleSpawn) {
        spawn = s
        let slot = ring.next()
        let d = data.row(slot, Self.stride)
        d[0] = Float(s.x); d[1] = Float(s.y); d[2] = Float(s.z); d[3] = Float(env.now)
        d[4] = Float(s.vx); d[5] = Float(s.vy); d[6] = Float(s.vz); d[7] = Float(s.life)
        d[8] = Float(s.size); d[9] = Float(s.sizeEnd); d[10] = Float(s.rotation); d[11] = Float(s.spin)
        d[12] = Float(s.r); d[13] = Float(s.g); d[14] = Float(s.b); d[15] = Float(s.a)
        d[16] = Float(s.gravity); d[17] = Float(max(Self.minDrag, s.drag)); d[18] = Float(s.sprite); d[19] = Float(s.stretch)
        dirty.mark(slot)
    }

    /// The span written since the last call (for an upload; the GPU layer reads the store in place).
    func flush() -> (start: Int, count: Int)? { dirty.take() }

    func clear() {
        data.zero()
        ring.reset()
        _ = dirty.take()
    }
}
