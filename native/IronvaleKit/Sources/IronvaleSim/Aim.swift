// Ported from src/weapons/aim.ts (AimState) and src/weapons/switching.ts at commit 185029e.
// BreathSway and the aim-assist/steering modules are not part of M4 (no enemies to assist against).
public struct AimInput: Sendable {
    public var held = false
    public var pressed = false
    /// `settings.controls.adsToggle`: press to aim, press again to stop.
    public var toggle = false
    /// false while the gun cannot be aimed (reloading, switching, working a bolt).
    public var allowed = false
    /// Seconds to raise the sights.
    public var aimTime = 0.2

    public init(held: Bool = false, pressed: Bool = false, toggle: Bool = false, allowed: Bool = false, aimTime: Double = 0.2) {
        self.held = held
        self.pressed = pressed
        self.toggle = toggle
        self.allowed = allowed
        self.aimTime = aimTime
    }
}

public final class AimState {
    /// 0 at the hip, 1 fully aimed. Moves linearly.
    public private(set) var blend = 0.0
    /// true while the sights are going up or are up.
    public private(set) var aiming = false
    /// true while the player is asking to aim, whether or not it is allowed right now.
    public private(set) var wanted = false
    private var latched = false
    private let lowerSpeedup: Double

    public init(lowerSpeedup: Double = SimData.shared.constants.aim.LOWER_SPEEDUP) {
        self.lowerSpeedup = lowerSpeedup
    }

    /// Advance one frame. Returns true when `aiming` changed.
    @discardableResult
    public func update(_ dt: Double, _ input: AimInput) -> Bool {
        if input.toggle {
            if input.pressed { latched.toggle() }
        } else {
            latched = false
        }
        wanted = input.toggle ? latched : input.held
        let want = wanted && input.allowed
        let changed = want != aiming
        aiming = want
        let rate = dt / max(0.01, input.aimTime)
        blend = want ? min(1, blend + rate) : max(0, blend - rate * lowerSpeedup)
        return changed
    }

    /// Forget a toggled aim (weapon switch, sprint, death).
    public func drop() {
        latched = false
        wanted = false
    }

    public func reset() {
        latched = false
        wanted = false
        aiming = false
        blend = 0
    }
}

/// Swapping guns: the one in hand goes down for its lower time, then the next comes up.
public final class WeaponSwitch {
    public private(set) var index = 0
    private var target = 0
    private enum Phase { case none, lowering, raising }
    private var phase = Phase.none
    private var time = 0.0
    private let count: Int
    private let timesOf: (Int) -> SimConstants.SwitchTimes

    public init(count: Int, timesOf: @escaping (Int) -> SimConstants.SwitchTimes) {
        self.count = count
        self.timesOf = timesOf
    }

    public var switching: Bool { phase != .none }
    /// Weapon that will be in hand once the switch finishes.
    public var pending: Int { target }

    /// 0 with the gun up, 1 with it fully lowered.
    public var lowered: Double {
        if phase == .none { return 0 }
        let times = timesOf(index)
        let progress = min(1, time / (phase == .lowering ? times.lowerTime : times.raiseTime))
        return phase == .lowering ? progress : 1 - progress
    }

    /// Ask for another weapon. Returns true when the gun in hand starts going down because of it.
    @discardableResult
    public func request(_ index: Int) -> Bool {
        if index < 0 || index >= count { return false }
        if phase == .lowering {
            target = index
            return false
        }
        if index == self.index { return false }
        // Raising: turn round from however far up the gun already is.
        let raised = phase == .raising ? min(1, time / timesOf(self.index).raiseTime) : 1
        phase = .lowering
        time = timesOf(self.index).lowerTime * (1 - raised)
        target = index
        return true
    }

    /// Advance. Returns true on the frame a different weapon comes into the hands.
    @discardableResult
    public func update(_ dt: Double) -> Bool {
        if phase == .none { return false }
        time += dt
        if phase == .raising {
            if time >= timesOf(index).raiseTime { phase = .none }
            return false
        }
        if time < timesOf(index).lowerTime { return false }
        let changed = target != index
        index = target
        phase = .raising
        time = 0
        return changed
    }

    /// Put a weapon straight into the hands, with no lowering or raising.
    public func hold(_ index: Int) {
        if index < 0 || index >= count { return }
        self.index = index
        reset()
    }

    public func reset() {
        phase = .none
        time = 0
        target = index
    }
}
