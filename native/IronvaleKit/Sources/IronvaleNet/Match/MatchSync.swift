// Ported from src/net/match.ts at commit cbe0add.
//
// Keeps one match in step with the other machine: sends this player's state, shots and hits, shows
// the other player (and, for a co-op guest, the host's bots) and replays what they do as ordinary
// game events. Same order of work as the web: shots and deaths gathered during a frame are flushed
// at the start of the next `update`, state goes out at 30 Hz and bot snapshots at 12 Hz.
//
// Native addition: `onReject` reports every incoming message the web's MatchSync would also drop
// for breaking a rule (rate gate, damage cap, an actor the peer may not speak for), so the layer 4
// harness can assert there were none. Drops that are part of normal play (a hit on a body that is
// already down, a repeated death) are not reported.
import Foundation
import IronvaleContract
import IronvaleCore
import IronvaleSim
import IronvaleWorld
import enum IronvaleWire.BinaryCodec
import enum IronvaleWire.BinaryMessage
import struct IronvaleWire.BotState
import enum IronvaleWire.DamageSource
import enum IronvaleWire.DamageCap
import enum IronvaleWire.NetEvent
import struct IronvaleWire.NetMatchConfig
import struct IronvaleWire.PlayerState
import struct IronvaleWire.ShotMessage
import struct IronvaleWire.TokenBucket
import enum IronvaleWire.Wire
import enum IronvaleWire.WeaponActionStage
import struct IronvaleWire.WeaponGate
import enum IronvaleWire.WeaponID

/// What MatchSync sends through (`MatchLink`).
@MainActor
public protocol MatchLink: AnyObject {
    var clock: ClockSync { get }
    func sendState(_ bytes: [UInt8])
    func send(_ event: NetEvent)
    func sendShot(_ bytes: [UInt8])
}

extension NetLobbySession: MatchLink {}

/// What the match needs the game to do (`NetGameHooks`, the match parts).
public struct MatchSyncHooks {
    public var endMatch: (DuelRules.Result) -> Void
    public var waveStarted: () -> Void
    public init(endMatch: @escaping (DuelRules.Result) -> Void = { _ in }, waveStarted: @escaping () -> Void = {}) {
        self.endMatch = endMatch
        self.waveStarted = waveStarted
    }
}

@MainActor
public final class MatchSync {
    public static let stateInterval = 1.0 / 30
    public static let botInterval = 1.0 / 12
    /// The other player is shown this far in the past, so there are always two snapshots to blend.
    public static let playerDelayMs: Double = 100
    public static let maxExtrapolationMs: Double = 250
    /// State older than this on arrival is not worth showing.
    public static let staleMs: Double = 2000
    public static let nearMissRadius = 1.2
    static let nobody = -1
    /// A thrown grenade may start this far from where the thrower is shown here.
    public static let grenadeReach = 8.0
    /// Slack on the throw speed for rounding on the wire.
    public static let grenadeSpeedSlack = 1.05

    private struct PendingShot {
        let shooterId: Int
        var message: ShotMessage
    }

    private struct PendingDeath {
        let victimId: Int
        let killerId: Int
        let weapon: DamageSource
        let headshot: Bool
    }

    public let remote: RemoteSoldier
    /// Deaths of the other player this match.
    public private(set) var partnerDeaths = 0
    /// Bot kills by the other player this match.
    public private(set) var partnerKills = 0
    /// Guest: the host's latest word on waves and enemies.
    public private(set) var hostMatch: (wave: Int, enemies: Int)?
    /// Local clock time the last state arrived from the other player.
    public var lastStateAt = Double.infinity
    /// Guest: stand-ins for the host's bots. Empty on a host and in a duel without a bot.
    public private(set) var proxies: BotProxies!
    /// An incoming message broke a rule and was dropped (see the header).
    public var onReject: (String) -> Void = { _ in }

    private let game: Game
    private let hooks: MatchSyncHooks
    private let link: MatchLink
    private let role: PeerRole
    private let coop: Bool
    /// The host runs bots the guest is shown: every co-op match, and a duel where a player has a bot.
    private let hostBots: Bool
    private let myWire: Int
    private let peerWire: Int
    private var gates: [Int: WeaponGate] = [:]
    private var actionGate = TokenBucket(perSecond: 30, size: 30)
    /// Hits the other player's grenades may report this match. Never refilled.
    private var blastGate: TokenBucket
    private let grenadesPerMatch: Int
    private let maxThrowSpeed: Double
    private var peerGrenades = 0
    private var unsubscribe: [() -> Void] = []
    private var fatalDirections: [Int: Vec3] = [:]
    private var lastHurt = Vec3(0, 0, -1)
    private var pendingShot: PendingShot?
    private var pendingDeaths: [PendingDeath] = []
    private var remoteGone = false
    private var life = 0
    private var seq = 0
    private var botSeq = 0
    private var stateTimer = 0.0
    private var botTimer = 0.0
    private var lastPeerDeathLife = -1

