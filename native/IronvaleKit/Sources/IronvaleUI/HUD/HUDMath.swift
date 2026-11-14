// Ported at cbe0add from the pure HUD helpers: src/ui/damage.ts, src/ui/killfeed.ts, src/ui/format.ts
// (respawnCountdown, rulesOf), src/ui/hud/extras.ts (killNote), src/ui/hud/grenade.ts (grenadeHint),
// src/ui/hud/minimap-model.ts and src/ui/hud/picker.ts (weaponStats). native/Tools/ui-fixtures/hud-fixtures.test.ts
// records the web's answers; IronvaleUITests/HUDFixtureTests checks these against them.
import Foundation
import IronvaleContract

public enum HUDMath {
    static let tau = Double.pi * 2

    // MARK: damage.ts

    /// Screen angle of a damage source, radians clockwise from the top of the screen (0 ahead, +pi/2 right).
    /// `dx`, `dz`: horizontal direction from the player toward the source. Yaw 0 looks down -Z, +yaw turns left.
    public static func damageAngle(dx: Double, dz: Double, yaw: Double) -> Double {
        if dx == 0 && dz == 0 { return 0 }
        let s = sin(yaw), c = cos(yaw)
        let ahead = -dx * s - dz * c
        let right = dx * c - dz * s
        return atan2(right, ahead)
    }

    /// The angle equal to `target` (mod a full turn) closest to `previous`.
    public static func unwrapAngle(previous: Double, target: Double) -> Double {
        let delta = target - previous
        return previous + delta - jsRound(delta / tau) * tau
    }

    public struct HealthEffects: Equatable, Sendable {
        /// Opacity of the red edge vignette, 0 - 1.
        public var vignette: Double
        /// Colour saturation of the scene, 1 = untouched.
        public var saturation: Double
    }

    /// Nothing above 60 health, full at 10 and below (EFFECT_START, EFFECT_FULL, MIN_SATURATION in damage.ts).
    public static func healthEffects(_ health: Double) -> HealthEffects {
        let start = 60.0, full = 10.0, minSaturation = 0.3
        let t = min(1, max(0, (start - health) / (start - full)))
        if t == 0 { return HealthEffects(vignette: 0, saturation: 1) }
        return HealthEffects(vignette: t, saturation: 1 - (1 - minSaturation) * t)
    }

    // MARK: killfeed.ts

    /// Entries newer than `maxAge` seconds, oldest first, capped to the newest `maxRows`.
    public static func trimKillFeed(_ entries: [KillFeedEntry], now: Double, maxAge: Double, maxRows: Int) -> [KillFeedEntry] {
        if maxRows <= 0 { return [] }
        let fresh = entries.filter { now - $0.time < maxAge }
        return Array(fresh.suffix(maxRows))
    }

    /// Identity of a kill: `time.toFixed(3)|killer|victim`.
    public static func feedKey(_ entry: KillFeedEntry) -> String {
        "\(toFixed(entry.time, 3))|\(entry.killer)|\(entry.victim)"
    }

    // MARK: format.ts

    /// Whole seconds left before a respawn; holds at 1 until the game puts the player back.
    public static func respawnCountdown(diedAt: Double, now: Double, delay: Double) -> Int {
        Int(max(1, (delay - (now - diedAt)).rounded(.up)))
    }

    /// The rules a match is played under: co-op plays Skirmish or Survival rules.
    public static func rulesOf(mode: String?, rules: String?) -> String {
        guard let mode else { return "skirmish" }
        return mode == "coop" ? (rules ?? "skirmish") : mode
    }

    // MARK: extras.ts, grenade.ts

    static let streakNames = ["", "", "Double kill", "Triple kill", "Four in a row", "Five in a row"]

    public static func killNote(headshot: Bool, streak: Int, distance: Double) -> String {
        var parts = [streak >= 2 ? (streakNames.indices.contains(streak) ? streakNames[streak] : "\(streak) in a row") : "Enemy down"]
        if headshot { parts.append("Headshot") }
        if distance >= 60 { parts.append("\(Int(jsRound(distance))) m") }
        return parts.joined(separator: " · ")
    }

