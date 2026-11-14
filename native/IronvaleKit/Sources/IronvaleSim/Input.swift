// Ported from the action model of src/core/input.ts at commit 185029e. Bindings are the web's
// `KeyboardEvent.code` strings (plus Mouse0, Mouse2, WheelUp, WheelDown), read from
// Contract/sim/sim.json, so a bindings JSON means the same thing in both builds (PLAN.md 3.10).
import Foundation

public enum Action: String, Sendable, CaseIterable {
    case moveForward, moveBack, moveLeft, moveRight, sprint, crouch, jump, fire, aim, reload, holdBreath, grenade
    case weaponNext, weaponPrev, slot1, slot2, slot3, slot4, slot5, slot6, scores, pause
}

/// What the player and weapons read each frame (`Input` in the TypeScript).
public protocol ActionInput: AnyObject {
    func isDown(_ action: Action) -> Bool
    func wasPressed(_ action: Action) -> Bool
    /// The look delta in pixels since the last call, smoothed when the controls ask for it.
    func consumeLook(dt: Double) -> (dx: Double, dy: Double)
    /// Pointer captured (the web's pointer lock).
    var locked: Bool { get }
}

/// The parts of `ControlSettings` and `GameplaySettings` the sim reads.
public struct PlayerSettings: Sendable, Equatable {
    public var preset: String
    public var sensitivity: Double
    public var adsSensitivity: Double
    public var invertY: Bool
    public var adsToggle: Bool
    public var lookSmoothing: Double
    public var rawInput: Bool
    public var fov: Double
    public var headBob: Double

    public init(preset: String, sensitivity: Double, adsSensitivity: Double, invertY: Bool, adsToggle: Bool,
                lookSmoothing: Double, rawInput: Bool, fov: Double, headBob: Double) {
        self.preset = preset
        self.sensitivity = sensitivity
        self.adsSensitivity = adsSensitivity
        self.invertY = invertY
        self.adsToggle = adsToggle
        self.lookSmoothing = lookSmoothing
        self.rawInput = rawInput
        self.fov = fov
        self.headBob = headBob
    }

    public init(preset: SimConstants.Input.ControlPreset, gameplay: SimConstants.Input.Gameplay) {
        self.preset = preset.preset
        sensitivity = preset.sensitivity
        adsSensitivity = preset.adsSensitivity
        invertY = preset.invertY
        adsToggle = preset.adsToggle
        lookSmoothing = preset.lookSmoothing
        rawInput = preset.rawInput
        fov = gameplay.fov
        headBob = gameplay.headBob
    }

    /// The web defaults for `preset` ("mouse" or "trackpad").
    public static func defaults(_ preset: String, data: SimData = .shared) -> PlayerSettings {
        let input = data.constants.input
        let control = input.controlPresets[preset] ?? input.controlPresets["mouse"]!
        return PlayerSettings(preset: control, gameplay: input.defaultGameplay)
    }
}

/// Device-level state for one frame, in binding codes; Platform fills it, `BoundInput` maps it to actions.
public struct InputFrame: Sendable, Equatable {
    public var held: Set<String> = []
    public var pressed: Set<String> = []
    public var lookX = 0.0
    public var lookY = 0.0
    public var locked = false

    public init(held: Set<String> = [], pressed: Set<String> = [], lookX: Double = 0, lookY: Double = 0, locked: Bool = false) {
        self.held = held
        self.pressed = pressed
        self.lookX = lookX
        self.lookY = lookY
        self.locked = locked
    }
}

/// Codes to actions through the bindings of a control preset, with the web's look smoothing.
public final class BoundInput: ActionInput {
    public var frame = InputFrame()
    public var settings: PlayerSettings
    private var bindings: [String: [String]]
    private var smoothX = 0.0
    private var smoothY = 0.0
    private let data: SimData

    public init(settings: PlayerSettings, data: SimData = .shared) {
        self.settings = settings
        self.data = data
        bindings = data.constants.input.bindings[settings.preset] ?? data.constants.input.bindings["mouse"] ?? [:]
    }

    public func setPreset(_ settings: PlayerSettings) {
        self.settings = settings
        bindings = data.constants.input.bindings[settings.preset] ?? bindings
    }

    public var locked: Bool { frame.locked }

    public func isDown(_ action: Action) -> Bool {
        bindings[action.rawValue]?.contains { frame.held.contains($0) } ?? false
    }

    public func wasPressed(_ action: Action) -> Bool {
        bindings[action.rawValue]?.contains { frame.pressed.contains($0) } ?? false
    }

    /// `Input.consumeLook`: raw deltas, or spread over a short window for coarse trackpad reports.
    public func consumeLook(dt: Double) -> (dx: Double, dy: Double) {
        let rawX = frame.lookX
        let rawY = frame.lookY
        frame.lookX = 0
        frame.lookY = 0
        let smoothing = settings.lookSmoothing
        if smoothing <= 0 { return (rawX, rawY) }
        smoothX += rawX
        smoothY += rawY
        let window = 0.012 + smoothing * 0.06
        let share = min(1, dt / window)
        let dx = smoothX * share
        let dy = smoothY * share
        smoothX -= dx
        smoothY -= dy
        return (dx, dy)
    }
}
