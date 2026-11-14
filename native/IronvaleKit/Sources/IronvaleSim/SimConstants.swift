// Simulation constants, read at run time from native/Contract/sim/sim.json, which
// native/Tools/sim-fixtures extracts from src/ (PLAN.md section 10: never hand-copy a constant the
// tools can extract). Names follow the TypeScript constants they come from.
import Foundation
import IronvaleContract

public struct SimConstants: Codable, Sendable {
    public struct Controller: Codable, Sendable {
        public let RADIUS, STAND_HEIGHT, CROUCH_HEIGHT, STAND_EYE, CROUCH_EYE: Double
        public let WALK_SPEED, SPRINT_SPEED, CROUCH_SPEED, AIM_SPEED_FACTOR: Double
        public let GROUND_ACCEL, AIR_ACCEL, FRICTION, GRAVITY, JUMP_SPEED, COYOTE_TIME, MAX_PITCH: Double
        public let STRIDE_WALK, STRIDE_RUN, REGEN_DELAY, REGEN_PER_SECOND: Double
    }

    public struct Engine: Codable, Sendable { public let MAX_FRAME_DT: Double }
    public struct Machine: Codable, Sendable { public let PRESS_BUFFER: Double }

    /// One `MarkSpec`: `[fraction, stage, effect?]`.
    public struct MarkSpec: Codable, Sendable, Equatable {
        public let fraction: Double
        public let stage: String
        public let effect: String?

        public init(_ fraction: Double, _ stage: String, _ effect: String? = nil) {
            self.fraction = fraction
            self.stage = stage
            self.effect = effect
        }

        public init(from decoder: any Decoder) throws {
            var container = try decoder.unkeyedContainer()
            fraction = try container.decode(Double.self)
            stage = try container.decode(String.self)
            effect = container.isAtEnd ? nil : try container.decode(String.self)
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.unkeyedContainer()
            try container.encode(fraction)
            try container.encode(stage)
            if let effect { try container.encode(effect) }
        }
    }

    public struct Plans: Codable, Sendable {
        public let HANDS_LEAD, HANDS_TAIL, CHARGE_SECONDS, TACTICAL_FACTOR, BOLT_TOP_UP_FACTOR: Double
        public let BOLT_CYCLE: [MarkSpec]
    }

    public struct Recoil: Codable, Sendable {
        public let GROWTH_PER_SHOT, MAX_HEAT, HEAT_HOLD_SECONDS, HEAT_DRAIN_PER_SECOND, AIMED_KICK, CROUCHED: Double
        public let BLOOM_PER_SHOT, MAX_BLOOM, BLOOM_RECOVERY, AIMED_BLOOM, AIMED_MOVE, FULL_MOVE_SPEED: Double
        public let AIR_SPREAD_FACTOR, AIR_SPREAD_MIN, KICK_APPLY_RATE, KICK_RETURN_RATE: Double
    }

    public struct Aim: Codable, Sendable { public let LOWER_SPEEDUP: Double }

    public struct GrenadeMath: Codable, Sendable {
        public let REST_NORMAL_Y, LOOKAHEAD_RADII, BLAST_LIFT: Double
        public let CONTACTS_PER_STEP: Int
    }

    public struct Grenades: Codable, Sendable {
        public let POOL_SIZE, MAX_STEPS_PER_FRAME: Int
        public let BOUNCE_GAP_SECONDS, DETONATE_GRACE_SECONDS, DETONATE_TOLERANCE, CHEST_SHARE: Double
    }

    public struct GrenadeHand: Codable, Sendable {
        public let GRENADES_PER_MATCH: Int
        public let LOWER_SECONDS, RAISE_SECONDS, FOLLOW_THROUGH_SECONDS: Double
    }

    public struct GrenadeThrow: Codable, Sendable { public let HAND_OFFSET: [Double] }

    public struct Ballistics: Codable, Sendable {
        public let INSTANT_RANGE, NEAR_MISS_RADIUS, CASING_BEHIND_MUZZLE, CASING_SIDE_SPEED, CASING_UP_SPEED, BOLT_EJECT_DELAY: Double
    }

    public struct Handling: Codable, Sendable {
        public struct ClassHandling: Codable, Sendable {
            public let lowerTime, raiseTime: Double
            public let hip, hipTilt: [Double]
        }

        public let classes: [String: ClassHandling]
        public let SPRINT_IN_SECONDS, SPRINT_OUT_SECONDS, SPRINT_READY_BLEND, SPRINT_HOLD_OFF_SECONDS: Double
    }

    public struct SwitchTimes: Codable, Sendable, Equatable {
        public let lowerTime, raiseTime: Double

        public init(lowerTime: Double, raiseTime: Double) {
            self.lowerTime = lowerTime
            self.raiseTime = raiseTime
        }
    }

