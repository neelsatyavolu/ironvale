// Ported from src/weapons/player-weapons.ts and src/weapons/intent.ts at commit 185029e: intent ->
// switch -> grenade -> sprint carry -> ADS -> stance -> machine -> recoil. Not yet ported (later
// milestones): ViewSteering with aim assist and scope breath sway (no enemies in an M4 sandbox), and
// the view rig, whose muzzle and ejection port the app supplies through `muzzle` / `ejectionPort`.
import IronvaleContract
import IronvaleWorld

/// What the player is asking the weapon to do this frame.
public struct WeaponIntent: Sendable, Equatable {
    public var fireHeld = false
    public var firePressed = false
    public var aimHeld = false
    public var aimPressed = false
    public var reloadPressed = false
    public var holdBreath = false
    public var sprintPressed = false
    public var grenadeHeld = false
    /// Loadout slot asked for this frame (1 - 6), or 0.
    public var slot = 0
    /// +1 next weapon, -1 previous, 0 none.
    public var cycle = 0

    public init() {}

    /// `IntentReader.read` for device input.
    public static func read(_ input: any ActionInput, active: Bool) -> WeaponIntent {
        var intent = WeaponIntent()
        guard active else { return intent }
        intent.fireHeld = input.isDown(.fire)
        intent.firePressed = input.wasPressed(.fire)
        intent.aimHeld = input.isDown(.aim)
        intent.aimPressed = input.wasPressed(.aim)
        intent.reloadPressed = input.wasPressed(.reload)
        intent.holdBreath = input.isDown(.holdBreath)
        intent.sprintPressed = input.wasPressed(.sprint)
        intent.grenadeHeld = input.isDown(.grenade)
        let slots: [Action] = [.slot1, .slot2, .slot3, .slot4, .slot5, .slot6]
        for (i, action) in slots.enumerated() where input.wasPressed(action) { intent.slot = i + 1 }
        intent.cycle = (input.wasPressed(.weaponNext) ? 1 : 0) - (input.wasPressed(.weaponPrev) ? 1 : 0)
        return intent
    }
}

public final class PlayerWeapons: MachineSink {
    public private(set) var spread = 0.0
    public let machines: [WeaponMachine]
    public let grenade: GrenadeThrow
    /// The view model's muzzle in world space; nil traces from the camera.
    public var muzzle: (() -> Vec3)?
    /// The view model's ejection port and its outward side; nil emits no player brass.
    public var ejectionPort: (() -> (port: Vec3, side: Vec3)?)?

    private let swap: WeaponSwitch
    private var issued: Set<String>
    private var sprintBlend = 0.0
    private var sprintHoldOff = 0.0
    private var wasAlive = true
    private let aim = AimState()
    private let recoil: RecoilModel
    private var stance = Stance()
    private let c: SimConstants
    private let player: PlayerController
    private let input: any ActionInput
    private let settings: () -> PlayerSettings
    private let events: EventBus
    private let ballistics: Ballistics
    private let grenades: GrenadeSystem
    private let world: () -> CollisionWorld?
    private let random: () -> Double

    public init(player: PlayerController, input: any ActionInput, settings: @escaping () -> PlayerSettings, events: EventBus,
                ballistics: Ballistics, grenades: GrenadeSystem, world: @escaping () -> CollisionWorld?,
                random: @escaping () -> Double, data: SimData = .shared) {
        c = data.constants
        self.player = player
        self.input = input
        self.settings = settings
        self.events = events
        self.ballistics = ballistics
        self.grenades = grenades
        self.world = world
        self.random = random
        recoil = RecoilModel(constants: data.constants.recoil, random: random)
        grenade = GrenadeThrow(data: data)
        machines = data.weapons.map { WeaponMachine(def: $0, constants: data.constants) }.sorted { $0.def.slot < $1.def.slot }
        issued = Set(data.contract.weapons.weaponIds)
        let handling = data.constants.handling.classes
        let fallback = data.constants.playerWeapons.DEFAULT_SWITCH_TIMES
        let times = machines.map { machine in
            handling[machine.def.weaponClass].map { SimConstants.SwitchTimes(lowerTime: $0.lowerTime, raiseTime: $0.raiseTime) } ?? fallback
        }
        swap = WeaponSwitch(count: machines.count) { times.indices.contains($0) ? times[$0] : fallback }
        events.on { [weak self] event in
            if case .spawned(let id) = event, let self, id == self.player.id { self.resetHandling() }
        }
    }

    public var current: WeaponMachine { machines[swap.index] }
    public var aimBlend: Double { aim.blend }
    public var zoom: Double { current.def.aimZoom }
    public var scopedIn: Bool { current.def.scoped && aim.blend >= c.playerWeapons.SCOPED_AT }
    /// Pressing fire mid-sprint holds the sprint off for a moment so the gun can come up.
    public var blocksSprint: Bool { sprintHoldOff > 0 }
    public var switching: Bool { swap.switching }
    /// 0 with the gun up, 1 lowered (switch or grenade), for the view model.
    public var lowered: Double { max(swap.lowered, grenade.lowered) }
    public var sprintCarry: Double { sprintBlend }

    public func equip(slot: Int) {
        requestIndex(machines.firstIndex { $0.def.slot == slot } ?? -1)
    }

    public func issue(_ ids: [String]) {
        issued = Set(ids)
        if carries(current.def.id) { return }
        // The gun in hand is not carried this match: start with the first one that is.
        current.cancel()
        aim.reset()
        swap.hold(max(0, machines.firstIndex { carries($0.def.id) } ?? -1))
    }

