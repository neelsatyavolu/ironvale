// Ported from src/fx/decals.ts (CPU side) at commit a487033; Shaders/FXDecals.metal draws them.
import Darwin

/// Pooled bullet holes: lit quads laid on the surface that was hit.
public final class Decals {
    public static let capacity = 200
    static let holdSeconds = 36.0
    static let fadeSeconds = 4.0
    static let retireAhead = 12
    static let retireSeconds = 0.8
    static let surfaceOffset = 0.004
    static func sizes(_ kind: DecalKind) -> (Double, Double) {
        switch kind {
        case .masonry: (0.11, 0.17)
        case .metal: (0.05, 0.068)
        case .wood: (0.07, 0.095)
        case .soft: (0.14, 0.21)
        }
    }
    static let forward = D3(0, 0, 1)

    /// Per hole: 16 floats of instance matrix.
    public let matrices = FloatStore(count: Decals.capacity * 16)
    /// Per hole: sheet cell, fade start, fade end, metalness.
    public let info = FloatStore(count: Decals.capacity * 4)
    private var ring = RingPool(capacity: Decals.capacity)
    private unowned let env: FxEnv

    init(env: FxEnv) {
        self.env = env
        hideAll()
    }

    /// Lay a hole on a surface. `scale` shrinks it for pellets.
    func add(_ kind: DecalKind, _ point: D3, _ normal: D3, _ scale: Double) {
        let now = env.now
        let random = env.random
        if ring.wrapped {
            // Fade out the holes that are about to be reused instead of letting them pop.
            let retiring = ring.peek(Self.retireAhead) * 4
            if Double(info[retiring + 1]) > now {
                info[retiring + 1] = Float(now)
                info[retiring + 2] = Float(now + Self.retireSeconds)
            }
        }
        let slot = ring.next()
        let (lo, hi) = Self.sizes(kind)
        let size = random.range(lo, hi) * scale
        let facing = Quat.fromUnitVectors(Self.forward, normal) * Quat.axisAngle(Self.forward, random.range(0, .pi * 2))
        M4.compose(point.adding(normal, Self.surfaceOffset), facing, D3(size, size, 1), into: matrices.row(slot, 16))
        let o = slot * 4
        info[o] = Float(kind.rawValue * DecalKind.grid + Int((random.next() * Double(DecalKind.grid)).rounded(.down)))
        info[o + 1] = Float(now + Self.holdSeconds)
        info[o + 2] = Float(now + Self.holdSeconds + Self.fadeSeconds)
        info[o + 3] = kind == .metal ? 1 : 0
    }

    func clear() {
        ring.reset()
        hideAll()
    }

    private func hideAll() {
        for i in 0..<Self.capacity { M4.hidden(into: matrices.row(i, 16)) }
        info.zero()
    }
}