    public static func grenadeHint(count: Int, aiming: Bool, key: String) -> String {
        if aiming { return "Release \(key) to throw" }
        return count > 0 ? "Hold \(key)" : "Used"
    }

    // MARK: minimap-model.ts

    public static let cellFloor: UInt8 = 0
    public static let cellWall: UInt8 = 1
    public static let cellSolid: UInt8 = 2

    /// Classify every grid cell: floor where any level is walkable, wall within `rim` cells of floor, else solid.
    public static func buildLayout(nx: Int, nz: Int, colStart: [Int], edges: [Int], rim: Int = 2) -> [UInt8] {
        let far = rim + 1
        var cells = [Int](repeating: far, count: nx * nz)
        for col in 0..<cells.count {
            let end = col + 1 < colStart.count ? colStart[col + 1] : 0
            var n = colStart[col]
            while n < end {
                if edges[n] != 0 {
                    cells[col] = 0
                    break
                }
                n += 1
            }
        }
        func at(_ ix: Int, _ iz: Int) -> Int { ix < 0 || iz < 0 || ix >= nx || iz >= nz ? far : cells[iz * nx + ix] }
        for iz in 0..<nz {
            for ix in 0..<nx {
                let near = min(at(ix - 1, iz), at(ix - 1, iz - 1), at(ix, iz - 1), at(ix + 1, iz - 1)) + 1
                if near < cells[iz * nx + ix] { cells[iz * nx + ix] = near }
            }
        }
        for iz in stride(from: nz - 1, through: 0, by: -1) {
            for ix in stride(from: nx - 1, through: 0, by: -1) {
                let near = min(at(ix + 1, iz), at(ix + 1, iz + 1), at(ix, iz + 1), at(ix - 1, iz + 1)) + 1
                if near < cells[iz * nx + ix] { cells[iz * nx + ix] = near }
            }
        }
        return cells.map { $0 == 0 ? cellFloor : $0 <= rim ? cellWall : cellSolid }
    }

    public struct MapPoint: Equatable, Sendable {
        public var x: Double
        public var y: Double
        /// The point lay past the limit and was pulled back to the edge.
        public var outside: Bool
    }

    /// Where something `dx`, `dz` metres from the player lands on a map turned so the way the player faces is up.
    public static func toMap(dx: Double, dz: Double, yaw: Double, scale: Double, limit: Double) -> MapPoint {
        let c = cos(yaw), s = sin(yaw)
        let x = (dx * c - dz * s) * scale
        let y = (dx * s + dz * c) * scale
        let length = hypot(x, y)
        let outside = length > limit + 1e-6
        let shrink = outside ? limit / length : 1
        return MapPoint(x: x * shrink, y: y * shrink, outside: outside)
    }

    /// Half the horizontal view angle in radians, from a vertical field of view in degrees.
    public static func horizontalHalfFov(verticalDegrees: Double, aspect: Double) -> Double {
        atan(tan(verticalDegrees * Double.pi / 360) * aspect)
    }

    /// Seconds since a shot on the match clock; infinity when there is none or the clock has restarted.
    public static func shotAge(firedAt: Double?, now: Double) -> Double {
        guard let firedAt, firedAt <= now else { return .infinity }
        return now - firedAt
    }

    /// Duel: seconds into the current reveal of the opponent, or infinity between reveals.
    public static func revealAge(now: Double, every: Double, hold: Double) -> Double {
        if !(now >= every) { return .infinity }
        let into = fmod(now, every)
        return into < hold ? into : .infinity
    }

    // MARK: picker.ts

    public struct Stat: Equatable, Sendable {
        public let label: String
        public let value: Double
    }

