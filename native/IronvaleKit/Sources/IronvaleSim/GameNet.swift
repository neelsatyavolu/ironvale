// What the game loop needs from a two-player session (`NetSystem` in src/net/api.ts at commit
// cbe0add, the parts `Game` calls). IronvaleNet's NetMatch implements it; nil when playing alone.
import IronvaleWorld

public protocol GameNet: AnyObject {
    /// Connected to the other player with a match loading or under way. The simulation never pauses while this is true.
    var inMatch: Bool { get }
    /// Nobody may move or shoot yet (waiting for the other player, or the countdown).
    var frozen: Bool { get }
    /// The other player's combat id on this machine, while they are connected.
    var partnerId: Int? { get }
    /// The map is loaded and the local player is registered: bring the other player in.
    func enterMap()
    /// The local player is placed and the match is ready to run.
    func matchLoaded()
    func leaveMap()
    /// Where the local player should appear, or nil for the game's own choice.
    func pickSpawn(initial: Bool) -> (position: Vec3, yaw: Double)?
    /// Every frame. `running` is true while the match simulation is advancing.
    func update(_ dt: Double, running: Bool)

    // M7b, co-op (`NetSystem` authority, partner, partnerKills, hostMatch, reportMatch in src/net/api.ts).
    /// This machine runs the bots, waves and result: false only for a co-op guest while the host is there.
    var authority: Bool { get }
    /// The other player as the rules see them, while connected.
    var partner: NetPartner? { get }
    /// Bot kills by the other player this match (co-op).
    var partnerKills: Int { get }
    /// What the co-op host last reported (wave, enemies alive); nil on the authority.
    var hostMatch: (wave: Int, enemies: Int)? { get }
    /// The co-op host's match state for the guest; sent when something changed (and twice a second).
    func reportMatch(wave: Int, enemies: Int, result: GamePhase?, localKills: Int)
}

/// The other player as the match rules see them (`NetPartner`).
public struct NetPartner: Sendable, Equatable {
    public let id: Int
    public let alive: Bool
    public let deaths: Int
    public init(id: Int, alive: Bool, deaths: Int) {
        self.id = id
        self.alive = alive
        self.deaths = deaths
    }
}

/// Defaults: a session without co-op support behaves like playing alone.
public extension GameNet {
    var authority: Bool { true }
    var partner: NetPartner? { nil }
    var partnerKills: Int { 0 }
    var hostMatch: (wave: Int, enemies: Int)? { nil }
    func reportMatch(wave: Int, enemies: Int, result: GamePhase?, localKills: Int) {}
}
