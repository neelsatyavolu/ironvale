// Ported from src/fx/nearmiss.ts at commit a487033.
import Darwin

/// A fast streak and a thread of disturbed air where a bullet just missed the player.
final class NearMiss {
    static let streakPath = 7.0
    static let streakSpeed = 130.0
    static let streakLength = 2.6
    static let matchDistance = 1.5

    private var lastFrom = D3.zero
    private var lastDirection = D3.zero
    private var lastLength = 0.0
    private unowned let env: FxEnv
    private unowned let tracers: Tracers
    private unowned let lit: ParticlePool

    init(env: FxEnv, tracers: Tracers, lit: ParticlePool) {
        self.env = env
        self.tracers = tracers
        self.lit = lit
    }

    func clear() { lastLength = 0 }

    /// The event carries only a point, so remember incoming fire to recover the bullet's heading.
    func onTrace(from: D3, to: D3, local: Bool) {
        if local { return }
        lastFrom = from
        lastDirection = to - from
        lastLength = lastDirection.length
        if lastLength > 1e-3 { lastDirection = lastDirection * (1 / lastLength) }
    }

    func onNearMiss(point: D3) {
        guard env.live else { return }
        var direction: D3
        if lastLength > 0, distanceToLastTrace(point) < Self.matchDistance {
            direction = lastDirection
        } else {
            // No matching trace: assume the round crossed the view from the side (Object3D.DEFAULT_UP).
            direction = (point - env.camera.position).cross(.up)
            if direction.lengthSq < 1e-6 { direction = D3(1, 0, 0) }
            direction = direction.normalized()
        }
        tracers.add(point.adding(direction, -Self.streakPath * 0.5), direction, Self.streakPath, Self.streakSpeed, Self.streakLength, 0.8)

        let light = env.shade(0.75, 0.75, 0.78, 1)
        let r = env.random
        var s = lit.spawn
        for _ in 0..<4 {
            let along = r.range(-1.2, 1.2)
            s.at(point.adding(direction, along))
            s.velocity(direction * 5)
            s.life = r.range(0.3, 0.5)
            s.size = 0.07
            s.sizeEnd = 0.32
            s.rotation = r.range(0, .pi * 2)
            s.spin = 0
            s.color(light)
            s.a = 0.26
            s.sprite = Sprite.wisp
            s.gravity = 0
            s.drag = 6
            s.stretch = 0
            lit.emit(s)
        }
    }

    private func distanceToLastTrace(_ point: D3) -> Double {
        let along = (point - lastFrom).dot(lastDirection)
        let clamped = min(lastLength, max(0, along))
        return lastFrom.adding(lastDirection, clamped).distance(point)
    }
}
