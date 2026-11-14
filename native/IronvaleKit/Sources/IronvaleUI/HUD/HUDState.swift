// Everything one HUD frame shows, as plain values: what `createHud` in src/ui/hud/hud.ts reads from a
// `MatchSnapshot`, the settings and its own event state. `GameHUD` fills it from a running `Game`;
// tests build it by hand.
import Foundation

public struct HUDState: Sendable {
    public enum Rules: String, Sendable { case skirmish, survival, duel }

    /// Shown while a match is on screen (playing, or paused with the menu over it).
    public var visible = false
    /// Viewport in points and pixels per point.
    public var width = 1280.0
    public var height = 800.0
    public var pointScale = 2.0
    /// Match clock, seconds (`ctx.time`, stops on pause).
    public var now = 0.0

    // Settings (gameplay.crosshair, showHitMarkers, minimap) and the perf toggle.
    public var crosshairSetting = true
    public var minimapSetting = true
    public var perfVisible = false
    public var perfText = ""

    // Status figures.
    public var rules = Rules.skirmish
    public var coop = false
    public var enemiesRemaining = 0
    public var wave = 0
    public var livesRemaining = 0
    public var net: Net?

    public struct Net: Sendable, Equatable {
        public var localName: String
        public var peerName: String
        public var peerKills: Int
        public var killTarget: Int
        /// Whole seconds before a two-player match starts; 0 once it runs.
        public var countdown: Int
        public var notice: String
        public var peerConnected: Bool

        public init(localName: String, peerName: String, peerKills: Int = 0, killTarget: Int = 10, countdown: Int = 0,
                    notice: String = "", peerConnected: Bool = true) {
            self.localName = localName
            self.peerName = peerName
            self.peerKills = peerKills
            self.killTarget = killTarget
            self.countdown = countdown
            self.notice = notice
            self.peerConnected = peerConnected
        }
    }

    public var kills = 0
    public var health = 100.0
    public var magazine = 0
    public var reserve = 0
    public var weaponName = ""
    /// `semi`, `auto` or `bolt`; empty for none.
    public var fireMode = ""
    public var reloading = false
    public var scopedIn = false
    public var aiming = false
    public var grenades = 0
    public var grenadeAiming = false
    /// Display name of the grenade key under the current preset (`keyName`).
    public var grenadeKey = "G"
    public var loading = false

    /// Player yaw (radians, 0 looks down -Z), position, and the camera's vertical FOV and aspect, for the minimap and arcs.
    public var yaw = 0.0
    public var position = SIMD3<Double>(0, 0, 0)
    public var fovDegrees = 75.0
    public var aspect = 1.6

    /// Living enemies and the partner, for the minimap.
    public var enemies: [Marker] = []
    public var partner: Marker?
    public var duel = false

    public struct Marker: Sendable, Equatable {
        public var id: Int
        public var position: SIMD3<Double>
        public init(id: Int, position: SIMD3<Double>) {
            self.id = id
            self.position = position
        }
    }

    /// Two-player chat (src/ui/hud/chat.ts): shown in a connected two-player match; lines newer than LINE_SECONDS.
    public var chatEnabled = false
    public var chatInputOpen = false
    public var chatLines: [ChatLine] = []

    public struct ChatLine: Sendable, Equatable {
        public var name: String
        public var text: String
        public var mine: Bool
        public init(name: String, text: String, mine: Bool) {
            self.name = name
            self.text = text
            self.mine = mine
        }
    }

    /// The local player's combat name; the feed says "You" for it.
    public var localName = "You"

    /// Health bars over recently hit enemies, already projected: point on screen (points) and health 0-100.
    public var enemyBars: [(x: Double, y: Double, health: Double)] = []

    public init() {}
}

/// The web HUD's palette (base.css and the HUD's own tokens).
public enum HUDPalette {
    public static let ink = HUDColor(hex: 0xF2F0EA)
    public static let dim = HUDColor(242 / 255, 240 / 255, 234 / 255, 0.8)
    public static let shade = HUDColor(9 / 255, 9 / 255, 8 / 255, 0.5)
    public static let warn = HUDColor(hex: 0xD9A23A)
    public static let danger = HUDColor(hex: 0xEE5A4B)
    public static let accent = HUDColor(hex: 0x4C8DFF)
    public static let dark = HUDColor(9 / 255, 9 / 255, 8 / 255, 1)
}