    /// Four bars that compare the guns with each other.
    public static func weaponStats(_ def: WeaponDef) -> [Stat] {
        func unit(_ v: Double) -> Double { min(1, max(0, v)) }
        return [
            Stat(label: "Damage", value: unit(def.damage * def.pellets / 100)),
            Stat(label: "Range", value: pow(unit(def.falloffEnd / 500), 0.6)),
            Stat(label: "Rate of fire", value: unit(def.roundsPerMinute / 800)),
            Stat(label: "Handling", value: unit(1 - (def.aimTime - 0.14) / 0.34) * unit(def.mobility - 0.1)),
        ]
    }

    // MARK: keys.ts

    static let specialKeys: [String: String] = [
        "Space": "Space", "Escape": "Esc", "Enter": "Enter", "Tab": "Tab", "Backquote": "`", "ShiftLeft": "Shift", "ShiftRight": "Right Shift",
        "ControlLeft": "Control", "ControlRight": "Right Control", "AltLeft": "Option", "AltRight": "Right Option", "MetaLeft": "Command",
        "MetaRight": "Right Command", "ArrowUp": "Up arrow", "ArrowDown": "Down arrow", "ArrowLeft": "Left arrow", "ArrowRight": "Right arrow",
        "BracketLeft": "[", "BracketRight": "]", "Comma": ",", "Period": ".", "Slash": "/", "Semicolon": ";", "Quote": "'", "Minus": "-",
        "Equal": "=",
    ]
    static let pointerKeys: [String: [String: String]] = [
        "trackpad": ["Mouse0": "Click", "Mouse1": "Middle click", "Mouse2": "Two-finger click", "WheelUp": "Two-finger scroll up",
                     "WheelDown": "Two-finger scroll down"],
        "mouse": ["Mouse0": "Left click", "Mouse1": "Middle click", "Mouse2": "Right click", "WheelUp": "Scroll up", "WheelDown": "Scroll down"],
    ]

    /// A name a player would recognise for a binding code (`keyName`).
    public static func keyName(_ code: String, preset: String) -> String {
        if let pointer = pointerKeys[preset]?[code] { return pointer }
        if let special = specialKeys[code] { return special }
        let scalars = Array(code.unicodeScalars)
        func isDigit(_ s: Unicode.Scalar) -> Bool { ("0"..."9").contains(s) }
        if code.hasPrefix("Key"), scalars.count == 4, ("A"..."Z").contains(scalars[3]) { return String(code.dropFirst(3)) }
        if code.hasPrefix("Digit"), scalars.count == 6, isDigit(scalars[5]) { return String(code.dropFirst(5)) }
        if code.hasPrefix("Numpad"), scalars.count == 7, isDigit(scalars[6]) { return "Numpad \(code.dropFirst(6))" }
        return code
    }

    // MARK: JS number helpers

    /// `Math.round`: halves toward +infinity.
    static func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

    /// `Number.prototype.toFixed` for the small, finite values the HUD formats (ties away from zero).
    public static func toFixed(_ x: Double, _ digits: Int) -> String {
        let scale = pow(10, Double(digits))
        let scaled = (abs(x) * scale).rounded(.toNearestOrAwayFromZero)
        let sign = x < 0 && scaled != 0 ? "-" : ""
        let whole = Int(scaled)
        let integer = whole / Int(scale)
        let fraction = whole % Int(scale)
        if digits == 0 { return "\(sign)\(integer)" }
        let padded = String(fraction).leftPadded(digits)
        return "\(sign)\(integer).\(padded)"
    }
}

/// One row of the kill feed (`KillFeedEntry` in contracts.ts): names, weapon id, headshot, match time.
public struct KillFeedEntry: Equatable, Sendable {
    public var killer: String
    public var victim: String
    /// Weapon id; the feed shows its display name.
    public var weapon: String
    public var headshot: Bool
    public var time: Double

    public init(killer: String, victim: String, weapon: String, headshot: Bool, time: Double) {
        self.killer = killer
        self.victim = victim
        self.weapon = weapon
        self.headshot = headshot
        self.time = time
    }
}

extension String {
    func leftPadded(_ width: Int) -> String {
        count >= width ? self : String(repeating: "0", count: width - count) + self
    }
}
