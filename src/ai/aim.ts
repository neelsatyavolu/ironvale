import type { DifficultyProfile } from './difficulty';

const RAD_TO_DEG = 180 / Math.PI;
/** Tracking is lost twice as fast as it is gained. */
const LOSS_RATE = 2;
/** A jolt from being hit fades at this rate per second. */
const FLINCH_DECAY = 3;
const MOVING_PENALTY = 1.35;

/** Cone half-angle in degrees for shots that land within `metres` of the aim point at 20 m. */
export function aimErrorDegrees(metres: number): number {
  return Math.atan(metres / 20) * RAD_TO_DEG;
}

export type AimProfile = Pick<DifficultyProfile, 'aimErrorAt20m' | 'firstShotPenalty' | 'aimTightenRate' | 'trackingLag'>;

/**
 * How well a soldier is on target right now. The first shots at a newly seen
 * target are the widest; the aim settles the longer the target is tracked,
 * and opens up again against a crossing target, while the soldier moves, and
 * after it takes a hit. The result is handed to ballistics as the shot spread.
 */
export class AimModel {
  private readonly steady: number;
  private tracked = 0;
  private flinch = 0;

  constructor(private readonly profile: AimProfile) {
    this.steady = aimErrorDegrees(profile.aimErrorAt20m);
  }

  /** Start over on a new target. */
  reset(): void {
    this.tracked = 0;
  }

  update(dt: number, tracking: boolean): void {
    this.tracked = tracking ? this.tracked + dt : Math.max(0, this.tracked - dt * LOSS_RATE);
    this.flinch *= Math.exp(-dt * FLINCH_DECAY);
  }

  /** Knock the aim off by `degrees` (a hit, a near miss). */
  disturb(degrees: number): void {
    this.flinch += degrees;
  }

  /**
   * Spread cone half-angle in degrees for a shot now. `targetAngularSpeed` is
   * how fast the target crosses the soldier's view, in degrees per second.
   */
  spread(targetAngularSpeed: number, moving: boolean): number {
    const settle = Math.exp(-this.profile.aimTightenRate * this.tracked);
    const base = this.steady * (1 + (this.profile.firstShotPenalty - 1) * settle);
    return base * (moving ? MOVING_PENALTY : 1) + targetAngularSpeed * this.profile.trackingLag + this.flinch;
  }
}
