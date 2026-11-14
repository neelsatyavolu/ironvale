// The HUD's own memory between frames, ported at cbe0add from the event handlers of src/ui/hud/hud.ts,
// reticle.ts (hit marker, damage arcs), extras.ts (kill note, streak, recently hit enemies), minimap.ts
// (shots) and game.ts's kill feed. Times: `wall` is real seconds (the web's performance.now(), WAAPI
// animations), `match` is the match clock (ctx.time, which stops on pause).
import Foundation

public final class HUDTracker {
    let c = HUDConstants.shared

    // reticle.ts
    public struct Arc: Sendable {
        public var dx = 0.0, dz = 0.0
        /// Angle on screen, unwrapped so turning never takes the long way.
        public var shown = 0.0
        public var start = -Double.infinity
        public var until = 0.0
    }
    public private(set) var arcs: [Arc]
    public private(set) var marker: (start: Double, fatal: Bool)?
    public private(set) var aiming = false

    // hud.ts
    public private(set) var toast: (name: String, weaponClass: String, start: Double)?
    public private(set) var deathCause = ""
    public private(set) var diedAt = 0.0
    public private(set) var dead = false
    var deadSince = -Double.infinity

    // extras.ts
    public private(set) var killNote: (text: String, start: Double)?
    var streak = 0
    var lastKillAt = -Double.infinity
    /// Enemy id -> match time its bar disappears.
    public private(set) var recentHits: [Int: Double] = [:]

    // minimap.ts
    public private(set) var shots: [Int: (time: Double, position: SIMD3<Double>)] = [:]

    // game.ts kill feed (the last 5) and when each row first showed (for iv-feed-in).
    public private(set) var feed: [KillFeedEntry] = []
    var feedShown: [String: Double] = [:]

    // Smoothed CSS transitions.
    var vignette = 0.0, dim = 0.0, reload = 0.0, cross = 1.0, healthFill = 1.0
    var lastWall: Double?

    public init() {
        arcs = Array(repeating: Arc(), count: HUDConstants.shared.arcCount)
    }

    /// A match starts or the HUD hides: forget everything that animates (`setVisible(false)`, reticle.clear()).
    public func reset() {
        arcs = Array(repeating: Arc(), count: c.arcCount)
        marker = nil
        toast = nil
        aiming = false
        killNote = nil
        streak = 0
        lastKillAt = -.infinity
        recentHits = [:]
        shots = [:]
        feed = []
        feedShown = [:]
        dead = false
        deathCause = ""
        lastWall = nil
    }

    // MARK: Events

    /// The local player hit someone else (`combatantHit` with the player as attacker).
    public func playerHit(targetId: Int, fatal: Bool, showMarker: Bool, wall: Double, match: Double) {
        if showMarker { marker = (wall, fatal) }
        recentHits[targetId] = match + c.barSeconds
    }

    /// `playerHurt`: `dx`, `dz` point from the player toward the source.
    public func hurt(dx: Double, dz: Double, yaw: Double, wall: Double) {
        let angle = HUDMath.damageAngle(dx: dx, dz: dz, yaw: yaw)
        let showing = arcs.indices.first { i in
            arcs[i].until > wall
                && abs(HUDMath.unwrapAngle(previous: angle, target: HUDMath.damageAngle(dx: arcs[i].dx, dz: arcs[i].dz, yaw: yaw)) - angle) < c.arcMerge
        }
        let index = showing ?? arcs.indices.min { arcs[$0].until < arcs[$1].until }!
        arcs[index].dx = dx
        arcs[index].dz = dz
        arcs[index].until = wall + c.arcSeconds
        arcs[index].start = wall
        aim(index, yaw: yaw, immediate: showing == nil)
    }

    private func aim(_ index: Int, yaw: Double, immediate: Bool) {
        let target = HUDMath.damageAngle(dx: arcs[index].dx, dz: arcs[index].dz, yaw: yaw)
        let next = immediate ? target : HUDMath.unwrapAngle(previous: arcs[index].shown, target: target)
        if !immediate && abs(next - arcs[index].shown) < c.arcRedraw { return }
        arcs[index].shown = next
    }

    /// Re-aim showing arcs after the player turned (`reticle.track()`).
    public func track(yaw: Double, wall: Double) {
        for i in arcs.indices where arcs[i].until > wall { aim(i, yaw: yaw, immediate: false) }
    }

    public func aimChanged(_ aiming: Bool) { self.aiming = aiming }

    /// A local `weaponSwitch`: the toast, and aiming drops.
    public func weaponSwitched(name: String, weaponClass: String, wall: Double) {
        aiming = false
        toast = (name, c.weaponClasses[weaponClass] ?? weaponClass, wall)
    }

