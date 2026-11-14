// Ported from src/net/proxies.ts at commit cbe0add.
//
// A guest's stand-ins for the host's bots: remote combatants that follow the host's snapshots. In
// co-op they are enemies on team bravo; a duel bot is on whichever side the host put it. Hits on
// them are forwarded to the host through `onDamage`; they fall when the host says so. They are
// SoldierActors, so the renderer draws them from the frame's SoldierDrawList like the other player.
import IronvaleSim
import IronvaleWorld
import struct IronvaleWire.BotState
import enum IronvaleWire.WeaponID

public final class BotProxies {
    /// Bots arrive 12 times a second, so they are shown further in the past than the other player.
    public static let botDelayMs: Double = 170
    public static let maxExtrapolationMs: Double = 250
    public static let corpseSeconds: Double = 20
    public static let maxProxies = 96
    /// Bots run above this speed; it picks the louder footstep.
    public static let botRunSpeed = 4.5

    private var byWire: [Int: RemoteSoldier] = [:]
    /// Wire ids in arrival order, so iteration matches the web's Map order.
    private var order: [Int] = []
    private var byLocal: [Int: RemoteSoldier] = [:]
    private let game: Game
    private let onDamage: (RemoteSoldier, DamageInfo) -> Void
    private let team: Team
    private let uniform: Team

    public init(game: Game, team: Team = .bravo, uniform: Team = .bravo, onDamage: @escaping (RemoteSoldier, DamageInfo) -> Void) {
        self.game = game
        self.team = team
        self.uniform = uniform
        self.onDamage = onDamage
    }

    public var alive: Int { byWire.values.reduce(0) { $0 + ($1.alive ? 1 : 0) } }
    public func get(_ wire: Int) -> RemoteSoldier? { byWire[wire] }
    /// By this machine's combat id.
    public func local(_ id: Int) -> RemoteSoldier? { byLocal[id] }
    public var all: [RemoteSoldier] { order.compactMap { byWire[$0] } }

    public func spawn(id wire: Int, name: String, weapon: WeaponID, p: SIMD3<Double>, yaw: Double) {
        guard byWire[wire] == nil, byWire.count < Self.maxProxies else { return }
        let game = game
        let proxy = RemoteSoldier(
            options: .init(id: game.combat.allocateId(), wireId: wire, team: team, uniform: uniform, name: name, weapon: weapon,
                           delayMs: Self.botDelayMs, maxExtrapolationMs: Self.maxExtrapolationMs, deriveVelocity: true,
                           onDamage: onDamage),
            events: game.events, world: { [weak game] in game?.map?.world })
        proxy.place(x: p.x, y: p.y, z: p.z, yaw: yaw)
        byWire[wire] = proxy
        order.append(wire)
        byLocal[proxy.id] = proxy
        game.combat.add(proxy)
        game.events.emit(.spawned(combatantId: proxy.id))
    }

    /// A snapshot from the host. `time` is on this machine's clock. Bots nobody announced are ignored.
    public func push(time: Double, bots: [BotState]) {
        for bot in bots {
            guard let proxy = byWire[bot.id] else { continue }
            proxy.push(InterpSnapshot(time: time, epoch: 0, pose: InterpPose(x: bot.x, y: bot.y, z: bot.z, vx: 0, vy: 0, vz: 0, yaw: bot.yaw, pitch: bot.pitch)),
                       flags: RemoteFlags(crouching: bot.crouching, aiming: bot.aiming, reloading: bot.reloading,
                                          running: bot.speed > Self.botRunSpeed, onGround: true, alive: bot.alive, health: 100,
                                          weapon: bot.weapon),
                       life: 0)
        }
    }

    public func update(_ dt: Double, now: Double) {
        for wire in order {
            guard let proxy = byWire[wire] else { continue }
            proxy.update(dt, now: now)
            if !proxy.alive, proxy.corpseTime > Self.corpseSeconds { retire(wire) }
        }
    }

    /// Take every stand-in out of the world. Returns how many were alive.
    @discardableResult
    public func clear() -> Int {
        let count = alive
        for wire in order { retire(wire) }
        return count
    }

    private func retire(_ wire: Int) {
        guard let proxy = byWire.removeValue(forKey: wire) else { return }
        order.removeAll { $0 == wire }
        byLocal[proxy.id] = nil
        game.combat.remove(proxy.id)
    }
}
