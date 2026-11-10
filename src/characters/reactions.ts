/** Short procedural reactions layered on the clips: hit flinches and firing recoil. */
import type { HitZone } from '../game/contracts';

/** Seconds to the peak of a flinch; it has faded by about seven times this. */
const FLINCH_RISE = 0.065;
/** Bots fire the carbine at about this interval; the shudder repeats at it while `firing` holds. */
const SHOT_INTERVAL = 0.095;
const RECOIL_DECAY = 24;

/** 0 at the hit, 1 at the peak a few hundredths later, then an exponential tail. */
export function flinchEnvelope(time: number): number {
  if (time <= 0 || !Number.isFinite(time)) return 0;
  const t = time / FLINCH_RISE;
  return t * Math.exp(1 - t);
}

/** Which bones jolt, in radians at the peak, for a hit to each zone. `side` is -1 or 1. */
export function flinchPose(zone: HitZone, side: number, strength: number, out: Flinch): void {
  out.headPitch = out.headYaw = out.torsoPitch = out.torsoYaw = out.hipsPitch = out.hipsRoll = 0;
  out.gunDip = 0.1 * strength;
  if (zone === 'head') {
    // The head snaps back and away, the shoulders follow a little.
    out.headPitch = 0.5 * strength;
    out.headYaw = 0.3 * side * strength;
    out.torsoPitch = 0.1 * strength;
  } else if (zone === 'torso') {
    // The chest is punched back and round; the head lags forward.
    out.torsoPitch = 0.2 * strength;
    out.torsoYaw = 0.28 * side * strength;
    out.headPitch = -0.2 * strength;
    out.hipsPitch = -0.06 * strength;
  } else {
    // A limb hit buckles the hips to one side.
    out.hipsRoll = 0.12 * side * strength;
    out.hipsPitch = -0.1 * strength;
    out.torsoYaw = 0.12 * side * strength;
    out.headPitch = -0.1 * strength;
  }
}

export class Flinch {
  headPitch = 0;
  headYaw = 0;
  torsoPitch = 0;
  torsoYaw = 0;
  hipsPitch = 0;
  hipsRoll = 0;
  /** Radians the muzzle drops while the shooter recovers. */
  gunDip = 0;
  private time = Infinity;
  private zone: HitZone = 'torso';
  private side = 1;

  get active(): boolean {
    return this.time < FLINCH_RISE * 9;
  }

  hit(zone: HitZone): void {
    this.zone = zone;
    this.time = 0;
    this.side = -this.side;
  }

  update(dt: number): void {
    if (!this.active) {
      if (this.gunDip !== 0) flinchPose(this.zone, this.side, 0, this);
      return;
    }
    this.time += dt;
    flinchPose(this.zone, this.side, flinchEnvelope(this.time), this);
  }

  reset(): void {
    this.time = Infinity;
    flinchPose(this.zone, this.side, 0, this);
  }
}

/** Repeating kick while the trigger is held: `value` jumps to 1 on each shot and decays. */
export class Recoil {
  value = 0;
  /** -1 to 1, which way this shot scattered. */
  side = 0;
  private untilShot = 0;
  private shots = 0;

  update(dt: number, firing: boolean): void {
    this.value *= Math.exp(-dt * RECOIL_DECAY);
    if (!firing) {
      this.untilShot = 0;
      return;
    }
    this.untilShot -= dt;
    if (this.untilShot > 0) return;
    this.untilShot += SHOT_INTERVAL;
    if (this.untilShot <= 0) this.untilShot = SHOT_INTERVAL;
    this.value = 1;
    // A fixed scatter sequence keeps soldiers cheap and screenshots repeatable.
    this.shots++;
    this.side = Math.sin(this.shots * 12.9898) * 0.9;
  }

  reset(): void {
    this.value = 0;
    this.untilShot = 0;
  }
}
