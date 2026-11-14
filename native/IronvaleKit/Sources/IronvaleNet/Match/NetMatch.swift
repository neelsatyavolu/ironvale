// Ported from the match half of src/net/session.ts at commit cbe0add (beginMatch, enterMap,
// matchLoaded, leaveMap, pickSpawn, applyLoss, update): joins a NetLobbySession to a running Game.
// The lobby half stays in NetLobbySession. The co-op parts (authority, partner, reportMatch) are in
// NetMatch+Coop.swift (M7b); a co-op guest that loses its host takes the remaining enemies over.
import Foundation
import IronvaleContract
import IronvaleCore
import IronvaleMapData
import IronvaleSim
import IronvaleWorld
import enum IronvaleWire.BinaryMessage
import enum IronvaleWire.NetEvent
import struct IronvaleWire.NetMatchConfig

@MainActor
public final class NetMatch: @MainActor GameNet, @MainActor ActorSource {
    /// Capsule the size of the player, for checking a spot beside a shared spawn.
    static let bodyRadius = 0.34
    static let bodyHeight = 1.8
    static let sideStep = 1.6

    public private(set) var session: NetLobbySession!
    public private(set) var sync: MatchSync?
    public private(set) var config: NetMatchConfig?
    public private(set) var role: PeerRole = .host
    /// Called when a match must be loaded: load the map and call `game.start`. Returns false on failure.
    public var startGame: (MatchConfig) -> Bool = { _ in false }
    /// Diagnostics: one line per notable step, and every rule an incoming message broke.
    public var log: (String, [String: String]) -> Void = { _, _ in }

    private let game: Game
    private var beginning = false
    private(set) var localLoaded = false
    private var lossApplied = false
    /// Co-op host: the last `match` report and when it went out (NetMatch+Coop.swift).
    var lastReport = ""
    var lastReportAt = -Double.infinity
    /// Co-op guest whose host left: this machine now runs the match (`lossNotice === 'took-over'`).
    public private(set) var tookOver = false

    public init(game: Game, relay: RelayClient?, makeLink: @escaping PeerLinkFactory, localName: String,
                knownMaps: Set<String>, extraIceServers: [IceServer] = []) {
        self.game = game
        let hooks = MatchHooks(
            knownMaps: { knownMaps },
            beginMatch: { [weak self] config, role in self?.beginMatch(config, role: role) },
            matchEvent: { [weak self] event, now in self?.sync?.handleEvent(event, now: now) },
            matchBinary: { [weak self] message, now in self?.sync?.handleBinary(message, now: now) },
            chat: { [weak self] name, text, mine in self?.log("chat", ["name": name, "text": text, "mine": "\(mine)"]) }
        )
        session = NetLobbySession(relay: relay, makeLink: makeLink, hooks: hooks, localName: localName, extraIceServers: extraIceServers)
        game.net = self
    }

    // MARK: - GameNet

    public var inMatch: Bool { session.inMatch }
    public var frozen: Bool { session.frozen }
    public var partnerId: Int? {
        guard let sync, session.inMatch else { return nil }
        return sync.remote.id
    }

    public func enterMap() {
        guard let config, session.inMatch else { return }
        sync?.dispose()
        let created = MatchSync(game: game, hooks: MatchSyncHooks(endMatch: { [weak self] in self?.game.endMatch($0 == .won ? .won : .lost) },
                                                                  waveStarted: { [weak self] in self?.game.reinforce() }),
                                link: session, role: role, config: config, peerName: session.state.peerName)
        created.onReject = { [weak self] reason in self?.log("reject", ["reason": reason]) }
        sync = created
        session.attachMatch()
    }

    public func matchLoaded() {
        guard config != nil else { return }
        localLoaded = true
        session.matchLoaded()
        log("loaded", ["map": config?.mapId ?? ""])
    }

    public func leaveMap() {
        sync?.dispose()
        sync = nil
        if beginning || config == nil { return }
        config = nil
        localLoaded = false
        session.leaveMatch()
    }

