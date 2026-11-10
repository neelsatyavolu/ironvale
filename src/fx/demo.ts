import * as THREE from 'three/webgpu';
import type { CasingKind, GameEvents, WeaponClass, WeaponDef } from '../game/contracts';
import type { Surface } from '../world/types';
import type { DemoConfig, DemoName } from './demo-config';
import { randRange, type FxEnv, type FxModule } from './shared';

const SURFACES: readonly Surface[] = [
  'concrete',
  'plaster',
  'asphalt',
  'cobble',
  'metal',
  'wood',
  'dirt',
  'gravel',
  'sand',
  'grass',
  'water',
  'glass',
  'foliage',
];
const IMPACT_INTERVAL = 0.17;
const IMPACT_COLUMNS = 7;
const IMPACT_SPACING = 1.15;
const IMPACT_NEAR = 4.5;
const IMPACT_FAR = 7.5;
const GUN_INTERVAL = 60 / 700;
const GUN_BURST_SECONDS = 1.3;
const GUN_PAUSE_SECONDS = 1.1;
const MAX_RANGE = 300;
const CASING_FOR: Readonly<Record<WeaponClass, CasingKind>> = {
  pistol: 'pistol',
  smg: 'pistol',
  rifle: 'rifle',
  carbine: 'rifle',
  sniper: 'rifle',
  lmg: 'rifle',
  shotgun: 'shotgun',
};
const VELOCITY_FOR: Readonly<Record<WeaponClass, number>> = {
  pistol: 360,
  smg: 400,
  rifle: 850,
  carbine: 880,
  sniper: 900,
  lmg: 850,
  shotgun: 400,
};

/** A stand-in weapon so the demos do not depend on the weapons subsystem. */
function demoWeapon(weaponClass: WeaponClass): WeaponDef {
  return {
    id: `fxdemo-${weaponClass}`,
    name: 'Effects demo',
    weaponClass,
    slot: 1,
    fireMode: 'auto',
    roundsPerMinute: 700,
    damage: 0,
    headshotMultiplier: 1,
    limbMultiplier: 1,
    falloffStart: 0,
    falloffEnd: 1,
    falloffMin: 1,
    range: MAX_RANGE,
    muzzleVelocity: VELOCITY_FOR[weaponClass],
    pellets: weaponClass === 'shotgun' ? 9 : 1,
    spreadHip: 1,
    spreadAim: 1,
    spreadMoving: 1,
    recoil: { vertical: 0, horizontal: 0, recovery: 1, kickback: 0 },
    magazineSize: 30,
    reserveAmmo: 0,
    reloadStyle: 'magazine',
    reloadTime: 1,
    aimTime: 0.2,
    aimZoom: 1,
    scoped: false,
    mobility: 1,
    casing: CASING_FOR[weaponClass],
    loudness: 1,
  };
}

/**
 * Developer aid: fires the events a firefight would, on timers, near the
 * camera. Lets every effect be seen and screenshotted before the weapons and
 * bots exist. Enabled with `&fxdemo=` (see `demo-config.ts`).
 */
export class FxDemo implements FxModule {
  private readonly timers = new Map<DemoName, number>();
  private readonly steps = new Map<DemoName, number>();
  private readonly weapons: Readonly<Record<WeaponClass, WeaponDef>>;
  private gunClock = 0;

  private readonly eye = new THREE.Vector3();
  private readonly feet = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly flatForward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();

  constructor(
    private readonly env: FxEnv,
    private readonly config: DemoConfig,
  ) {
    const classes: readonly WeaponClass[] = ['pistol', 'rifle', 'carbine', 'smg', 'shotgun', 'sniper', 'lmg'];
    this.weapons = Object.fromEntries(classes.map((each) => [each, demoWeapon(each)])) as Record<WeaponClass, WeaponDef>;
  }

  update(dt: number): void {
    this.readPose();
    if (this.due('impacts', IMPACT_INTERVAL, dt)) this.impact(false);
    if (this.due('walls', IMPACT_INTERVAL, dt)) this.impact(true);
    if (this.config.names.has('gun')) this.gun(dt);
    if (this.due('flash', 0.14, dt)) this.flash();
    if (this.due('tracers', 0.12, dt)) this.tracer();
    if (this.due('casings', 0.1, dt)) this.casing(this.weapons[this.config.weaponClass].casing, 0.6);
    if (this.due('blood', 0.45, dt)) this.blood();
    if (this.due('nearmiss', 0.9, dt)) this.nearMiss();
  }

  clear(): void {
    this.timers.clear();
    this.steps.clear();
    this.gunClock = 0;
  }

  dispose(): void {}

