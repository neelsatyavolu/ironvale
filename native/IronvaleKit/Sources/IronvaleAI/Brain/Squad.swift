// Ported from src/ai/blackboard.ts at commit cbe0add.
import IronvaleCore
import IronvaleWorld

public enum BotState: String, Sendable, CaseIterable {
    case patrol, investigate, cover, strafe, push, flank, suppress, fallback, hold, dead
}

public enum CalloutKind: String, Sendable, CaseIterable { case spotted, reloading, hurt, death }

public protocol SquadMember {
    var alive: Bool { get }
    var state: BotState { get }
    var coverNode: Int { get }
    var firing: Bool { get }
}

private let contactBreak = 6.0

/// What the squad knows together (`Squad` in blackboard.ts).
public final class Squad {
    public private(set) var lastKnown = Vec3.zero
    public private(set) var spotterPosition = Vec3.zero
    public private(set) var spotterId = -1
    public private(set) var contactTime = -Double.infinity
    public private(set) var contactStart = -Double.infinity
    public private(set) var alive = 0
    public private(set) var engaging = 0
    public private(set) var pushing = 0
    public private(set) var flanking = 0
    public internal(set) var firing = 0
    public private(set) var takenCover: [Int] = []
    private var lastCallout: [CalloutKind: Double] = [:]

    public init() {}

    public func tally(_ members: [some SquadMember]) {
        alive = 0
        engaging = 0
        pushing = 0
        flanking = 0
        firing = 0
        takenCover = members.map { $0.alive ? $0.coverNode : -1 }
        for member in members where member.alive {
            alive += 1
            if member.firing { firing += 1 }
            switch member.state {
            case .push: pushing += 1
            case .flank: flanking += 1
            case .cover, .strafe, .hold, .suppress: engaging += 1
            default: break
            }
        }
    }

    public func report(botId: Int, botPosition: Vec3, enemyPosition: Vec3, time: Double) {
        if time - contactTime > contactBreak { contactStart = time }
        contactTime = time
        spotterId = botId
        spotterPosition = botPosition
        lastKnown = enemyPosition
    }

    public func hasContact(_ time: Double, maxAge: Double) -> Bool { time - contactTime <= maxAge }

    public func canPush(_ pushFraction: Double) -> Bool {
        let cap = min(max(1, Int(JS.round(Double(alive) * pushFraction))), max(1, alive - 1))
        return pushing < cap
    }

    public func canFlank() -> Bool { engaging >= 2 && flanking < max(1, alive / 4) }

    public func tryCallout(_ kind: CalloutKind, time: Double) -> Bool {
        let gap: Double = switch kind {
        case .spotted: 4
        case .reloading, .hurt: 3
        case .death: 0
        }
        if time - (lastCallout[kind] ?? -.infinity) < gap { return false }
        lastCallout[kind] = time
        return true
    }

    public func reset() {
        contactTime = -.infinity
        contactStart = -.infinity
        spotterId = -1
        alive = 0
        engaging = 0
        pushing = 0
        flanking = 0
        firing = 0
        takenCover = []
        lastCallout = [:]
    }
}
