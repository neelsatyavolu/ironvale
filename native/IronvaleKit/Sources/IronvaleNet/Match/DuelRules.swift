// Ported from src/net/rules.ts at commit cbe0add: small pure pieces of the two-player rules.
import Foundation
import enum IronvaleSim.Team
import enum IronvaleWire.DuelBot

public enum DuelRules {
    /// Index of the spawn furthest from the opponent (`Math.hypot` on x and z), or -1 when there are none.
    /// Ties keep the earlier spawn.
    public static func pickDuelSpawn(_ spawns: [(x: Double, z: Double)], opponent: (x: Double, z: Double)) -> Int {
        var best = -1
        var bestDistance = -1.0
        for (index, spawn) in spawns.enumerated() {
            let distance = hypot(spawn.x - opponent.x, spawn.z - opponent.z)
            if distance > bestDistance {
                bestDistance = distance
                best = index
            }
        }
        return best
    }

    public enum Result: String, Sendable { case won, lost }

    /// A duel ends when either player reaches the kill target.
    public static func duelResult(kills: Int, deaths: Int, killTarget: Int) -> Result? {
        if kills >= killTarget { return .won }
        if deaths >= killTarget { return .lost }
        return nil
    }

    /// Team and uniform of a duel bot on one machine: alpha where its owner is the local player;
    /// it wears its owner's uniform, the host's alpha, the guest's bravo.
    public static func duelBotSide(owner: DuelBot, role: PeerRole) -> (team: Team, uniform: Team) {
        let ownerRole: PeerRole = owner == .host ? .host : .guest
        return (ownerRole == role ? .alpha : .bravo, owner == .host ? .alpha : .bravo)
    }

    /// Bots this machine runs in a duel: the host runs the one bot, whichever player it fights for.
    public static func duelBotsHere(_ duelBot: DuelBot, role: PeerRole) -> Int {
        duelBot != .none && role == .host ? 1 : 0
    }
}