  /** true when the named demo is on and its timer has run out. Also advances its step counter. */
  private due(name: DemoName, interval: number, dt: number): boolean {
    if (!this.config.names.has(name)) return false;
    const remaining = (this.timers.get(name) ?? 0) - dt;
    if (remaining > 0) {
      this.timers.set(name, remaining);
      return false;
    }
    this.timers.set(name, interval);
    this.steps.set(name, (this.steps.get(name) ?? -1) + 1);
    return true;
  }

  private step(name: DemoName): number {
    return this.steps.get(name) ?? 0;
  }

  private readPose(): void {
    const player = this.env.ctx.player;
    player.eyePosition(this.eye);
    this.feet.copy(player.position);
    const cosPitch = Math.cos(player.pitch);
    // Yaw 0 looks down -Z; positive pitch looks up.
    this.forward.set(-Math.sin(player.yaw) * cosPitch, Math.sin(player.pitch), -Math.cos(player.yaw) * cosPitch);
    this.flatForward.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    this.right.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
    this.up.crossVectors(this.right, this.forward);
  }

  /** One impact per tick, cycling through every surface, each at its own spot in two rows ahead. */
  private impact(walls: boolean): void {
    const events = this.env.ctx.events;
    const index = this.step(walls ? 'walls' : 'impacts') % SURFACES.length;
    const column = (index % IMPACT_COLUMNS) - (IMPACT_COLUMNS - 1) / 2;
    const row = Math.floor(index / IMPACT_COLUMNS);
    const direction = this.a;
    if (walls) {
      direction
        .copy(this.forward)
        .addScaledVector(this.right, column * 0.11)
        .addScaledVector(this.up, row * 0.14 - 0.02)
        .normalize();
    } else {
      this.b
        .copy(this.feet)
        .addScaledVector(this.flatForward, row === 0 ? IMPACT_NEAR : IMPACT_FAR)
        .addScaledVector(this.right, column * IMPACT_SPACING);
      direction.subVectors(this.b, this.eye).normalize();
    }
    const hit = this.env.ctx.world.raycast(this.eye, direction, MAX_RANGE);
    if (!hit) return;
    events.emit('bulletImpact', { shooterId: -1, weapon: this.weapons.carbine, hit: { ...hit, surface: SURFACES[index]! } });
  }

  /** A full local weapon: flash, tracer, impact where it is aimed, and a casing, in bursts. */
  private gun(dt: number): void {
    this.gunClock += dt;
    const cycle = this.gunClock % (GUN_BURST_SECONDS + GUN_PAUSE_SECONDS);
    if (cycle > GUN_BURST_SECONDS) {
      this.timers.set('gun', 0);
      return;
    }
    const remaining = (this.timers.get('gun') ?? 0) - dt;
    this.timers.set('gun', remaining > 0 ? remaining : GUN_INTERVAL);
    if (remaining > 0) return;

    const ctx = this.env.ctx;
    const weapon = this.weapons[this.config.weaponClass];
    const muzzle = this.b
      .copy(this.eye)
      .addScaledVector(this.forward, 0.62)
      .addScaledVector(this.right, 0.13)
      .addScaledVector(this.up, -0.1);
    ctx.events.emit('shotFired', { shooterId: ctx.player.id, weapon, muzzle, direction: this.forward, local: true });
    for (let pellet = 0; pellet < weapon.pellets; pellet++) {
      const spread = weapon.pellets > 1 ? 0.05 : 0.012;
      const direction = this.a
        .copy(this.forward)
        .addScaledVector(this.right, randRange(-spread, spread))
        .addScaledVector(this.up, randRange(-spread, spread))
        .normalize();
      const hit = ctx.world.raycast(this.eye, direction, MAX_RANGE);
      const to = hit ? hit.point : this.c.copy(this.eye).addScaledVector(direction, MAX_RANGE);
      ctx.events.emit('bulletTrace', { shooterId: -1, weapon, from: muzzle, to, local: true });
      if (hit) ctx.events.emit('bulletImpact', { shooterId: -1, weapon, hit });
    }
    this.casing(weapon.casing, 0.3);
  }

  /** Three shooters ahead, one of each flash shape, fired side-on and toward the camera. */
  private flash(): void {
    const index = this.step('flash') % 3;
    const classes: readonly WeaponClass[] = ['rifle', 'shotgun', 'smg'];
    const weapon = this.weapons[classes[index]!];
    const muzzle = this.b
      .copy(this.feet)
      .addScaledVector(this.flatForward, 6.5)
      .addScaledVector(this.right, (index - 1) * 2.6);
    muzzle.y += 1.35;
    const direction = this.a;
    if (index === 1) direction.subVectors(this.eye, muzzle).addScaledVector(this.right, 1.6).normalize();
    else direction.copy(this.right).multiplyScalar(index === 0 ? 1 : -1).addScaledVector(this.flatForward, -0.25).normalize();
    this.fireFrom(weapon, muzzle, direction, -1);
  }

