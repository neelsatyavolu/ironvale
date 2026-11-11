import type { Object3D } from 'three/webgpu';
import { Quaternion, Vector3 } from 'three/webgpu';
import type { GunModel, WeaponDef } from '../../game/contracts';
import type { WeaponMachine } from '../machine';
import { markTime, type ActionPlan } from '../plans';
import { damp, ramp } from './motion';

/**
 * Moves a gun's parts (bolt, slide, magazine, feed cover) in time with
 * the weapon machine's action plan, so each motion ends on the mark where its
 * sound plays. Also reports how far the gun body and the hands should move
 * into their reload and bolt-working poses.
 */

const SLIDE_BACK_SECONDS = 0.02;
const SLIDE_RETURN_SECONDS = 0.055;
const MAG_DROP_METRES = 0.3;
const MAG_TOWARD_SHOOTER = 0.04;
const MAG_FALL_SECONDS = 0.24;
const MAG_SEAT_SECONDS = 0.3;
const BOLT_LIFT_RADIANS = 1.05;
const COVER_OPEN_RADIANS = 1.05;
const TRIGGER_PULL_RADIANS = 0.32;
const TRIGGER_HOLD_SECONDS = 0.05;
const TRIGGER_RELEASE_SECONDS = 0.1;
const WEIGHT_RATE = 14;
const RELEASE_RATE = 70;

interface Rest {
  readonly part: Object3D;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
}

const Z_AXIS = new Vector3(0, 0, 1);
const X_AXIS = new Vector3(1, 0, 0);
const turn = new Quaternion();

/** Guns whose bolt or slide stays back on an empty magazine. */
function locksOpen(def: WeaponDef): boolean {
  if (def.fireMode !== 'semi' && def.fireMode !== 'auto') return false;
  return def.weaponClass === 'carbine';
}

export class PartsAnimator {
  /** 0 - 1: gun body in its reload pose. */
  tilt = 0;
  /** 0 - 1: gun body canted for working a bolt. */
  work = 0;
  /** 0 - 1 bump as a magazine goes home. */
  seat = 0;
  /** 0 - 1: support hand has left the fore-end for the magazine or feed cover. */
  supportAway = 0;
  /** 0 - 1: firing hand is on the bolt handle. */
  triggerAway = 0;
  /** How far the magazine is out, 0 - 1. */
  magazineOut = 0;

  private sinceShot = Infinity;
  private held = 0;
  private readonly rests: Rest[] = [];
  private readonly manual: boolean;
  private readonly locks: boolean;

  constructor(
    private readonly model: GunModel,
    private readonly def: WeaponDef,
  ) {
    this.manual = def.fireMode === 'bolt';
    this.locks = locksOpen(def);
    for (const part of Object.values(model.parts)) {
      if (part) this.rests.push({ part, position: part.position.clone(), quaternion: part.quaternion.clone() });
    }
  }

  fired(): void {
    this.sinceShot = 0;
  }

  reset(): void {
    this.sinceShot = Infinity;
    this.held = 0;
    this.tilt = this.work = this.seat = this.supportAway = this.triggerAway = this.magazineOut = 0;
  }

