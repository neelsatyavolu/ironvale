// Ported from src/ai/botweapon.ts at commit cbe0add. The overshoot carry (`cooldown += interval`,
// floor `-dt`) keeps the average rate of fire at the weapon's, which a web guest's WeaponGate checks.
import IronvaleContract

public struct BurstTiming: Sendable, Equatable {
    public let burstMin, burstMax: Int
    public let pauseMin, pauseMax: Double
    public init(burstMin: Int, burstMax: Int, pauseMin: Double, pauseMax: Double) {
        self.burstMin = burstMin
        self.burstMax = burstMax
        self.pauseMin = pauseMin
        self.pauseMax = pauseMax
    }
}

private let epsilon = 1e-6

/// A bot's gun: rate of fire, bursts with pauses, a magazine and reloads. Pure timing.
public struct BotWeapon {
    public let def: WeaponDef
    public private(set) var magazine: Int
    public private(set) var reloading = false
    public private(set) var reloadStarted = false
    public private(set) var reloadFinished = false
    private let timing: BurstTiming
    private let random: () -> Double
    private var cooldown = 0.0
    private var pause = 0.0
    private var burstLeft = 0
    private var reloadLeft = 0.0
    private var reloadTotal = 0.0

    public init(def: WeaponDef, timing: BurstTiming, random: @escaping () -> Double) {
        self.def = def
        self.timing = timing
        self.random = random
        magazine = def.magazineSize
    }

    public var reloadDuration: Double { reloading ? reloadTotal : def.reloadTime }
    public var pausing: Bool { pause > 0 }

    /// Advance by `dt`; returns true when one round leaves the barrel in this update.
    public mutating func update(_ dt: Double, trigger: Bool) -> Bool {
        reloadStarted = false
        reloadFinished = false
        if reloading {
            reloadLeft -= dt
            if reloadLeft <= epsilon {
                reloading = false
                reloadFinished = true
                magazine = def.magazineSize
                cooldown = 0
                pause = 0
            }
            return false
        }
        if magazine <= 0 {
            startReload()
            return false
        }
        var fired = false
        if !trigger {
            burstLeft = 0
        } else if pause <= epsilon, cooldown <= epsilon {
            let interval = 60 / def.roundsPerMinute
            if burstLeft <= 0 {
                burstLeft = timing.burstMin + Int((random() * Double(timing.burstMax - timing.burstMin + 1)).rounded(.down))
                cooldown = interval
            } else {
                cooldown += interval
            }
            magazine -= 1
            burstLeft -= 1
            fired = true
            if burstLeft <= 0 { pause = timing.pauseMin + random() * (timing.pauseMax - timing.pauseMin) }
        }
        pause = max(0, pause - dt)
        cooldown = max(-dt, cooldown - dt)
        return fired
    }

    public mutating func startReload() {
        if reloading || magazine >= def.magazineSize { return }
        reloadTotal = reloadDuration
        reloadLeft = reloadTotal
        reloading = true
        reloadStarted = true
        burstLeft = 0
    }
}