    public func pickSpawn(initial: Bool) -> (position: Vec3, yaw: Double)? {
        guard let config, !session.peerGone, let map = game.map else { return nil }
        let spawns = map.meta.spawns
        if config.mode == .duel {
            let all = spawns.player + spawns.enemy
            guard let first = all.first else { return nil }
            if initial, role == .host { return (first.point, first.yaw) }
            // The guest starts as far from the host's start as the map allows; after that, as far from the opponent.
            let opponent = initial || sync == nil ? first.point : sync!.remote.position
            let index = DuelRules.pickDuelSpawn(all.map { ($0.point.x, $0.point.z) }, opponent: (opponent.x, opponent.z))
            let pick = index >= 0 ? all[index] : first
            return (pick.point, pick.yaw)
        }
        if !initial || role == .host { return nil }
        if spawns.player.count > 1 { return (spawns.player[1].point, spawns.player[1].yaw) }
        guard let first = spawns.player.first else { return nil }
        // One shared spawn: stand beside the host, on whichever side has room.
        let sideX = cos(first.yaw), sideZ = -sin(first.yaw)
        for step in [Self.sideStep, -Self.sideStep] {
            let position = Vec3(first.point.x + sideX * step, first.point.y + 0.05, first.point.z + sideZ * step)
            if map.world.capsuleFits(position: position, radius: Self.bodyRadius, height: Self.bodyHeight) { return (position, first.yaw) }
        }
        return (first.point, first.yaw)
    }

    public func update(_ dt: Double, running: Bool) {
        sync?.update(dt, now: NetClock.now(), running: running)
        session.update(running: running)
        if session.peerGone, localLoaded, !lossApplied { applyLoss() }
    }

    // MARK: - match start and loss

    private func beginMatch(_ netConfig: NetMatchConfig, role: PeerRole) {
        let duel = netConfig.mode == .duel
        let mode: MatchConfig.Mode = duel ? .duel : .coop
        let rules: MatchConfig.Rules = netConfig.rules == .survival ? .survival : .skirmish
        var matchConfig = MatchConfig(mapId: netConfig.mapId, mode: mode, difficulty: netConfig.difficulty.rawValue,
                                      botCount: duel ? DuelRules.duelBotsHere(netConfig.duelBot, role: role) : netConfig.botCount,
                                      rules: duel ? nil : rules, killTarget: netConfig.killTarget)
        // A duel bot fights for its owner: alpha on the owner's machine, and wears the owner's uniform.
        if duel, netConfig.duelBot != .none {
            let side = DuelRules.duelBotSide(owner: netConfig.duelBot, role: role)
            matchConfig.botTeam = side.team
            matchConfig.botUniform = side.uniform
        }
        config = netConfig
        self.role = role
        localLoaded = false
        lossApplied = false
        tookOver = false
        lastReport = ""
        lastReportAt = -.infinity
        log("begin", ["map": netConfig.mapId, "mode": netConfig.mode.rawValue, "role": role.rawValue, "killTarget": "\(netConfig.killTarget)"])
        beginning = true
        let ok = startGame(matchConfig)
        beginning = false
        if !ok {
            log("loadFailed", ["map": netConfig.mapId])
            config = nil
            session.send(.bye(.left))
            session.leave()
        }
    }

    /// Carry out what losing the other player means for the loaded match.
    private func applyLoss() {
        lossApplied = true
        guard let config else { return }
        log("peerLost", ["error": session.state.error?.rawValue ?? ""])
        if config.mode == .duel {
            sync?.dropRemote()
            game.endMatch(game.kills >= game.deaths ? .won : .lost)
        } else if role == .host {
            sync?.dropRemote()
        } else {
            // Co-op guest: run the enemies the host had left here and carry on alone (`takeOver`).
            let wave = sync?.hostMatch?.wave ?? 0
            let enemies = sync.map { $0.dropProxies() } ?? config.botCount
            sync?.dropRemote()
            tookOver = true
            log("tookOver", ["enemies": "\(enemies)", "wave": "\(wave)"])
            game.takeOver(enemies: enemies, wave: wave)
        }
    }

    /// The other player and any bot stand-ins, for the frame's SoldierDrawList.
    public var actors: [SoldierActor] {
        guard let sync, !sync.isRemoteGone || sync.proxiesAlive > 0 else { return [] }
        return ([sync.isRemoteGone ? nil : sync.remote] + sync.proxies.all).compactMap { $0?.actor }
    }

    public func dispose() {
        sync?.dispose()
        sync = nil
        session.dispose()
        if game.net === self { game.net = nil }
    }
}