  /** Shooters ahead firing across the view, and now and then straight past the camera. */
  private tracer(): void {
    const step = this.step('tracers');
    const side = step % 2 === 0 ? 1 : -1;
    const muzzle = this.b
      .copy(this.feet)
      .addScaledVector(this.flatForward, 7 + (step % 3) * 2)
      .addScaledVector(this.right, -16 * side);
    muzzle.y += 1.5;
    const target = this.c;
    if (step % 4 === 3) {
      target
        .copy(this.eye)
        .addScaledVector(this.right, randRange(-3, 3))
        .addScaledVector(this.up, randRange(-0.6, 1))
        .addScaledVector(this.flatForward, -20);
    } else {
      target
        .copy(this.feet)
        .addScaledVector(this.flatForward, 6 + (step % 5) * 1.5)
        .addScaledVector(this.right, 18 * side);
      target.y += randRange(0.6, 2.4);
    }
    // No ray cast here: the point is to see the streak cross the whole view.
    const events = this.env.ctx.events;
    const weapon = this.weapons.rifle;
    events.emit('shotFired', { shooterId: -1, weapon, muzzle, direction: this.a.subVectors(target, muzzle).normalize(), local: false });
    events.emit('bulletTrace', { shooterId: -1, weapon, from: muzzle, to: target, local: false });
  }

  private fireFrom(weapon: WeaponDef, muzzle: THREE.Vector3, direction: THREE.Vector3, shooterId: number): void {
    const ctx = this.env.ctx;
    ctx.events.emit('shotFired', { shooterId, weapon, muzzle, direction, local: false });
    const hit = ctx.world.raycast(muzzle, direction, MAX_RANGE);
    const to = hit ? hit.point : this.c.copy(muzzle).addScaledVector(direction, MAX_RANGE);
    ctx.events.emit('bulletTrace', { shooterId: -1, weapon, from: muzzle, to, local: false });
    if (hit) ctx.events.emit('bulletImpact', { shooterId: -1, weapon, hit });
  }

  private casing(kind: CasingKind, ahead: number): void {
    const position = new THREE.Vector3()
      .copy(this.eye)
      .addScaledVector(this.forward, ahead)
      .addScaledVector(this.right, 0.16)
      .addScaledVector(this.up, -0.08);
    const velocity = new THREE.Vector3()
      .addScaledVector(this.right, randRange(1.8, 2.9))
      .addScaledVector(this.up, randRange(1, 2.1))
      .addScaledVector(this.forward, randRange(-0.5, 0.5));
    this.env.ctx.events.emit('casingEjected', { kind, position, velocity });
  }

  private blood(): void {
    const index = this.step('blood') % 3;
    const point = this.b
      .copy(this.feet)
      .addScaledVector(this.flatForward, 4)
      .addScaledVector(this.right, (index - 1) * 1.3);
    point.y += 1.9;
    const event: GameEvents['combatantHit'] = {
      weapon: this.weapons.carbine,
      targetId: -1,
      attackerId: -1,
      hit: { distance: 4, zone: 'torso', point },
      direction: this.flatForward.clone(),
      fatal: index === 2,
    };
    this.env.ctx.events.emit('combatantHit', event);
  }

  private nearMiss(): void {
    const ctx = this.env.ctx;
    const side = this.step('nearmiss') % 2 === 0 ? 1 : -1;
    const from = this.b
      .copy(this.eye)
      .addScaledVector(this.flatForward, 45)
      .addScaledVector(this.right, 6 * side);
    const to = this.c
      .copy(this.eye)
      .addScaledVector(this.flatForward, -12)
      .addScaledVector(this.right, 0.2 * side)
      .addScaledVector(this.up, 0.15);
    ctx.events.emit('bulletTrace', { shooterId: -1, weapon: this.weapons.rifle, from, to, local: false });
    // Closest point of that path to the eye.
    const path = this.a.subVectors(to, from);
    const along = Math.min(1, Math.max(0, new THREE.Vector3().subVectors(this.eye, from).dot(path) / path.lengthSq()));
    const point = new THREE.Vector3().copy(from).addScaledVector(path, along);
    ctx.events.emit('nearMiss', { point, direction: to.clone().sub(from).normalize(), weapon: this.weapons.rifle });
  }
}
