// Ported from src/characters/reactions.ts at commit f14381f.
import Foundation

public enum HitZone: String, Sendable { case head, torso, limb }

public struct Flinch: Sendable {
    public var headPitch = 0.0
    public var headYaw = 0.0
    public var torsoPitch = 0.0
    public var torsoYaw = 0.0
    public var hipsPitch = 0.0
    public var hipsRoll = 0.0
    /// Radians the muzzle drops while the shooter recovers.
    public var gunDip = 0.0
    private var time = Double.infinity
    private var zone = HitZone.torso
    private var side = 1.0
    private let rise: Double

    public init(tables: CharacterTables = .shared) { rise = tables.flinchRise }

    /// 0 at the hit, 1 at the peak, then an exponential tail.
    public static func envelope(_ time: Double, rise: Double = CharacterTables.shared.flinchRise) -> Double {
        if time <= 0 || !time.isFinite { return 0 }
        let t = time / rise
        return t * exp(1 - t)
    }

    public var active: Bool { time < rise * 9 }

    mutating func pose(_ zone: HitZone, _ side: Double, _ strength: Double) {
        headPitch = 0; headYaw = 0; torsoPitch = 0; torsoYaw = 0; hipsPitch = 0; hipsRoll = 0
        gunDip = 0.1 * strength
        switch zone {
        case .head:
            headPitch = 0.5 * strength
            headYaw = 0.3 * side * strength
            torsoPitch = 0.1 * strength
        case .torso:
            torsoPitch = 0.2 * strength
            torsoYaw = 0.28 * side * strength
            headPitch = -0.2 * strength
            hipsPitch = -0.06 * strength
        case .limb:
            hipsRoll = 0.12 * side * strength
            hipsPitch = -0.1 * strength
            torsoYaw = 0.12 * side * strength
            headPitch = -0.1 * strength
        }
    }

    public mutating func hit(_ zone: HitZone) {
        self.zone = zone
        time = 0
        side = -side
    }

    public mutating func update(_ dt: Double) {
        if !active {
            if gunDip != 0 { pose(zone, side, 0) }
            return
        }
        time += dt
        pose(zone, side, Self.envelope(time, rise: rise))
    }

    public mutating func reset() {
        time = .infinity
        pose(zone, side, 0)
    }
}

/// Repeating kick while the trigger is held.
public struct Recoil: Sendable {
    public var value = 0.0
    public var side = 0.0
    private var untilShot = 0.0
    private var shots = 0
    private let interval: Double
    private let decay: Double

    public init(tables: CharacterTables = .shared) {
        interval = tables.shotInterval
        decay = tables.recoilDecay
    }

    public mutating func update(_ dt: Double, firing: Bool) {
        value *= exp(-dt * decay)
        if !firing {
            untilShot = 0
            return
        }
        untilShot -= dt
        if untilShot > 0 { return }
        untilShot += interval
        if untilShot <= 0 { untilShot = interval }
        value = 1
        shots += 1
        side = sin(Double(shots) * 12.9898) * 0.9
    }

    public mutating func reset() {
        value = 0
        untilShot = 0
    }
}
