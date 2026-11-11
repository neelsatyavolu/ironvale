import * as THREE from 'three/webgpu';
import type { GameContext, PlayerWeapons, WeaponActionStage, WeaponState } from '../game/contracts';
import { AimState } from './aim';
import { WEAPON_DEFS } from './defs';
import {
  SPRINT_HOLD_OFF_SECONDS,
  SPRINT_IN_SECONDS,
  SPRINT_OUT_SECONDS,
  SPRINT_READY_BLEND,
} from './handling';
import { IntentReader, type DebugInput } from './intent';
import { WeaponMachine, type MachineSink } from './machine';
import { WEAPON_IDS } from './models/api';
import { RecoilModel, type Stance } from './recoil';
import { ViewSteering } from './steering';
import { WeaponSwitch } from './switching';
import { buildFallbackGun } from './view/fallback';
import { GunView } from './view/gun-view';
import { clamp01 } from './view/motion';
import { buildArmsRig, buildGunModel } from './view/registry';
import { ViewRig, type ViewFrame } from './view/rig';

/** The scope picture replaces the gun once the sights are this far up. */
const SCOPED_AT = 0.9;
/** Switch times used before the view models exist. */
const DEFAULT_SWITCH_TIMES = { lowerTime: 0.3, raiseTime: 0.4 };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** `PlayerWeapons` plus a few read-outs the interface and dev scripts can use. */
export interface PlayerWeaponSystem extends PlayerWeapons {
  /** Cone half-angle in degrees for a shot fired now; drives a spreading crosshair. */
  readonly spread: number;
  /** 1 = full lungs, 0 = out of breath (scoped rifles). */
  readonly breath: number;
  readonly switching: boolean;
  /** Scripted input for development; see `DebugInput`. */
  debugInput: DebugInput | null;
  dispose(): void;
}

class PlayerWeaponsImpl implements PlayerWeaponSystem, MachineSink {
  spread = 0;

  private readonly machines: WeaponMachine[];
  private readonly swap: WeaponSwitch;
  private sprintBlend = 0;
  private sprintHoldOff = 0;
  private wasAlive = true;

  private readonly aim = new AimState();
  private readonly recoil = new RecoilModel();
  private readonly reader = new IntentReader();
  private readonly steering: ViewSteering;
  private rig: ViewRig | null = null;
  private views: GunView[] = [];