    public init(game: Game, hooks: MatchSyncHooks, link: MatchLink, role: PeerRole, config: NetMatchConfig, peerName: String) {
        self.game = game
        self.hooks = hooks
        self.link = link
        self.role = role
        coop = config.mode == .coop
        let duelBot = config.mode == .duel ? config.duelBot : .none
        hostBots = coop || duelBot != .none
        myWire = role == .host ? Wire.host : Wire.guest
        peerWire = role == .host ? Wire.guest : Wire.host
        grenadesPerMatch = game.data.constants.grenadeHand.GRENADES_PER_MATCH
        maxThrowSpeed = game.data.grenade.throwSpeed * Self.grenadeSpeedSlack
        blastGate = TokenBucket(perSecond: 0, size: Double((Self.maxNetBots + 2) * grenadesPerMatch))
        // In a duel the opponent is the other side on both machines. The uniform still tells them
        // apart the same way for both: the host wears alpha, the guest bravo.
        let team: Team = coop ? .alpha : .bravo
        let uniform: Team = coop ? .alpha : role == .host ? .bravo : .alpha
        var forward: ((RemoteSoldier, DamageInfo) -> Void)?
        remote = RemoteSoldier(
            options: .init(id: game.combat.allocateId(), wireId: peerWire, team: team, uniform: uniform, name: peerName, weapon: .m4a1,
                           delayMs: Self.playerDelayMs, maxExtrapolationMs: Self.maxExtrapolationMs, deriveVelocity: false,
                           onDamage: { forward?($0, $1) }),
            events: game.events, world: { [weak game] in game?.map?.world })
        game.combat.add(remote)
        let side = duelBot == .none ? (team: Team.bravo, uniform: Team.bravo) : DuelRules.duelBotSide(owner: duelBot, role: role)
        proxies = BotProxies(game: game, team: side.team, uniform: side.uniform) { forward?($0, $1) }
        forward = { [weak self] target, info in self?.forwardDamage(target, info) }
        unsubscribe = [game.events.on { [weak self] event in
            MainActor.assumeIsolated { self?.observe(event) }
        }]
    }

    static let maxNetBots = 32

    public var proxiesAlive: Int { proxies.alive }

    // MARK: - per frame

    /// `running` is false once the match is over: what is already decided still goes out, nothing new is sent.
    public func update(_ dt: Double, now: Double, running: Bool) {
        flush()
        if !running { return }
        if !remoteGone { remote.update(dt, now: now) }
        proxies.update(dt, now: now)
        if remoteGone { return }
        stateTimer += dt
        if stateTimer >= Self.stateInterval {
            stateTimer = min(stateTimer - Self.stateInterval, Self.stateInterval)
            link.sendState(BinaryCodec.encodeState(localState(now: now)))
        }
        if role == .host, hostBots {
            botTimer += dt
            if botTimer >= Self.botInterval {
                botTimer = min(botTimer - Self.botInterval, Self.botInterval)
                sendBots(now: now)
            }
        }
    }

    /// Send the shots and deaths gathered since the last frame.
    public func flush() {
        flushShot()
        flushDeaths()
    }

    private func localState(now: Double) -> PlayerState {
        let player = game.player
        let weapons = game.weapons
        defer { seq += 1 }
        return PlayerState(
            seq: seq & 0xFFFF, time: now,
            x: player.position.x, y: player.position.y, z: player.position.z,
            vx: player.velocity.x, vy: player.velocity.y, vz: player.velocity.z,
            yaw: player.yaw, pitch: player.pitch,
            crouching: player.crouching, sprinting: player.sprinting, aiming: weapons.aimBlend > 0.5,
            alive: player.alive, onGround: player.onGround, reloading: weapons.current.reloading,
            weapon: WeaponID(rawValue: weapons.current.def.id) ?? .m4a1,
            health: player.health, life: life)
    }

