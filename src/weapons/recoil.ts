import type { WeaponDef } from '../game/contracts';

/** What the shooter's body is doing when a shot breaks. */
export interface Stance {
  /** 0 hip, 1 aimed. */
  readonly aimBlend: number;
  readonly crouching: boolean;
  /** Horizontal speed, m/s. */
  readonly speed: number;
  readonly airborne: boolean;
}

const DEG = Math.PI / 180;
const GROWTH_PER_SHOT = 0.045;
const MAX_HEAT = 9;
/** Heat holds for this long after a shot, then drains: a pause between bursts resets the climb. */
const HEAT_HOLD_SECONDS = 0.14;
const HEAT_DRAIN_PER_SECOND = 14;
const AIMED_KICK = 0.75;
const CROUCHED = 0.8;
/** Extra cone per shot and its ceiling, as fractions of the hip spread. */
const BLOOM_PER_SHOT = 0.16;
const MAX_BLOOM = 1;
const BLOOM_RECOVERY = 5;
const AIMED_BLOOM = 0.2;
const AIMED_MOVE = 0.35;
/** Speed at which the moving penalty is fully applied (a brisk walk). */
const FULL_MOVE_SPEED = 5;
const AIR_SPREAD_FACTOR = 0.6;
const AIR_SPREAD_MIN = 1;

/**
 * Per-shot view kick and the firing cone. Kick climbs a little through a
 * sustained burst; the cone opens with movement and sustained fire and closes
 * again within about half a second.
 */
export class RecoilModel {
  /** Degrees to pass to `PlayerBody.addRecoil` for the last shot. */
  kickPitch = 0;
  kickYaw = 0;
  private heat = 0;
  private bloom = 0;
  private sinceShot = Infinity;

  constructor(private readonly random: () => number = Math.random) {}

  shot(def: WeaponDef, stance: Stance): void {
    const growth = 1 + GROWTH_PER_SHOT * Math.min(this.heat, MAX_HEAT);
    const steadied = (1 - (1 - AIMED_KICK) * stance.aimBlend) * (stance.crouching ? CROUCHED : 1);
    this.kickPitch = def.recoil.vertical * growth * steadied;
    this.kickYaw = (this.random() * 2 - 1) * def.recoil.horizontal * growth * steadied;
    this.heat = Math.min(this.heat + 1, MAX_HEAT);
    this.bloom = Math.min(this.bloom + BLOOM_PER_SHOT * def.spreadHip, MAX_BLOOM * def.spreadHip);
    this.sinceShot = 0;
  }

  update(dt: number): void {
    this.sinceShot += dt;
    if (this.sinceShot > HEAT_HOLD_SECONDS) this.heat = Math.max(0, this.heat - dt * HEAT_DRAIN_PER_SECOND);
    this.bloom *= Math.exp(-dt * BLOOM_RECOVERY);
  }

  /** Cone half-angle in degrees for a shot fired now. */
  spread(def: WeaponDef, stance: Stance): number {
    const aim = stance.aimBlend;
    const base = def.spreadHip + (def.spreadAim - def.spreadHip) * aim;
    const moving = def.spreadMoving * Math.min(1, stance.speed / FULL_MOVE_SPEED) * (1 - (1 - AIMED_MOVE) * aim);
    const bloom = this.bloom * (1 - (1 - AIMED_BLOOM) * aim);
    const air = stance.airborne ? Math.max(AIR_SPREAD_MIN, def.spreadHip * AIR_SPREAD_FACTOR) : 0;
    return (base + moving + bloom + air) * (stance.crouching ? CROUCHED : 1);
  }

  reset(): void {
    this.heat = 0;
    this.bloom = 0;
    this.sinceShot = Infinity;
  }
}

/** These two rates match how `PlayerController` applies and recovers view kick. */
const KICK_APPLY_RATE = 38;
const KICK_RETURN_RATE = 6.5;

/**
 * Predicts how far the body turns the view this frame because of recoil, so
 * aim assist can tell the player's own hand movement from the gun's kick. Feed
 * it the same values given to `PlayerBody.addRecoil`.
 */
export class ViewKickMirror {
  /** Radians the view moved this step because of recoil. */
  deltaPitch = 0;
  deltaYaw = 0;
  private pendingPitch = 0;
  private pendingYaw = 0;
  private returnPitch = 0;
  private returnYaw = 0;

  add(pitchDegrees: number, yawDegrees: number, recovery: number): void {
    const pitch = pitchDegrees * DEG;
    const yaw = yawDegrees * DEG;
    this.pendingPitch += pitch;
    this.pendingYaw += yaw;
    this.returnPitch += pitch * recovery;
    this.returnYaw += yaw * recovery;
  }

  step(dt: number): void {
    const apply = 1 - Math.exp(-dt * KICK_APPLY_RATE);
    const kickPitch = this.pendingPitch * apply;
    const kickYaw = this.pendingYaw * apply;
    this.pendingPitch -= kickPitch;
    this.pendingYaw -= kickYaw;
    const back = 1 - Math.exp(-dt * KICK_RETURN_RATE);
    const backPitch = this.returnPitch * back;
    const backYaw = this.returnYaw * back;
    this.returnPitch -= backPitch;
    this.returnYaw -= backYaw;
    this.deltaPitch = kickPitch - backPitch;
    this.deltaYaw = kickYaw - backYaw;
  }

  reset(): void {
    this.pendingPitch = this.pendingYaw = this.returnPitch = this.returnYaw = 0;
    this.deltaPitch = this.deltaYaw = 0;
  }
}