    /// `died`. `killer`/`victim` are names (the combatants' `name`), `weaponName` the display name.
    public func died(victimId: Int, killerId: Int, playerId: Int, killer: String?, victim: String?, weaponName: String, headshot: Bool,
                     distance: Double, match: Double, wall: Double) {
        feed = Array((feed + [KillFeedEntry(killer: killer ?? "Unknown", victim: victim ?? "Unknown", weapon: weaponName, headshot: headshot,
                                            time: match)]).suffix(5))
        if victimId == playerId {
            streak = 0
            deathCause = killer != nil && killerId != playerId ? "\(killer!), \(weaponName)" : ""
            return
        }
        guard killerId == playerId else { return }
        streak = match - lastKillAt <= c.streakSeconds ? streak + 1 : 1
        lastKillAt = match
        killNote = (HUDMath.killNote(headshot: headshot, streak: streak, distance: distance), wall)
    }

    /// Someone else fired (`shotFired` with `local` false): marks the minimap.
    public func shot(shooterId: Int, muzzle: SIMD3<Double>, match: Double) {
        shots[shooterId] = (match, muzzle)
    }

    /// Ids of enemies whose bars still show; drops the rest (`alive` answers for each id).
    public func liveHits(match: Double, alive: (Int) -> Bool) -> [Int] {
        for (id, until) in recentHits where until < match || !alive(id) { recentHits[id] = nil }
        return recentHits.keys.sorted()
    }

    /// Per frame: death edge (`diedAt` on the match clock), and the eased CSS transitions.
    func step(state: HUDState, wall: Double) {
        let isDead = state.health <= 0 && !state.loading
        if isDead && !dead {
            diedAt = state.now
            deadSince = wall
        }
        dead = isDead
        let dt = lastWall.map { max(0, min(0.25, wall - $0)) } ?? 10
        lastWall = wall
        let clamped = min(100, max(0, state.health))
        let effects = HUDMath.healthEffects(clamped)
        vignette = approach(vignette, effects.vignette, dt / 0.3)
        dim = approach(dim, isDead ? 0.5 : 0, dt / 0.3)
        reload = approach(reload, state.reloading && state.health > 0 ? 1 : 0, dt / 0.12)
        let crossOn = state.crosshairSetting && state.health > 0 && !aiming && !state.scopedIn
        cross = approach(cross, crossOn ? 1 : 0, dt / 0.12)
        healthFill = approach(healthFill, clamped / 100, dt / 0.15)
        track(yaw: state.yaw, wall: wall)
    }

    private func approach(_ value: Double, _ target: Double, _ step: Double) -> Double {
        value < target ? min(target, value + step) : max(target, value - step)
    }

    /// When a feed row first showed (wall time), remembered per kill.
    func feedStart(_ key: String, wall: Double) -> Double {
        if let start = feedShown[key] { return start }
        feedShown[key] = wall
        if feedShown.count > 32 { feedShown = feedShown.filter { wall - $0.value < 10 } }
        return wall
    }
}

/// CSS timing functions for the WAAPI and transition curves the HUD uses.
enum Easing {
    /// `cubic-bezier(x1, y1, x2, y2)` at progress `t`.
    static func cubicBezier(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ t: Double) -> Double {
        if t <= 0 { return 0 }
        if t >= 1 { return 1 }
        func bez(_ a: Double, _ b: Double, _ s: Double) -> Double { 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s }
        var lo = 0.0, hi = 1.0, s = t
        for _ in 0..<40 {
            s = (lo + hi) / 2
            if bez(x1, x2, s) < t { lo = s } else { hi = s }
        }
        return bez(y1, y2, s)
    }

    /// `--ease`: cubic-bezier(0.2, 0, 0, 1).
    static func ease(_ t: Double) -> Double { cubicBezier(0.2, 0, 0, 1, t) }
    /// CSS `ease-out`.
    static func easeOut(_ t: Double) -> Double { cubicBezier(0, 0, 0.58, 1, t) }

    /// Linear keyframes `(offset, value)` sampled at `t`.
    static func keyframes(_ frames: [(Double, Double)], _ t: Double) -> Double {
        guard let first = frames.first else { return 0 }
        if t <= first.0 { return first.1 }
        for (a, b) in zip(frames, frames.dropFirst()) where t <= b.0 {
            return a.1 + (b.1 - a.1) * (t - a.0) / max(b.0 - a.0, 1e-9)
        }
        return frames.last!.1
    }
}