    private func sendBots(now: Double) {
        let bots: [BotState] = game.combat.all().compactMap { combatant in
            guard combatant.kind == .bot, let bot = combatant as? any NetBotView else { return nil }
            return BotState(id: bot.id + Wire.botBase, x: bot.position.x, y: bot.position.y, z: bot.position.z,
                            yaw: bot.yaw, pitch: bot.pitch, speed: bot.speed, crouching: bot.crouching,
                            aiming: bot.watchingEnemy, reloading: bot.reloading, alive: bot.alive,
                            weapon: WeaponID(rawValue: bot.weaponId) ?? .m4a1)
        }
        var from = 0
        repeat {
            let slice = Array(bots[min(from, bots.count)..<min(from + Wire.maxBotsPerSnapshot, bots.count)])
            link.sendState(BinaryCodec.encodeBots(seq: botSeq & 0xFFFF, time: now, bots: slice))
            botSeq += 1
            from += Wire.maxBotsPerSnapshot
        } while from < bots.count
    }

    // MARK: - local events out

    private func observe(_ event: GameEvent) {
        switch event {
        case let .shotFired(shooterId, weapon, muzzle, direction, _): onShotFired(shooterId, weapon, muzzle, direction)
        case let .bulletTrace(shooterId, _, _, to, _): onTrace(shooterId, to)
        case let .weaponAction(shooterId, weapon, stage, _, _): onAction(shooterId, weapon, stage)
        case let .weaponSwitch(_, weapon, local):
            if !remoteGone, local, let id = WeaponID(rawValue: weapon) { link.send(.switchWeapon(id)) }
        case let .spawned(combatantId): onSpawned(combatantId)
        case let .died(victimId, killerId, weaponId, headshot): onDied(victimId, killerId, weaponId, headshot)
        case let .grenadeThrown(_, position, velocity, local):
            if local, !remoteGone { link.send(.nade(p: wire(position), v: wire(velocity))) }
        case let .grenadeExploded(_, position, local):
            if local, !remoteGone { link.send(.boom(p: wire(position))) }
        case let .combatantHit(_, targetId, _, _, direction, fatal):
            if fatal { fatalDirections[targetId] = direction }
        default:
            break
        }
    }

    private func isLocalShooter(_ id: Int) -> Bool {
        if id == game.player.id { return true }
        return role == .host && hostBots && game.combat.get(id)?.kind == .bot
    }

    private func wireOf(_ localId: Int) -> Int {
        if localId == game.player.id { return myWire }
        if localId == remote.id { return peerWire }
        if let proxy = proxies.local(localId) { return proxy.wireId }
        if role == .host, game.combat.get(localId)?.kind == .bot { return localId + Wire.botBase }
        return Wire.maxWireId
    }

    private func localOf(_ wire: Int) -> (any Combatant)? {
        if wire == myWire { return game.player }
        if wire == peerWire { return remoteGone ? nil : remote }
        if wire < Wire.botBase { return nil }
        if role == .guest { return proxies.get(wire) }
        let bot = game.combat.get(wire - Wire.botBase)
        return bot?.kind == .bot ? bot : nil
    }

    private func onShotFired(_ shooterId: Int, _ weapon: String, _ muzzle: Vec3, _ direction: Vec3) {
        guard isLocalShooter(shooterId), let id = WeaponID(rawValue: weapon) else { return }
        flushShot()
        pendingShot = PendingShot(shooterId: shooterId, message: ShotMessage(actor: wireOf(shooterId), weapon: id, muzzle: wire(muzzle),
                                                                             direction: wire(direction), ends: []))
    }

    private func onTrace(_ shooterId: Int, _ to: Vec3) {
        guard var pending = pendingShot, pending.shooterId == shooterId, pending.message.ends.count < Wire.maxPellets else { return }
        pending.message.ends.append(wire(to))
        pendingShot = pending
    }

    private func flushShot() {
        guard let pending = pendingShot else { return }
        pendingShot = nil
        if !remoteGone { link.sendShot(BinaryCodec.encodeShot(pending.message)) }
    }

    private func onAction(_ shooterId: Int, _ weapon: String, _ stage: String) {
        guard !remoteGone, isLocalShooter(shooterId), let id = WeaponID(rawValue: weapon),
              let stage = WeaponActionStage(rawValue: stage) else { return }
        link.send(.action(actor: wireOf(shooterId), weapon: id, stage: stage))
    }

    private func onSpawned(_ combatantId: Int) {
        if combatantId == game.player.id {
            life = min(255, life + 1)
            return
        }
        guard role == .host, hostBots, !remoteGone, let combatant = game.combat.get(combatantId), combatant.kind == .bot,
              let bot = combatant as? any NetBotView else { return }
        link.send(.botSpawn(id: bot.id + Wire.botBase, name: bot.name, weapon: WeaponID(rawValue: bot.weaponId) ?? .m4a1,
                            p: wire(bot.position), yaw: bot.yaw))
    }

    private func onDied(_ victimId: Int, _ killerId: Int, _ weaponId: String, _ headshot: Bool) {
        guard let source = DamageSource(rawValue: weaponId) else { return }
        let victim = game.combat.get(victimId)
        let mine = victimId == game.player.id
        let hostBot = role == .host && hostBots && victim?.kind == .bot
        guard mine || hostBot else { return }
        if hostBot, coop, killerId == remote.id { partnerKills += 1 }
        // The fatal hit's direction is announced just after the death: send at the end of the frame.
        pendingDeaths.append(PendingDeath(victimId: victimId, killerId: killerId, weapon: source, headshot: headshot))
    }

    private func flushDeaths() {
        guard !pendingDeaths.isEmpty else { return }
        let deaths = pendingDeaths
        pendingDeaths = []
        for death in deaths {
            let mine = death.victimId == game.player.id
            let direction = mine ? lastHurt : (fatalDirections[death.victimId] ?? Vec3(0, 0, -1))
            fatalDirections[death.victimId] = nil
            if remoteGone { continue }
            link.send(.death(victim: mine ? myWire : death.victimId + Wire.botBase, killer: wireOf(death.killerId), weapon: death.weapon,
                             headshot: death.headshot, life: mine ? life : 0, d: wire(direction)))
        }
        fatalDirections = [:]
    }

    /// A hit this machine decided on a body the other machine owns.
    private func forwardDamage(_ target: RemoteSoldier, _ info: DamageInfo) {
        guard !remoteGone, let source = DamageSource(rawValue: info.weaponId) else { return }
        link.send(.hit(target: target.wireId, attacker: wireOf(info.attackerId), weapon: source, zone: info.zone.wire,
                       amount: JS.round(info.amount * 100) / 100,
                       p: wire(info.point), d: wire(info.direction)))
    }

    // MARK: - remote messages in

    public func handleBinary(_ message: BinaryMessage, now: Double) {
        if remoteGone { return }
        switch message {
        case .state(let state): onRemoteState(state, now: now)
        case .bots(_, let time, let bots): onBotSnapshot(sent: time, bots: bots, now: now)
        case .shot(let shot): onRemoteShot(shot, now: now)
        default: break
        }
    }

    public func handleEvent(_ event: NetEvent, now: Double) {
        if remoteGone { return }
        switch event {
        case .hit: onRemoteHit(event, now: now)
        case .death: onRemoteDeath(event)
        case let .action(actor, weapon, stage): onRemoteAction(actor: actor, weapon: weapon, stage: stage, now: now)
        case .switchWeapon(let weapon):
            remote.weapon = weapon
            if actionGate.take(now: now) {
                game.events.emit(.weaponSwitch(shooterId: remote.id, weapon: weapon.rawValue, local: false))
            }
        case let .nade(p, v): onRemoteGrenade(p: p, v: v)
        case .boom(let p): game.grenades.detonate(ownerId: remote.id, position: world(p))
        case let .botSpawn(id, name, weapon, p, yaw):
            if role == .guest, hostBots { proxies.spawn(id: id, name: name, weapon: weapon, p: p, yaw: yaw) }
        case let .match(wave, enemies, result, hostKills, _):
            if role == .guest, coop {
                let previous = hostMatch
                hostMatch = (wave, enemies)
                partnerKills = hostKills
                if let previous, wave > previous.wave { hooks.waveStarted() }
                if let verdict = DuelRules.Result(rawValue: result.rawValue) { hooks.endMatch(verdict) }
            }
        default:
            break
        }
    }

    /// Sender time on this machine's clock, or nil when the message is too old to use.
    private func arrivalTime(sent: Double, now: Double) -> Double? {
        let clock = link.clock
        let local = clock.synced ? min(clock.toLocal(sent), now) : now
        return now - local > Self.staleMs ? nil : local
    }

    private func onRemoteState(_ state: PlayerState, now: Double) {
        lastStateAt = now
        guard let time = arrivalTime(sent: state.time, now: now) else { return }
        remote.push(InterpSnapshot(time: time, epoch: state.life,
                                   pose: InterpPose(x: state.x, y: state.y, z: state.z, vx: state.vx, vy: state.vy, vz: state.vz,
                                                    yaw: state.yaw, pitch: state.pitch)),
                    flags: RemoteFlags(crouching: state.crouching, aiming: state.aiming, reloading: state.reloading,
                                       running: state.sprinting, onGround: state.onGround, alive: state.alive,
                                       health: state.health, weapon: state.weapon),
                    life: state.life)
    }

    private func onBotSnapshot(sent: Double, bots: [BotState], now: Double) {
        guard role == .guest, hostBots else {
            onReject("bot snapshot with no host bots")
            return
        }
        if let time = arrivalTime(sent: sent, now: now) { proxies.push(time: time, bots: bots) }
    }

    /// Whoever `wire` names must be someone the other machine is allowed to speak for.
    private func remoteActor(_ wire: Int) -> RemoteSoldier? {
        if wire == peerWire { return remote }
        // Only the host has bots: in co-op, and in a duel where a player has one.
        if role == .guest, hostBots, wire >= Wire.botBase { return proxies.get(wire) }
        return nil
    }

    private func gate(_ wire: Int, _ check: (inout WeaponGate) -> Bool) -> Bool {
        if gates[wire] == nil, gates.count > BotProxies.maxProxies * 2 { gates = [:] }
        var gate = gates[wire] ?? WeaponGate()
        let allowed = check(&gate)
        gates[wire] = gate
        return allowed
    }

    private func onRemoteShot(_ shot: ShotMessage, now: Double) {
        guard let body = remoteActor(shot.actor) else { return onReject("shot from wire \(shot.actor)") }
        guard let def = game.data.contract.weapons.def(shot.weapon.rawValue) else { return }
        guard gate(shot.actor, { $0.allowShot(def, now: now) }) else { return onReject("shot over the rate gate (\(shot.weapon.rawValue))") }
        let events = game.events
        body.fired()
        let muzzle = body.muzzle(fallback: world(shot.muzzle))
        events.emit(.shotFired(shooterId: body.id, weapon: def.id, muzzle: muzzle, direction: world(shot.direction), local: false))
        let player = game.player
        var whizzed = !player.alive
        let count = min(shot.ends.count, Int(def.pellets))
        for i in 0..<count {
            let to = world(shot.ends[i])
            events.emit(.bulletTrace(shooterId: body.id, weapon: def.id, from: muzzle, to: to, local: false))
            // The shooter's machine knows what was hit; this one only needs the mark on the wall.
            let span = to - muzzle
            let length = span.length
            if length < 0.2 { continue }
            let direction = span.divided(by: length)
            if let hit = game.map?.world.raycast(origin: muzzle, direction: direction, maxDistance: length + 0.4), hit.distance > length - 0.6 {
                events.emit(.bulletImpact(shooterId: body.id, weapon: def.id, hit: hit))
            }
            if whizzed { continue }
            let head = player.eyePosition()
            let nearest = WeaponMath.closestPointOnSegment(muzzle, to, head)
            let gap = nearest.distanceToSquared(head)
            // A round that stopped in the player is a hit, not a near miss.
            if gap < Self.nearMissRadius * Self.nearMissRadius, to.distanceToSquared(head) > 1 {
                whizzed = true
                events.emit(.nearMiss(point: nearest, direction: direction, weapon: def.id))
            }
        }
    }

    /// The other player threw their grenade: fly a copy here. It does no damage on this machine.
    private func onRemoteGrenade(p: SIMD3<Double>, v: SIMD3<Double>) {
        if peerGrenades >= grenadesPerMatch || !remote.alive { return }
        let velocity = world(v)
        guard velocity.length <= maxThrowSpeed else { return onReject("grenade thrown too fast") }
        var origin = world(p)
        let head = remote.eyePosition()
        if origin.distance(to: head) > Self.grenadeReach { origin = head }
        peerGrenades += 1
        game.grenades.launch(owner: remote, origin: origin, velocity: velocity, authoritative: false)
    }

    private func onRemoteHit(_ event: NetEvent, now: Double) {
        guard case let .hit(targetWire, attackerWire, source, wireZone, amountSent, p, d) = event else { return }
        let blast = source == .grenade
        guard let def = game.data.contract.weapons.def(source.rawValue) else { return }
        let zone = HitZone(wire: wireZone)
        let player = game.player
        var target: (any Combatant)?
        if targetWire == myWire {
            // A partner cannot hurt a partner; in a duel only the opponent can. A guest is also shot at by the host's enemy bots.
            let fromPeer = attackerWire == peerWire && !coop
            let bot = role == .guest && hostBots ? proxies.get(attackerWire) : nil
            let fromBot = bot.map { $0.team != player.team } ?? false
            if fromPeer || fromBot { target = player }
        } else if role == .host, hostBots, attackerWire == peerWire, targetWire >= Wire.botBase {
            // The other player may hurt only the bots fighting against them.
            if let bot = localOf(targetWire), bot.team != remote.team { target = bot }
        }
        guard let target else { return onReject("hit \(attackerWire)->\(targetWire) not allowed") }
        guard target.alive else { return }
        // A blast is only believed from a player who has thrown a grenade, and only so many times.
        let allowed = blast
            ? attackerWire == peerWire && peerGrenades > 0 && blastGate.take(now: now)
            : gate(attackerWire) { $0.allowHit(def, now: now) }
        guard allowed else { return onReject("hit over the rate gate (\(source.rawValue))") }
        let amount = DamageCap.cap(def, amountSent)
        if amount < amountSent { onReject("hit over the damage cap (\(amountSent) > \(amount))") }
        if amount <= 0 { return }
        let attacker = localOf(attackerWire)
        let point = world(p)
        var direction = world(d)
        if direction.lengthSq < 1e-6 { direction = Vec3(0, 0, -1) }
        direction = direction.normalized()
        if target === player { lastHurt = direction }
        target.applyDamage(DamageInfo.make(amount: amount, zone: zone, attackerId: attacker?.id ?? Self.nobody, weaponId: source.rawValue,
                                      point: point, direction: direction))
        if target !== player {
            // Let the host see and hear the guest's hit land on the bot.
            game.events.emit(.combatantHit(weapon: def.id, targetId: target.id, attackerId: attacker?.id ?? Self.nobody,
                                           hit: CombatantHit.make(distance: 0, zone: zone, point: point), direction: direction,
                                           fatal: !target.alive))
        }
    }

    private func onRemoteDeath(_ event: NetEvent) {
        guard case let .death(victim, killerWire, source, headshot, deathLife, d) = event else { return }
        var direction = world(d)
        if direction.lengthSq < 1e-6 { direction = Vec3(0, 0, -1) }
        // A partner cannot be killed by this player, so their death never counts as this player's kill.
        let killer = coop && victim == peerWire && killerWire == myWire ? nil : localOf(killerWire)
        if victim == peerWire {
            if deathLife <= lastPeerDeathLife { return }
            lastPeerDeathLife = deathLife
            partnerDeaths += 1
            remote.die(direction: direction, life: deathLife)
            game.events.emit(.died(victimId: remote.id, killerId: killer?.id ?? Self.nobody, weaponId: source.rawValue, headshot: headshot))
            return
        }
        guard role == .guest, hostBots else { return onReject("death of wire \(victim) not allowed") }
        guard let proxy = proxies.get(victim), proxy.endedLife < 0 else { return }
        proxy.die(direction: direction, life: 0)
        game.events.emit(.died(victimId: proxy.id, killerId: killer?.id ?? Self.nobody, weaponId: source.rawValue, headshot: headshot))
    }

    private func onRemoteAction(actor: Int, weapon: WeaponID, stage: WeaponActionStage, now: Double) {
        guard let body = remoteActor(actor) else { return onReject("action from wire \(actor)") }
        guard actionGate.take(now: now) else { return }
        game.events.emit(.weaponAction(shooterId: body.id, weapon: weapon.rawValue, stage: stage.rawValue,
                                       position: body.chestPosition(), local: false))
    }

    /// The host is gone: clear its bots away. Returns how many were alive.
    @discardableResult
    public func dropProxies() -> Int { proxies.clear() }

    /// The other player is gone: take their body out of the world and stop sending.
    public func dropRemote() {
        if remoteGone { return }
        remoteGone = true
        pendingShot = nil
        game.combat.remove(remote.id)
    }

    public var isRemoteGone: Bool { remoteGone }

    public func dispose() {
        for off in unsubscribe { off() }
        unsubscribe = []
        proxies.clear()
        dropRemote()
    }

    // MARK: - vectors

    private func wire(_ v: Vec3) -> SIMD3<Double> { SIMD3(v.x, v.y, v.z) }
    private func world(_ v: SIMD3<Double>) -> Vec3 { Vec3(v.x, v.y, v.z) }
}