  private readonly trigger = { fireHeld: false, firePressed: false, reloadPressed: false, ready: false };
  private readonly aimInput = { held: false, pressed: false, toggle: false, allowed: false, aimTime: 0.2 };
  private readonly stance: Mutable<Stance> = { aimBlend: 0, crouching: false, speed: 0, airborne: false };
  private readonly frame: ViewFrame;
  private readonly muzzle = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly port = new THREE.Vector3();
  private readonly portSide = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly ctx: GameContext) {
    this.machines = WEAPON_IDS.map((id) => new WeaponMachine(WEAPON_DEFS[id])).sort((a, b) => a.def.slot - b.def.slot);
    const first = this.machines[0];
    if (!first) throw new Error('No weapons are defined');
    this.frame = {
      dt: 0,
      machine: first,
      aim: 0,
      sprint: 0,
      lowered: 0,
      speed: 0,
      verticalSpeed: 0,
      onGround: true,
      lookYaw: 0,
      lookPitch: 0,
      hidden: false,
    };
    this.swap = new WeaponSwitch(this.machines.length, (index) => this.views[index]?.handling ?? DEFAULT_SWITCH_TIMES);
    this.steering = new ViewSteering(ctx, new THREE.Vector3());
    this.unsubscribe.push(
      ctx.events.on('spawned', (event) => {
        if (event.combatantId === this.ctx.player.id) this.resetHandling();
      }),
      ctx.events.on('landed', (event) => {
        if (event.local) this.rig?.landed(event.speed);
      }),
      // The gun belongs to a match: hide it whenever no map is loaded.
      ctx.engine.onFrame(() => {
        if (!this.ctx.map) this.rig?.setVisible(false);
      }),
    );
  }

  get current(): WeaponState {
    return this.machine;
  }

  get loadout(): readonly WeaponState[] {
    return this.machines;
  }

  get aimBlend(): number {
    return this.aim.blend;
  }

  get zoom(): number {
    return this.machine.def.aimZoom;
  }

  get scopedIn(): boolean {
    return this.machine.def.scoped && this.aim.blend >= SCOPED_AT;
  }

  get breath(): number {
    return this.steering.breath.breath;
  }

  /** Pressing fire mid-sprint holds the sprint off for a moment so the gun can come up. */
  get blocksSprint(): boolean {
    return this.sprintHoldOff > 0;
  }

  get switching(): boolean {
    return this.swap.switching;
  }

  get debugInput(): DebugInput | null {
    return this.reader.debug;
  }

  set debugInput(value: DebugInput | null) {
    this.reader.debug = value;
  }

  equip(slot: number): void {
    this.requestIndex(this.machines.findIndex((machine) => machine.def.slot === slot));
  }

  private requestIndex(index: number): void {
    if (!this.swap.request(index)) return;
    // The gun in hand is going down: whatever the hands were doing stops.
    this.machine.cancel();
    this.aim.drop();
  }

  resupply(): void {
    for (const machine of this.machines) machine.refill();
    this.ensureViews();
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.rig?.dispose();
    this.rig = null;
  }

  update(dt: number): void {
    const { ctx } = this;
    const player = ctx.player;
    this.ensureViews();
    this.steering.measure(dt);

    if (!player.alive) {
      if (this.wasAlive) this.onDeath();
      this.rig?.setVisible(false);
      return;
    }
    this.wasAlive = true;

    const controls = ctx.settings.value.controls;
    const active = ctx.input.locked || this.reader.debug !== null;
    const intent = this.reader.read(ctx.input, active);

    if (intent.slot > 0) this.equip(intent.slot);
    else if (intent.cycle !== 0) {
      const count = this.machines.length;
      this.requestIndex((this.swap.pending + intent.cycle + count) % count);
    }
    if (this.swap.update(dt)) {
      this.recoil.reset();
      this.showCurrent();
      ctx.events.emit('weaponSwitch', { shooterId: player.id, weapon: this.machine.def, local: true });
    }
    const machine = this.machine;
    const def = machine.def;
    const switching = this.swap.switching;

    // Sprinting lowers the gun; using the trigger, the sights or the reload brings it back up.
    if (intent.sprintPressed && controls.adsToggle && !(def.scoped && this.aim.blend > 0.5)) this.aim.drop();
    if (intent.fireHeld || intent.firePressed || intent.reloadPressed || this.aim.wanted) {
      this.sprintHoldOff = SPRINT_HOLD_OFF_SECONDS;
    } else {
      this.sprintHoldOff = Math.max(0, this.sprintHoldOff - dt);
    }
    const carrying = player.sprinting && this.sprintHoldOff <= 0 && !machine.reloading;
    this.sprintBlend = clamp01(this.sprintBlend + (carrying ? dt / SPRINT_IN_SECONDS : -dt / SPRINT_OUT_SECONDS));

    const aimInput = this.aimInput;
    aimInput.held = intent.aimHeld;
    aimInput.pressed = intent.aimPressed;
    // A scope is held up only while the aim key is down, whatever the toggle setting.
    aimInput.toggle = controls.adsToggle && !def.scoped;
    aimInput.aimTime = def.aimTime;
    aimInput.allowed =
      !switching && !machine.reloading && !(def.fireMode === 'bolt' && machine.cycling) && this.sprintBlend < 0.5;
    const aimChanged = this.aim.update(dt, aimInput);
    if (aimChanged) ctx.events.emit('aimChanged', { aiming: this.aim.aiming, weapon: def });

    const stance = this.stance;
    // A scope is only precise once it is all the way up.
    stance.aimBlend = def.scoped ? this.aim.blend * this.aim.blend : this.aim.blend;
    stance.crouching = player.crouching;
    stance.speed = player.speed;
    stance.airborne = !player.onGround;

    const trigger = this.trigger;
    trigger.fireHeld = intent.fireHeld;
    trigger.firePressed = intent.firePressed && !switching;
    trigger.reloadPressed = intent.reloadPressed && !switching;
    trigger.ready = !switching && this.sprintBlend < SPRINT_READY_BLEND;
    machine.step(dt, trigger, this);
    this.recoil.update(dt);
    this.spread = this.recoil.spread(def, stance);

    this.steering.steer(dt, def, this.aim.blend, active, aimChanged && this.aim.aiming, intent.holdBreath);

    const frame = this.frame;
    frame.dt = dt;
    frame.machine = machine;
    frame.aim = this.aim.blend;
    frame.sprint = this.sprintBlend;
    frame.lowered = this.swap.lowered;
    frame.lookYaw = this.steering.lookYaw;
    frame.lookPitch = this.steering.lookPitch;
    frame.speed = player.speed;
    frame.verticalSpeed = player.velocity.y;
    frame.onGround = player.onGround;
    frame.hidden = this.scopedIn;
    this.rig?.update(frame, ctx.map ? ctx.world : null);
  }

  // ------------------------------------------------------------ machine sink

  fire(_lastRound: boolean): void {
    const { ctx, rig, recoil } = this;
    const player = ctx.player;
    const def = this.machine.def;
    const camera = ctx.engine.camera;
    camera.getWorldDirection(this.direction);
    if (rig) rig.muzzleWorld(this.muzzle);
    else camera.getWorldPosition(this.muzzle);
    ctx.ballistics.fire(player, def, this.muzzle, this.direction, recoil.spread(def, this.stance));
    recoil.shot(def, this.stance);
    player.addRecoil(recoil.kickPitch, recoil.kickYaw, def.recoil.recovery);
    this.steering.kicked(recoil.kickPitch, recoil.kickYaw, def.recoil.recovery);
    rig?.fired(this.aim.blend, def.recoil.horizontal > 0 ? recoil.kickYaw / def.recoil.horizontal : 0);
  }

  dryFire(): void {
    const player = this.ctx.player;
    this.ctx.events.emit('dryFire', {
      shooterId: player.id,
      weapon: this.machine.def,
      position: player.eyePosition(this.eye),
    });
  }

  stage(stage: WeaponActionStage): void {
    const player = this.ctx.player;
    this.ctx.events.emit('weaponAction', {
      shooterId: player.id,
      weapon: this.machine.def,
      stage,
      position: player.eyePosition(this.eye),
      local: true,
    });
    this.rig?.stage(stage);
  }

  eject(): void {
    this.throwBrass(2 + Math.random() * 0.8, 1.2 + Math.random() * 0.6, 0.2 + Math.random() * 0.4);
  }

  private throwBrass(side: number, up: number, back: number): void {
    const { ctx, rig } = this;
    if (!rig) return;
    rig.ejectionWorld(this.port, this.portSide);
    ctx.engine.camera.getWorldDirection(this.direction);
    this.velocity
      .copy(this.portSide)
      .multiplyScalar(side)
      .addScaledVector(this.direction, -back)
      .add(ctx.player.velocity);
    this.velocity.y += up;
    ctx.events.emit('casingEjected', { kind: this.machine.def.casing, position: this.port, velocity: this.velocity });
  }

  // ------------------------------------------------------------ internals

  private get machine(): WeaponMachine {
    const machine = this.machines[this.swap.index];
    if (!machine) throw new Error(`No weapon at index ${this.swap.index}`);
    return machine;
  }

  private onDeath(): void {
    this.wasAlive = false;
    this.machine.cancel();
    if (this.aim.aiming) this.ctx.events.emit('aimChanged', { aiming: false, weapon: this.machine.def });
    this.resetHandling();
  }

  /** Back to a freshly raised gun: used on respawn and death. Ammo is not touched. */
  private resetHandling(): void {
    this.aim.reset();
    this.recoil.reset();
    this.steering.reset();
    this.swap.reset();
    this.sprintBlend = 0;
    this.sprintHoldOff = 0;
  }

  /** Build the guns and arms the first time they are needed. Assets are loaded by then. */
  private ensureViews(): void {
    if (this.rig) return;
    const { ctx } = this;
    this.views = this.machines.map((machine) => {
      const id = machine.def.id as (typeof WEAPON_IDS)[number];
      try {
        return new GunView(buildGunModel(id, ctx.assets), machine.def);
      } catch (error) {
        console.warn(`Could not set up the view model for "${id}"; using the stand-in`, error);
        return new GunView(buildFallbackGun(id), machine.def);
      }
    });
    this.rig = new ViewRig(ctx.engine.camera, buildArmsRig(ctx.assets));
    this.showCurrent();
  }

  private showCurrent(): void {
    const view = this.views[this.swap.index];
    if (view) this.rig?.show(view);
  }
}

export function createPlayerWeaponSystem(ctx: GameContext): PlayerWeaponSystem {
  return new PlayerWeaponsImpl(ctx);
}
