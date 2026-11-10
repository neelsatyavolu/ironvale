/**
 * Distance, air absorption, propagation delay and occlusion curves. Pure
 * functions: the engine evaluates them when a sound starts and a few times a
 * second for loops.
 */

export type SoundClass = 'gunshot' | 'impact' | 'footstep' | 'foley' | 'voice' | 'casing' | 'ambient' | 'generic';

export interface DistanceProfile {
  /** Distance in metres at which the sound plays at full level. */
  readonly ref: number;
  /** Beyond this the sound is silent and is not started at all. */
  readonly max: number;
  /** 1 is physical inverse-distance falloff; lower carries further. */
  readonly rolloff: number;
  /** Distance over which air absorption halves the low-pass cutoff. */
  readonly airHalf: number;
  /** The low-pass never closes below this, in Hz. */
  readonly minCutoff: number;
  /** Sound arrives late by distance / speed of sound once it is far enough to notice. */
  readonly delayed: boolean;
}

export const PROFILES: Readonly<Record<SoundClass, DistanceProfile>> = {
  gunshot: { ref: 9, max: 700, rolloff: 0.6, airHalf: 60, minCutoff: 600, delayed: true },
  impact: { ref: 3, max: 140, rolloff: 1, airHalf: 45, minCutoff: 900, delayed: true },
  footstep: { ref: 1.6, max: 38, rolloff: 1, airHalf: 22, minCutoff: 1200, delayed: false },
  foley: { ref: 1.3, max: 28, rolloff: 1, airHalf: 18, minCutoff: 1400, delayed: false },
  voice: { ref: 2, max: 45, rolloff: 1, airHalf: 28, minCutoff: 1200, delayed: false },
  casing: { ref: 1, max: 16, rolloff: 1, airHalf: 14, minCutoff: 2500, delayed: false },
  ambient: { ref: 4, max: 70, rolloff: 0.9, airHalf: 40, minCutoff: 900, delayed: false },
  generic: { ref: 2, max: 60, rolloff: 1, airHalf: 30, minCutoff: 1000, delayed: false },
};

export const SPEED_OF_SOUND = 343;
/** Closer than this the delay is too short to hear and is skipped. */
export const DELAY_FROM_METRES = 30;
export const OPEN_CUTOFF = 20000;
const FADE_FRACTION = 0.15;

/** Inverse-distance gain (1 inside `ref`), fading to exactly 0 over the last part before `max`. */
export function distanceGain(distance: number, profile: DistanceProfile): number {
  if (distance >= profile.max) return 0;
  const d = Math.max(distance, profile.ref);
  const inverse = profile.ref / (profile.ref + profile.rolloff * (d - profile.ref));
  const fadeStart = profile.max * (1 - FADE_FRACTION);
  const fade = distance <= fadeStart ? 1 : 1 - (distance - fadeStart) / (profile.max - fadeStart);
  return inverse * fade;
}

/** Low-pass cutoff in Hz that stands in for air absorption: open up close, closing with distance. */
export function airCutoff(distance: number, profile: DistanceProfile): number {
  const beyond = Math.max(0, distance - profile.ref);
  return Math.max(profile.minCutoff, OPEN_CUTOFF * 0.5 ** (beyond / profile.airHalf));
}

/** Seconds a sound takes to arrive. 0 for classes that are never far away and inside the near threshold. */
export function propagationDelay(distance: number, profile: DistanceProfile): number {
  if (!profile.delayed || distance < DELAY_FROM_METRES) return 0;
  return distance / SPEED_OF_SOUND;
}

export interface Occlusion {
  readonly gain: number;
  /** Multiplies the air-absorption cutoff. */
  readonly cutoff: number;
}

export const CLEAR: Occlusion = { gain: 1, cutoff: 1 };
/** A wall between source and listener: quieter and much duller, never silent. */
export const BLOCKED: Occlusion = { gain: 0.42, cutoff: 0.16 };
const OCCLUDED_FLOOR_HZ = 450;

export function occlusionFor(blocked: boolean): Occlusion {
  return blocked ? BLOCKED : CLEAR;
}

/** Cutoff after air absorption and occlusion. */
export function finalCutoff(distance: number, profile: DistanceProfile, occlusion: Occlusion): number {
  return Math.max(OCCLUDED_FLOOR_HZ, airCutoff(distance, profile) * occlusion.cutoff);
}

/**
 * Hands out a fixed number of line-of-sight tests per frame. Sounds that ask
 * after the budget is spent start unoccluded rather than stall the frame.
 */
export class RaycastBudget {
  private left: number;

  constructor(private readonly perFrame: number) {
    this.left = perFrame;
  }

  reset(): void {
    this.left = this.perFrame;
  }

  take(): boolean {
    if (this.left <= 0) return false;
    this.left--;
    return true;
  }
}

export interface StepLevel {
  readonly volume: number;
  readonly pitch: number;
}

/** Footstep level: running is louder and a little higher, crouching is quiet. */
export function stepLevel(running: boolean, crouching: boolean): StepLevel {
  if (crouching) return { volume: 0.28, pitch: 0.97 };
  return running ? { volume: 0.85, pitch: 1.04 } : { volume: 0.5, pitch: 1 };
}

/** Landing level from fall speed in m/s: a hop is a scuff, a long drop is a thump. */
export function landingVolume(speed: number): number {
  return Math.min(1, Math.max(0.22, (speed - 1.5) / 8));
}