    public func carries(_ id: String) -> Bool { issued.contains(id) }

    private func cycled(from: Int, step: Int) -> Int {
        let count = machines.count
        var index = from
        for _ in 0 ..< count {
            index = (index + step + count) % count
            if carries(machines[index].def.id) { return index }
        }
        return from
    }

    private func requestIndex(_ index: Int) {
        guard machines.indices.contains(index), carries(machines[index].def.id) else { return }
        if !swap.request(index) { return }
        // The gun in hand is going down: whatever the hands were doing stops.
        current.cancel()
        aim.drop()
    }

    public func resupply() {
        for machine in machines { machine.refill() }
    }

    public func restockGrenades() { grenade.restock() }

    public func update(_ dt: Double) {
        if !player.alive {
            if wasAlive { onDeath() }
            return
        }
        wasAlive = true

        let controls = settings()
        let active = input.locked
        let intent = WeaponIntent.read(input, active: active)

        let switchAsked = intent.slot > 0 || intent.cycle != 0
        if intent.slot > 0 {
            equip(slot: intent.slot)
        } else if intent.cycle != 0 {
            requestIndex(cycled(from: swap.pending, step: intent.cycle))
        }
        if swap.update(dt) {
            recoil.reset()
            events.emit(.weaponSwitch(shooterId: player.id, weapon: current.def.id, local: true))
        }
        let machine = current
        let def = machine.def
        let switching = swap.switching

        // Holding the grenade key lowers the gun; fire or a weapon switch puts the grenade away unused.
        let thrown = grenade.update(dt, held: intent.grenadeHeld, cancel: intent.firePressed || switchAsked,
                                    allowed: !switching && !machine.reloading, camera: player.camera, world: world())
        if thrown { grenades.launch(owner: player, origin: grenade.origin, velocity: grenade.velocity, authoritative: true) }

        // Sprinting lowers the gun; using the trigger, the sights or the reload brings it back up.
        let h = c.handling
        if intent.sprintPressed, controls.adsToggle, !(def.scoped && aim.blend > 0.5) { aim.drop() }
        if intent.fireHeld || intent.firePressed || intent.reloadPressed || aim.wanted {
            sprintHoldOff = h.SPRINT_HOLD_OFF_SECONDS
        } else {
            sprintHoldOff = max(0, sprintHoldOff - dt)
        }
        let carrying = player.sprinting && sprintHoldOff <= 0 && !machine.reloading
        sprintBlend = MathUtils.clamp01(sprintBlend + (carrying ? dt / h.SPRINT_IN_SECONDS : -dt / h.SPRINT_OUT_SECONDS))

        let aimInput = AimInput(
            held: intent.aimHeld,
            pressed: intent.aimPressed,
            // A scope is held up only while the aim key is down, whatever the toggle setting.
            toggle: controls.adsToggle && !def.scoped,
            allowed: !switching && !machine.reloading && !(def.fireMode == "bolt" && machine.cycling)
                && sprintBlend < 0.5 && !grenade.aiming,
            aimTime: def.aimTime
        )
        if aim.update(dt, aimInput) { events.emit(.aimChanged(aiming: aim.aiming, weapon: def.id)) }

        // A scope is only precise once it is all the way up.
        stance.aimBlend = def.scoped ? aim.blend * aim.blend : aim.blend
        stance.crouching = player.crouching
        stance.speed = player.speed
        stance.airborne = !player.onGround

        let trigger = TriggerInput(
            fireHeld: intent.fireHeld,
            firePressed: intent.firePressed && !switching,
            reloadPressed: intent.reloadPressed && !switching && !grenade.aiming,
            ready: !switching && sprintBlend < h.SPRINT_READY_BLEND && grenade.lowered < c.playerWeapons.GRENADE_READY
        )
        machine.step(dt: dt, input: trigger, sink: self)
        recoil.update(dt)
        spread = recoil.spread(def, stance)
    }

    // MARK: MachineSink

    public func fire(lastRound _: Bool) {
        let def = current.def
        let camera = player.camera
        let origin = muzzle?() ?? camera.position
        ballistics.fire(shooter: player, weapon: def, muzzle: origin, direction: camera.direction, spreadDegrees: recoil.spread(def, stance))
        recoil.shot(def, stance)
        player.addRecoil(pitchDegrees: recoil.kickPitch, yawDegrees: recoil.kickYaw, recovery: def.recoil.recovery)
    }

    public func dryFire() {
        events.emit(.dryFire(shooterId: player.id, weapon: current.def.id, position: player.eyePosition()))
    }

    public func stage(_ stage: String) {
        events.emit(.weaponAction(shooterId: player.id, weapon: current.def.id, stage: stage, position: player.eyePosition(), local: true))
    }

    public func eject() {
        guard let port = ejectionPort?() ?? nil else { return }
        let side = 2 + random() * 0.8, up = 1.2 + random() * 0.6, back = 0.2 + random() * 0.4
        var velocity = port.side.scaled(side).adding(player.camera.direction, scaledBy: -back) + player.velocity
        velocity.y += up
        events.emit(.casingEjected(kind: current.def.casing, position: port.port, velocity: velocity))
    }

    private func onDeath() {
        wasAlive = false
        current.cancel()
        if aim.aiming { events.emit(.aimChanged(aiming: false, weapon: current.def.id)) }
        resetHandling()
    }

    /// Back to a freshly raised gun: used on respawn and death. Ammo is not touched.
    private func resetHandling() {
        aim.reset()
        recoil.reset()
        swap.reset()
        grenade.cancel()
        sprintBlend = 0
        sprintHoldOff = 0
    }
}