  update(dt: number, machine: WeaponMachine): void {
    this.sinceShot += dt;
    for (let i = 0; i < this.rests.length; i++) {
      const rest = this.rests[i]!;
      rest.part.position.copy(rest.position);
      rest.part.quaternion.copy(rest.quaternion);
    }
    const action = machine.action;
    const time = machine.actionTime;
    const parts = this.model.parts;
    const travel = this.model.cycleTravel;

    let tilt = 0;
    let work = 0;
    let seat = 0;
    let supportAway = 0;
    let triggerAway = 0;
    let magazineOut = 0;
    let boltBack = 0;
    let boltLift = 0;
    let cover = 0;
    let holdOpen = this.locks && !machine.chambered && machine.magazine === 0;

    if (action) {
      const tLift = markTime(action, 'boltLift');
      const tBack = markTime(action, 'boltBack');
      const tForward = markTime(action, 'boltForward');
      const tClose = markTime(action, 'boltClose');
      const tMagOut = markTime(action, 'magOut');
      const tMagIn = markTime(action, 'magIn');
      const tOpen = markTime(action, 'beltOpen');
      const tShut = markTime(action, 'beltClose');

      if (action.kind === 'reload') {
        tilt = ramp(0, 0.22, time) * (1 - ramp(action.duration - 0.28, action.duration, time));
      } else {
        work = workWeight(action, time);
      }

      if (tMagOut >= 0 && tMagIn >= 0) {
        magazineOut = ramp(tMagOut - 0.02, tMagOut + MAG_FALL_SECONDS, time) * (1 - ramp(tMagIn - MAG_SEAT_SECONDS, tMagIn, time));
        supportAway = ramp(tMagOut - 0.24, tMagOut - 0.04, time) * (1 - ramp(tMagIn + 0.05, tMagIn + 0.3, time));
        seat = bump(time - tMagIn, 0.1);
      }
      if (tOpen >= 0) {
        cover = ramp(tOpen - 0.04, tOpen + 0.25, time) * (1 - ramp(tShut - 0.25, tShut, time));
        supportAway = Math.max(supportAway, ramp(tOpen - 0.2, tOpen, time) * (1 - ramp(tShut, tShut + 0.3, time)));
      }
      if (this.manual) {
        if (tLift >= 0) {
          boltLift = ramp(tLift - 0.09, tLift, time) * (1 - ramp(tClose - 0.07, tClose, time));
          triggerAway = ramp(tLift - 0.2, tLift - 0.05, time) * (1 - ramp(tClose, tClose + 0.18, time));
        }
        if (tBack >= 0) boltBack = ramp(tBack - 0.1, tBack, time) * (1 - ramp(tForward - 0.1, tForward, time));
      } else if (tBack >= 0) {
        // A self-loader's bolt pulled by hand: stays back until released, or snaps home when only charged.
        const until = tForward >= 0 ? tForward : tBack + 0.16;
        if (time > tBack - 0.1 && time < until) holdOpen = true;
      }
    }

    this.tilt = damp(this.tilt, tilt, WEIGHT_RATE, dt);
    this.work = damp(this.work, work, WEIGHT_RATE, dt);
    this.supportAway = damp(this.supportAway, supportAway, WEIGHT_RATE, dt);
    this.triggerAway = damp(this.triggerAway, triggerAway, WEIGHT_RATE, dt);
    this.seat = seat;
    this.magazineOut = magazineOut;

    // Self-loaders: the bolt or slide snaps back and home with each shot, and stays back when locked open.
    let slide = 0;
    if (!this.manual) {
      const t = this.sinceShot;
      const pulse = t < SLIDE_BACK_SECONDS ? t / SLIDE_BACK_SECONDS : Math.max(0, 1 - (t - SLIDE_BACK_SECONDS) / SLIDE_RETURN_SECONDS);
      this.held = holdOpen ? damp(this.held, 1, RELEASE_RATE, dt) : damp(this.held, 0, RELEASE_RATE, dt);
      slide = Math.max(pulse, this.held);
    } else {
      slide = boltBack;
    }

    // The trigger blade swings back about its pin with each shot.
    if (parts.trigger && this.sinceShot < TRIGGER_HOLD_SECONDS + TRIGGER_RELEASE_SECONDS) {
      const squeeze = 1 - Math.max(0, this.sinceShot - TRIGGER_HOLD_SECONDS) / TRIGGER_RELEASE_SECONDS;
      parts.trigger.quaternion.multiply(turn.setFromAxisAngle(X_AXIS, -TRIGGER_PULL_RADIANS * squeeze));
    }
    if (parts.slide) parts.slide.position.z += travel * slide;
    if (parts.bolt) {
      parts.bolt.position.z += travel * slide;
      if (boltLift > 0) parts.bolt.quaternion.multiply(turn.setFromAxisAngle(Z_AXIS, boltLift * BOLT_LIFT_RADIANS));
    }
    if (parts.chargingHandle && !this.manual && this.held > 0 && this.def.reloadStyle === 'belt') {
      parts.chargingHandle.position.z += travel * this.held;
    }
    if (parts.cover && cover > 0) parts.cover.quaternion.multiply(turn.setFromAxisAngle(X_AXIS, cover * COVER_OPEN_RADIANS));
    if (parts.magazine) {
      parts.magazine.position.y -= MAG_DROP_METRES * magazineOut;
      parts.magazine.position.z += MAG_TOWARD_SHOOTER * magazineOut;
      parts.magazine.visible = magazineOut < 0.97;
    }
  }
}

function workWeight(action: ActionPlan, time: number): number {
  return ramp(action.handsFrom, action.handsFrom + 0.12, time) * (1 - ramp(action.handsTo - 0.06, action.handsTo + 0.12, time));
}

/** 1 at t = 0, falling to 0 at +/- width. */
function bump(t: number, width: number): number {
  const x = Math.abs(t) / width;
  return x >= 1 ? 0 : 1 - x * x * (3 - 2 * x);
}