    public struct PlayerWeapons: Codable, Sendable {
        public let SCOPED_AT, GRENADE_READY: Double
        public let DEFAULT_SWITCH_TIMES: SwitchTimes
    }

    public struct Loadout: Codable, Sendable { public let RESERVED: [String: [String]] }

    public struct Game: Codable, Sendable {
        public let PLAYER_LIVES, SURVIVAL_SOLO_LIVES, SURVIVAL_WAVE_GROWTH, DEFAULT_KILL_TARGET: Int
        public let WIN_DELAY_SECONDS, RESPAWN_SECONDS, SNAPSHOT_INTERVAL, KILL_FEED_SECONDS, SURVIVAL_WAVE_PAUSE: Double
    }

    public struct Input: Codable, Sendable {
        public struct ControlPreset: Codable, Sendable, Equatable {
            public let preset: String
            public let sensitivity, adsSensitivity, aimAssist, lookSmoothing: Double
            public let invertY, adsToggle, rawInput: Bool
        }

        public struct Gameplay: Codable, Sendable { public let fov, headBob: Double }

        /// Preset name -> action -> `KeyboardEvent.code` bindings (plus Mouse0/Mouse2/WheelUp/WheelDown).
        public let bindings: [String: [String: [String]]]
        public let controlPresets: [String: ControlPreset]
        public let defaultGameplay: Gameplay
        public let WHEEL_THRESHOLD, WHEEL_QUIET_MS, LOOK_SPIKE_PX: Double
    }

    public let controller: Controller
    public let engine: Engine
    public let machine: Machine
    public let plans: Plans
    public let recoil: Recoil
    public let aim: Aim
    public let grenadeMath: GrenadeMath
    public let grenades: Grenades
    public let grenadeHand: GrenadeHand
    public let grenadeThrow: GrenadeThrow
    public let ballistics: Ballistics
    public let handling: Handling
    public let playerWeapons: PlayerWeapons
    public let loadout: Loadout
    public let game: Game
    public let input: Input

    /// `<Contract>/sim/sim.json`.
    public static func load(contractDirectory: URL) throws -> SimConstants {
        let url = contractDirectory.appending(path: "sim/sim.json")
        do {
            return try JSONDecoder().decode(SimConstants.self, from: Data(contentsOf: url))
        } catch {
            throw ContractError.unreadable("sim/sim.json", error)
        }
    }
}

/// The contract tables plus the sim constants, loaded once.
public struct SimData: Sendable {
    public let contract: Contract
    public let constants: SimConstants
    /// `GRENADE` (src/weapons/grenade-math.ts), typed.
    public let grenade: GrenadeFigures
    /// Defs in `WEAPON_IDS` order.
    public var weapons: [WeaponDef] { contract.weapons.weapons }

    public init(contract: Contract, constants: SimConstants) throws {
        self.contract = contract
        self.constants = constants
        grenade = try GrenadeFigures(contract.weapons.grenade)
    }

    public static func load() throws -> SimData {
        let contract = try Contract.load()
        return try SimData(contract: contract, constants: SimConstants.load(contractDirectory: contract.directory))
    }

    /// Loaded once per process for tests and the app.
    public static let shared: SimData = {
        do { return try load() } catch { fatalError("IronvaleSim could not load its data: \(error)") }
    }()

    public func def(_ id: String) -> WeaponDef? { contract.weapons.def(id) }
}

public enum SimDataError: Error, CustomStringConvertible {
    case missing(String)

    public var description: String {
        switch self {
        case .missing(let name): "Contract value missing: \(name)"
        }
    }
}

/// `GRENADE` from weapons.json.
public struct GrenadeFigures: Sendable {
    public let fuse, throwSpeed, upBias, gravity, radius, restitution, friction, rollFriction: Double
    public let bounceSpeed, restSpeed, step, maxDamage, lethalDamage, lethalRadius, blastRadius, shakeRadius: Double
    public let maxArcPoints: Int

    init(_ table: [String: Double]) throws {
        func value(_ key: String) throws -> Double {
            guard let v = table[key] else { throw SimDataError.missing("GRENADE.\(key)") }
            return v
        }
        fuse = try value("fuse")
        throwSpeed = try value("throwSpeed")
        upBias = try value("upBias")
        gravity = try value("gravity")
        radius = try value("radius")
        restitution = try value("restitution")
        friction = try value("friction")
        rollFriction = try value("rollFriction")
        bounceSpeed = try value("bounceSpeed")
        restSpeed = try value("restSpeed")
        step = try value("step")
        maxDamage = try value("maxDamage")
        lethalDamage = try value("lethalDamage")
        lethalRadius = try value("lethalRadius")
        blastRadius = try value("blastRadius")
        shakeRadius = try value("shakeRadius")
        maxArcPoints = Int(try value("maxArcPoints"))
    }
}
