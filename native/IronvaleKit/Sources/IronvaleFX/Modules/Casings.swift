// Ported from src/fx/casings.ts (CPU side) at commit a487033; Shaders/FXCasings.metal draws them.
import Darwin
import IronvaleWorld

/// Spent casings: instanced cylinders that tumble, bounce and lie on the ground for a while.
public final class Casings {
    public static let capacity = 96
    static let minLive = 16
    /// Radius and length in metres.
    static func size(_ kind: CasingKind) -> (Double, Double) {
        switch kind {
        case .pistol: (0.0055, 0.021)
        case .rifle: (0.0054, 0.05)
        case .shotgun: (0.011, 0.074)
        }
    }
    static let restMinSeconds = 10.0
    static let restMaxSeconds = 20.0
    static let shrinkSeconds = 0.6
    static let maxFlightSeconds = 6.0
    static let spinKeptOnBounce = 0.55
    static let axisY = D3(0, 1, 0)

    struct Casing {
        var body = CasingBody()
        var orientation = Quat.identity
        var spinAxis = D3(1, 0, 0)
        var spinRate = 0.0
        var kind = CasingKind.rifle
        var active = false
        var birth = 0.0
        var fadeAt = 0.0
    }

    /// Per casing: 16 floats of instance matrix.
    public let matrices = FloatStore(count: Casings.capacity * 16)
    /// 1 for a shotgun hull, 0 for brass.
    public let hull = FloatStore(count: Casings.capacity)
    private var casings = [Casing](repeating: Casing(), count: Casings.capacity)
    private var cursor = 0
    private var live = 0
    /// casingLanded: a casing touched the ground for the first time (audio listens).
    var onLanded: ((CasingKind, D3, Surface) -> Void)?
    private unowned let env: FxEnv

    init(env: FxEnv) {
        self.env = env
        for i in 0..<Self.capacity { M4.hidden(into: matrices.row(i, 16)) }
    }

    func update(_ dt: Double) {
        if live == 0 { return }
        let now = env.now
        for i in 0..<Self.capacity where casings[i].active {
            let radius = Self.size(casings[i].kind).0
            if !casings[i].body.resting {
                let result = CasingPhysics.step(&casings[i].body, dt, world: env.world, radius: radius, tuning: .standard)
                casings[i].orientation = Quat.axisAngle(casings[i].spinAxis, casings[i].spinRate * dt) * casings[i].orientation
                if result != .flying { onContact(i, firstGroundContact: result == .landed) }
                if casings[i].body.resting { settle(i, now) }
                else if now - casings[i].birth > Self.maxFlightSeconds { retire(i) }
                write(i, 1)
            } else if now >= casings[i].fadeAt {
                let remaining = 1 - (now - casings[i].fadeAt) / Self.shrinkSeconds
                if remaining <= 0 { retire(i) }
                write(i, max(0, remaining))
            }
        }
    }

    func onEjected(kind: CasingKind, position: D3, velocity: D3) {
        guard env.live else { return }
        // Lower particle settings keep fewer casings around; the oldest is reused first.
        let limit = max(Self.minLive, Int(jsRound(Double(Self.capacity) * env.particleDensity)))
        let slot = cursor % limit
        cursor = (slot + 1) % limit
        if !casings[slot].active { live += 1 }
        let r = env.random
        var c = casings[slot]
        c.active = true
        c.kind = kind
        c.birth = env.now
        c.body.position = position
        c.body.velocity = velocity
        c.body.bounces = 0
        c.body.landed = false
        c.body.resting = false
        c.body.surface = nil
        c.spinAxis = D3(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalized()
        c.spinRate = r.range(14, 34)
        c.orientation = Quat.axisAngle(c.spinAxis, r.range(0, .pi * 2))
        casings[slot] = c
        hull[slot] = kind == .shotgun ? 1 : 0
        write(slot, 1)
    }

    /// A contact knocks the tumble onto a new axis and takes some of it away.
    private func onContact(_ i: Int, firstGroundContact: Bool) {
        let r = env.random
        casings[i].spinAxis = D3(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalized()
        casings[i].spinRate *= Self.spinKeptOnBounce
        if !firstGroundContact { return }
        onLanded?(casings[i].kind, casings[i].body.position, casings[i].body.surface ?? .concrete)
    }

    /// Lay the casing on its side where it stopped.
    private func settle(_ i: Int, _ now: Double) {
        var axis = Self.axisY.applying(casings[i].orientation)
        axis.y = 0
        if axis.lengthSq < 1e-4 { axis = D3(1, 0, 0) }
        casings[i].orientation = Quat.fromUnitVectors(Self.axisY, axis.normalized())
        casings[i].spinRate = 0
        casings[i].fadeAt = now + env.random.range(Self.restMinSeconds, Self.restMaxSeconds)
    }

    private func retire(_ i: Int) {
        guard casings[i].active else { return }
        casings[i].active = false
        live -= 1
    }

    private func write(_ i: Int, _ shrink: Double) {
        let (radius, length) = Self.size(casings[i].kind)
        let visible = casings[i].active ? shrink : 0
        M4.compose(casings[i].body.position, casings[i].orientation, D3(radius * visible, length * visible, radius * visible),
                   into: matrices.row(i, 16))
    }

    func clear() {
        for i in 0..<Self.capacity {
            casings[i].active = false
            M4.hidden(into: matrices.row(i, 16))
        }
        live = 0
        cursor = 0
    }
}

/// JS Math.round: halves toward +infinity.
@inline(__always) func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }
