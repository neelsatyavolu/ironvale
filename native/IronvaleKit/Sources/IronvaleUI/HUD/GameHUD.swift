// Drives the HUD from a running `Game`: subscribes to its events as createHud, createReticle,
// createExtras and createMinimap do (src/ui/hud/*.ts at cbe0add), and reads the match state into a
// `HUDState` every frame. The renderer draws whatever `frame` returns.
import Foundation
import IronvaleSim
import IronvaleWorld

/// A combatant whose health the HUD may show (enemy bars). Bots and the co-op stand-ins conform where they are composed.
public protocol HUDHealthSource: AnyObject {
    var health: Double { get }
}

extension PlayerController: HUDHealthSource {}

@MainActor
public final class GameHUD {
    public let game: Game
    public let tracker = HUDTracker()
    public var perfVisible = false
    /// The perf line (`perf.ts`), set by whoever owns the frame timing; refreshed on its own clock.
    public var perfText = ""
    /// Two-player state, when a friend is connected (`snapshot.net`); nil playing alone.
    public var net: () -> HUDState.Net? = { nil }
    public var chatLines: () -> [HUDState.ChatLine] = { [] }
    public var chatInputOpen = false
    /// Health of a combatant by id, for the bars over enemies the player has hit.
    public var health: (any Combatant) -> Double? = { ($0 as? any HUDHealthSource)?.health }

    private var unsubscribe: (() -> Void)?
    private var showHitMarkers = true

    public init(game: Game) {
        self.game = game
        unsubscribe = game.events.on { [weak self] event in
            MainActor.assumeIsolated { self?.handle(event) }
        }
    }

    isolated deinit { unsubscribe?() }

    /// Real time for animations (the web's `performance.now()`), seconds.
    public static func wallClock() -> Double { ProcessInfo.processInfo.systemUptime }
    /// The clock events are stamped with; pass the same value as `wall` when building the scene.
    public var clock: () -> Double = { ProcessInfo.processInfo.systemUptime }

    private func weaponName(_ id: String) -> String { game.data.contract.weapons.def(id)?.name ?? id.uppercased() }

    private func handle(_ event: GameEvent) {
        let wall = clock()
        let player = game.player
        switch event {
        case let .combatantHit(_, targetId, attackerId, _, _, fatal):
            guard attackerId == player.id, targetId != player.id else { return }
            tracker.playerHit(targetId: targetId, fatal: fatal, showMarker: showHitMarkers, wall: wall, match: game.time)
        case let .playerHurt(_, _, direction):
            tracker.hurt(dx: direction.x, dz: direction.z, yaw: player.yaw, wall: wall)
        case let .aimChanged(aiming, _):
            tracker.aimChanged(aiming)
        case let .weaponSwitch(_, weapon, local):
            guard local, let def = game.data.contract.weapons.def(weapon) else { return }
            tracker.weaponSwitched(name: def.name, weaponClass: def.weaponClass, wall: wall)
        case let .died(victimId, killerId, weaponId, headshot):
            let victim = game.combat.get(victimId), killer = game.combat.get(killerId)
            let distance = victim.map { v in
                let d = SIMD3(v.position.x - player.position.x, v.position.y - player.position.y, v.position.z - player.position.z)
                return (d * d).sum().squareRoot()
            } ?? 0
            tracker.died(victimId: victimId, killerId: killerId, playerId: player.id, killer: killer?.name, victim: victim?.name,
                         weaponName: weaponName(weaponId), headshot: headshot, distance: distance, match: game.time, wall: wall)
        case let .shotFired(shooterId, _, muzzle, _, local):
            guard !local else { return }
            tracker.shot(shooterId: shooterId, muzzle: SIMD3(muzzle.x, muzzle.y, muzzle.z), match: game.time)
        case .spawned:
            break
        default:
            break
        }
    }

    /// A new match: the HUD forgets the last one.
    public func matchStarted() { tracker.reset() }

