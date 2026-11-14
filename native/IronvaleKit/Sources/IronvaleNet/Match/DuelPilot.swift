// The native player's side of the layer 4 duel scenario (PLAN.md 5.4 layer 4, M6): an input
// source for a two-player duel that takes turns with the web page, so every kill goes in a known
// direction and both machines' scores can be checked against each other.
//
// Turns: on an even kill total (kills + deaths here) the web player hunts this one; on an odd total
// this player hunts the web player. Hunting is what `hunt` in scripts/dev/net-lib.mjs does without
// the teleport: the web harness walks its player to within a few metres of this one, and the pilot
// turns to the other player's chest, aims down the sights and holds the trigger (reloading when the
// magazine runs dry) until the other player falls. It never moves, so the web side always knows
// where to find it. The look is set directly (yaw and pitch), as `hunt` does; everything else goes
// through the same bindings as the keyboard and mouse.
import Foundation
import IronvaleSim
import IronvaleWorld

@MainActor
public final class DuelPilot {
    /// Hunt only a target this close, in clear view.
    public static let reach = 20.0
    static let chestStand = 1.25

    private let game: Game
    private let match: NetMatch
    private let bindings: [String: [String]]

    public init(game: Game, match: NetMatch) {
        self.game = game
        self.match = match
        bindings = game.data.constants.input.bindings["mouse"] ?? [:]
    }

    /// This player's turn to hunt: an odd kill total.
    public var hunting: Bool { (game.kills + game.deaths) % 2 == 1 }

    /// The last frame aimed at the other player and held the trigger.
    public private(set) var aimingAtRemote = false

    /// The device state for the next frame.
    public func next() -> InputFrame {
        aimingAtRemote = false
        var frame = InputFrame(locked: true)
        guard game.phase == .playing, !match.frozen, game.player.alive, hunting,
              let sync = match.sync, !sync.isRemoteGone, sync.remote.alive, let world = game.map?.world else { return frame }
        let player = game.player
        let eye = player.eyePosition()
        let target = sync.remote.position
        let chest = Vec3(target.x, target.y + (sync.remote.crouching ? 0.8 : Self.chestStand), target.z)
        let dx = chest.x - eye.x, dy = chest.y - eye.y, dz = chest.z - eye.z
        let flat = (dx * dx + dz * dz).squareRoot()
        guard flat < Self.reach, world.lineOfSight(eye, chest) else { return frame }
        player.yaw = atan2(-dx, -dz)
        player.pitch = atan2(dy, flat)
        frame.held = Set(codes("aim") + codes("fire"))
        aimingAtRemote = true
        if game.weapons.current.magazine == 0 { frame.pressed = Set(codes("reload")) }
        return frame
    }

    private func codes(_ action: String) -> [String] { Array((bindings[action] ?? []).prefix(1)) }
}
