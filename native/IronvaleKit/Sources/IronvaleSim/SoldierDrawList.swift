// The soldiers this machine shows this frame (PLAN.md 7, M7a: "renders the remote player and bot
// proxies"). Built each frame from the game's actor sources: the bots (`Game.bots`, IronvaleAI) and
// the two-player match (IronvaleNet NetMatch: the other player and a co-op guest's bot stand-ins),
// so local bots, remote players and proxies all reach the renderer the same way.

/// Every soldier to draw this frame, in source order.
public struct SoldierDrawList: Sendable, Equatable {
    public var soldiers: [SoldierActor]

    public init(soldiers: [SoldierActor] = []) { self.soldiers = soldiers }

    public static func build(from sources: [(any ActorSource)?]) -> SoldierDrawList {
        SoldierDrawList(soldiers: sources.flatMap { $0?.actors ?? [] })
    }
}