    /// The state for this frame. `width`/`height` in points, `pointScale` pixels per point.
    public func state(settings: Settings, width: Double, height: Double, pointScale: Double) -> HUDState {
        showHitMarkers = settings.gameplay.showHitMarkers
        var s = HUDState()
        let phase = game.phase
        s.visible = (phase == .playing || phase == .paused) && game.map != nil
        s.width = width
        s.height = height
        s.pointScale = pointScale
        s.now = game.time
        s.crosshairSetting = settings.gameplay.crosshair
        s.minimapSetting = settings.gameplay.minimap
        s.perfVisible = perfVisible
        s.perfText = perfText
        let snapshot = game.snapshot
        let config = game.config
        switch config?.effectiveRules {
        case .survival: s.rules = .survival
        case .duel: s.rules = .duel
        default: s.rules = .skirmish
        }
        s.coop = config?.mode == .coop
        s.duel = config?.mode == .duel
        s.net = net()
        s.wave = game.snapshot.wave
        let player = game.player
        s.localName = player.name
        let enemies = game.combat.enemies(of: player.team)
        s.enemiesRemaining = snapshot.enemiesRemaining
        s.livesRemaining = snapshot.livesRemaining
        s.kills = snapshot.kills
        s.health = Double(snapshot.health)
        s.magazine = snapshot.magazine
        s.reserve = snapshot.reserve
        s.weaponName = snapshot.weaponName
        s.fireMode = game.weapons.current.def.fireMode
        s.reloading = snapshot.reloading
        s.scopedIn = snapshot.scopedIn
        s.aiming = snapshot.aiming
        s.grenades = snapshot.grenades
        s.grenadeAiming = snapshot.grenadeAiming
        let preset = settings.controls.preset.rawValue
        s.grenadeKey = HUDMath.keyName(game.data.constants.input.bindings[preset]?["grenade"]?.first ?? "", preset: preset)
        s.yaw = player.yaw
        s.position = SIMD3(player.position.x, player.position.y, player.position.z)
        let camera = player.camera
        s.fovDegrees = camera.fov
        s.aspect = width / max(height, 1)
        s.enemies = enemies.map { HUDState.Marker(id: $0.id, position: SIMD3($0.position.x, $0.position.y, $0.position.z)) }
        if s.net != nil, let partner = game.combat.all().first(where: { $0.id != player.id && $0.alive && $0.team == player.team }) {
            s.partner = HUDState.Marker(id: partner.id, position: SIMD3(partner.position.x, partner.position.y, partner.position.z))
        }
        s.chatEnabled = s.net?.peerConnected == true
        s.chatInputOpen = chatInputOpen
        s.chatLines = chatLines()
        s.enemyBars = enemyBars(camera: camera, width: width, height: height)
        return s
    }

    /// extras.ts: bars over enemies hit in the last BAR_SECONDS, projected above the eyes.
    private func enemyBars(camera: SimCamera, width: Double, height: Double) -> [(x: Double, y: Double, health: Double)] {
        let ids = tracker.liveHits(match: game.time) { [game] id in game.combat.get(id)?.alive == true }
        let basis = camera.basis
        let tanHalf = tan(camera.fov * Double.pi / 360)
        let aspect = width / max(height, 1)
        var bars: [(x: Double, y: Double, health: Double)] = []
        for id in ids {
            guard let target = game.combat.get(id), let value = health(target) else { continue }
            let eye = target.eyePosition()
            let rel = Vec3(eye.x - camera.position.x, eye.y + 0.32 - camera.position.y, eye.z - camera.position.z)
            let x = rel.x * basis.right.x + rel.y * basis.right.y + rel.z * basis.right.z
            let y = rel.x * basis.up.x + rel.y * basis.up.y + rel.z * basis.up.z
            let z = -(rel.x * basis.back.x + rel.y * basis.back.y + rel.z * basis.back.z)
            guard z > 0.1 else { continue }
            let nx = x / z / (tanHalf * aspect), ny = y / z / tanHalf
            guard abs(nx) <= 1, abs(ny) <= 1 else { continue }
            bars.append(((nx * 0.5 + 0.5) * width, (-ny * 0.5 + 0.5) * height, value))
        }
        return bars
    }
}
