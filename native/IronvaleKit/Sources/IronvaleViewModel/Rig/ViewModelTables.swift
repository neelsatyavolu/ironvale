// The view-model constants exported from the web by native/Tools/viewmodel-export
// (native/Contract/viewmodel.json): rig, motion and parts constants, pose offsets, handling, the arms'
// shoulder, hand and finger tables, per-weapon def fields and the gun finish tables.
import Foundation
import IronvaleContract

/// A pose offset in camera space (src/weapons/view/poses.ts PoseOffset).
public struct PoseOffset: Decodable, Sendable {
    public let x: Double
    public let y: Double
    public let z: Double
    public let pitch: Double
    public let yaw: Double
    public let roll: Double
}

public struct ViewModelTables: Decodable, Sendable {
    public struct Rig: Decodable, Sendable {
        public let RUN_SPEED: Double
        public let STRIDE: Double
        public let MAX_TURN_RATE: Double
        public let SWAY_ROTATION: Double
        public let SWAY_SHIFT: Double
        public let AIMED_SWAY: Double
        public let AIMED_BOB: Double
        public let AIMED_RISE: Double
        public let KICK_IMPULSE: Double
        public let WALL_MARGIN: Double
        public let WALL_MAX_ANGLE: Double
        public let VIEW_MODEL_FOV: Double
        public let springs: [String: [Double]]
        public let SHOULDER: [Double]
    }

    public struct Motion: Decodable, Sendable {
        public let MAX_SPRING_STEP: Double
    }

    public struct Parts: Decodable, Sendable {
        public let SLIDE_BACK_SECONDS: Double
        public let SLIDE_RETURN_SECONDS: Double
        public let MAG_DROP_METRES: Double
        public let MAG_TOWARD_SHOOTER: Double
        public let MAG_FALL_SECONDS: Double
        public let MAG_SEAT_SECONDS: Double
        public let BOLT_LIFT_RADIANS: Double
        public let COVER_OPEN_RADIANS: Double
        public let TRIGGER_PULL_RADIANS: Double
        public let TRIGGER_HOLD_SECONDS: Double
        public let TRIGGER_RELEASE_SECONDS: Double
        public let WEIGHT_RATE: Double
        public let RELEASE_RATE: Double
    }

    public struct Poses: Decodable, Sendable {
        public let lowered: PoseOffset
        public let againstWall: PoseOffset
    }

    public struct Handling: Decodable, Sendable {
        public let hip: [Double]
        public let hipTilt: [Double]
    }

    public struct Arms: Decodable, Sendable {
        public struct Shoulder: Decodable, Sendable {
            public let home: [Double]
            public let pole: [Double]
        }

        public struct Hand: Decodable, Sendable {
            public let palmAlong: Double
            public let palmAcross: Double
            public let palmDepth: Double
            public let forearmTwistShare: Double
            public let minReach: Double
            public let maxReach: Double
        }

        public struct Curls: Decodable, Sendable {
            public let point: [Double]
            public let middle: [Double]
            public let ring: [Double]
            public let pink: [Double]
            public let pointSpread: Double
            public let thumb: [Double]
            public let thumbSpread: Double
            public let cup: Double

            func finger(_ name: String) -> [Double] {
                switch name {
                case "point": point
                case "middle": middle
                case "ring": ring
                default: pink
                }
            }
        }

        public struct Tuck: Decodable, Sendable {
            public let position: [Double]
            public let fingers: [Double]
            public let thumb: [Double]
        }

        public let asset: String
        public let SOURCE_SCALE: Double
        public let FINGERS: [String]
        public let shoulders: [String: Shoulder]
        public let hand: Hand
        public let fingerCurls: [String: Curls]
        public let tuck: Tuck
        public let supportBlendSeconds: Double
        public let EPSILON: Double
    }

    public struct Weapon: Decodable, Sendable {
        public struct Recoil: Decodable, Sendable {
            public let kickback: Double
            public let vertical: Double
            public let horizontal: Double
        }

        public let weaponClass: String
        public let fireMode: String
        public let reloadStyle: String
        public let scoped: Bool
        public let aimTime: Double
        public let aimZoom: Double
        public let recoil: Recoil
        public let sprintPose: PoseOffset
        public let reloadPose: PoseOffset
        public let workPose: PoseOffset
    }

    /// guns-c-materials.ts FinishTweak, keyed by the exported material name (`<source>_tuned`).
    public struct TunedFinish: Decodable, Sendable {
        public let source: String
        public let tint: Int
        public let metalLift: Double
        public let polymerLift: Double
        public let roughness: Double
        public let roughnessBias: Double
        public let scratchGloss: Double
        public let minRoughness: Double
        public let maxRoughness: Double
        public let metalness: Double
        public let wear: Double
        public let noiseScale: Double
        public let rub: Double
        public let normalScale: Double
    }

    /// m7-materials.ts Finish, keyed by the exported material name (`<source>_finish`).
    public struct M7Finish: Decodable, Sendable {
        public let tint: Int
        public let roughness: Double
        public let metalness: Double
        public let wear: Double
        public let mottle: Double
        public let rub: Double
        public let noiseScale: Double
    }

    public struct Finishes: Decodable, Sendable {
        public let tuned: [String: [String: TunedFinish]]
        public let m7: [String: M7Finish]
    }

    public let rig: Rig
    public let motion: Motion
    public let parts: Parts
    public let poses: Poses
    public let handling: [String: Handling]
    public let arms: Arms
    public let weapons: [String: Weapon]
    public let finishes: Finishes
    /// guns-c-optic.ts RETICLE: dot, ring and ring width in radians, colour (sRGB hex) and gain.
    public let reticle: Reticle

    public struct Reticle: Decodable, Sendable {
        public let dot: Double
        public let ring: Double
        public let ringWidth: Double
        public let color: Int
        public let gain: Double
    }

    public static func load(contractDirectory: URL) throws -> ViewModelTables {
        let url = contractDirectory.appending(path: "viewmodel.json")
        do {
            return try JSONDecoder().decode(ViewModelTables.self, from: Data(contentsOf: url))
        } catch {
            throw ContractError.unreadable("viewmodel.json", error)
        }
    }
}

extension Array where Element == Double {
    var vec3: RVec3 { RVec3(self[0], self[1], self[2]) }
}
