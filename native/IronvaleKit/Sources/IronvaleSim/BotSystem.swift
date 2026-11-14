// The bot hook of the match loop (`BotSystem` in src/game/contracts.ts at commit cbe0add) and the
// actor list the renderer draws soldiers from. IronvaleAI implements `BotSystem` (BotManager);
// IronvaleSim cannot import it, so `Game.bots` is set by whoever composes the game. A co-op guest's
// stand-ins for the host's bots (IronvaleNet) publish themselves through `ActorSource` as well.
import IronvaleMapData
import IronvaleWorld

/// One third-person soldier as the renderer should pose it this frame (what `Bot.syncVisual` and
/// `RemoteSoldier` hand `SoldierVisual.setState`, plus the transform and the one-shot reactions).
public struct SoldierActor: Sendable, Equatable {
    public let id: Int
    public let kind: CombatantKind
    public let team: Team
    /// Uniform tint (`TEAM_TINT`): the side the body is dressed as, which a duel bot takes from its owner.
    public let uniform: Team
    public var position: Vec3
    /// Radians, 0 faces -Z.
    public var yaw: Double
    /// Aim pitch in radians, up positive.
    public var pitch: Double
    public var speed: Double
    public var crouching: Bool
    public var aiming: Bool
    public var firing: Bool
    public var reloading: Bool
    public var alive: Bool
    /// Direction the fatal hit travelled, once dead (`SoldierVisual.die`).
    public var deathDirection: Vec3?
    /// Counts non-fatal hits taken (`SoldierVisual.flinch`); the renderer flinches when it grows.
    public var hits: Int
    public var lastHitZone: HitZone?
    /// Counts revivals; a change means the visual must `revive()` (pooled bodies are reused).
    public var life: Int

    public init(id: Int, kind: CombatantKind, team: Team, uniform: Team, position: Vec3, yaw: Double, pitch: Double = 0,
                speed: Double = 0, crouching: Bool = false, aiming: Bool = false, firing: Bool = false, reloading: Bool = false,
                alive: Bool = true, deathDirection: Vec3? = nil, hits: Int = 0, lastHitZone: HitZone? = nil, life: Int = 0) {
        self.id = id
        self.kind = kind
        self.team = team
        self.uniform = uniform
        self.position = position
        self.yaw = yaw
        self.pitch = pitch
        self.speed = speed
        self.crouching = crouching
        self.aiming = aiming
        self.firing = firing
        self.reloading = reloading
        self.alive = alive
        self.deathDirection = deathDirection
        self.hits = hits
        self.lastHitZone = lastHitZone
        self.life = life
    }
}

/// Anything that contributes soldiers to draw.
public protocol ActorSource: AnyObject {
    var actors: [SoldierActor] { get }
}

/// The bots of a match (`BotSystem` in contracts.ts).
public protocol BotSystem: ActorSource {
    /// Builds the navigation grid for the map. Runs on every machine (the minimap reads it, and a
    /// co-op guest may have to take the bots over).
    func enterMap(_ map: MapPackage)
    func leaveMap()
    func spawn(count: Int, team: Team, difficulty: String)
    var alive: Int { get }
    func update(_ dt: Double)
}
