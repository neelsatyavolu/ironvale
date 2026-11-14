// Ported from src/ai/perception.ts at commit cbe0add.
import Foundation

public enum Vision {
    static let deg = Double.pi / 180
    public static let halfAngleCalm = 55 * deg
    public static let halfAngleAlert = 80 * deg
    public static let proximity = 2.2
    public static let fogVisibility = 0.9
    public static let crouchFactor = 0.75
    public static let stillFactor = 0.85
    public static let sprintFactor = 1.15
    public static let stillSpeed = 0.5
    public static let sprintSpeed = 5.5
}

/// Sight range against one target: cut by fog, by the target crouching and by it standing still.
public func effectiveVisionRange(_ base: Double, fogDensity: Double, targetCrouching: Bool, targetSpeed: Double) -> Double {
    var range = min(base, Vision.fogVisibility / max(fogDensity, 1e-4))
    if targetCrouching { range *= Vision.crouchFactor }
    if targetSpeed < Vision.stillSpeed { range *= Vision.stillFactor } else if targetSpeed > Vision.sprintSpeed { range *= Vision.sprintFactor }
    return range
}

/// true when the target is within `range` and inside the cone around the facing (yaw 0 looks down -Z).
public func inVisionCone(eye: (Double, Double, Double), yaw: Double, target: (Double, Double, Double), halfAngle: Double, range: Double) -> Bool {
    let dx = target.0 - eye.0
    let dy = target.1 - eye.1
    let dz = target.2 - eye.2
    let distanceSq = dx * dx + dy * dy + dz * dz
    if distanceSq > range * range { return false }
    if distanceSq < 1e-6 { return true }
    let along = -sin(yaw) * dx - cos(yaw) * dz
    return along >= cos(halfAngle) * distanceSq.squareRoot()
}

public enum NoiseKind: String, Sendable {
    case shot, footstep, impact, nearMiss

    var urgency: Int {
        switch self {
        case .footstep: 0
        case .shot: 1
        case .impact: 2
        case .nearMiss: 3
        }
    }
}

/// How far a noise carries.
public func hearingRadius(_ kind: NoiseKind, loudness: Double, scale: Double) -> Double {
    switch kind {
    case .shot: 85 * loudness * scale
    case .footstep: 16 * scale
    case .impact: 6 * scale
    case .nearMiss: 1.8
    }
}

private let reacquireFraction = 0.4
private let glimpseDecay = 0.5

/// Reaction delay and memory for one soldier.
public struct Awareness: Sendable {
    public private(set) var visibleTime = 0.0
    public private(set) var alerted = false
    public private(set) var visible = false
    public private(set) var sinceSeen = Double.infinity
    private var threshold = Double.infinity

    public init() {}

    public mutating func update(_ dt: Double, visible: Bool, reactionTime: Double, memorySeconds: Double) {
        self.visible = visible
        threshold = alerted ? reactionTime * reacquireFraction : reactionTime
        if visible {
            visibleTime = min(reactionTime, visibleTime + dt)
            if visibleTime >= threshold - 1e-9 {
                alerted = true
                sinceSeen = 0
            }
            return
        }
        visibleTime = max(0, visibleTime - dt * glimpseDecay)
        sinceSeen += dt
        if alerted, sinceSeen > memorySeconds { forget() }
    }

    public var canEngage: Bool { alerted && visible && visibleTime >= threshold - 1e-9 }

    public mutating func alert() {
        alerted = true
        sinceSeen = 0
    }

    public mutating func forget() {
        alerted = false
        visible = false
        visibleTime = 0
        sinceSeen = .infinity
    }
}
