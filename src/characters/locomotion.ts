/**
 * Picks and times the gait clips from ground speed. Pure functions: the
 * soldier feeds in speed and gets clip weights and a stride phase back.
 */
import { CLIP_META } from './clip-meta';

export type GaitClip = 'idle' | 'walk' | 'jog' | 'run' | 'crouchIdle' | 'crouchWalk' | 'crouchJog';
export type GaitWeights = Record<GaitClip, number>;

export const GAIT_CLIPS: readonly GaitClip[] = ['idle', 'walk', 'jog', 'run', 'crouchIdle', 'crouchWalk', 'crouchJog'];
const MOVING_CLIPS = ['walk', 'jog', 'run', 'crouchWalk', 'crouchJog'] as const;

interface Band {
  readonly clip: GaitClip;
  /** The clip plays alone between these speeds; neighbours cross-fade in the gaps. */
  readonly from: number;
  readonly to: number;
}

/**
 * Speed bands in m/s. Each clip owns a band wide enough to cover the speeds
 * bots and players actually hold (walk 1.7, strafe 2.6, jog 3.4, run 5.2 and
 * up, crouch 1.8) so they play one clean clip rather than a mix of two.
 */
const STANDING: readonly Band[] = [
  { clip: 'idle', from: 0, to: 0.1 },
  { clip: 'walk', from: 0.8, to: 2.0 },
  { clip: 'jog', from: 2.5, to: 4.4 },
  { clip: 'run', from: 5.1, to: Infinity },
];
const CROUCHED: readonly Band[] = [
  { clip: 'crouchIdle', from: 0, to: 0.1 },
  { clip: 'crouchWalk', from: 0.5, to: 0.9 },
  { clip: 'crouchJog', from: 1.5, to: Infinity },
];

/** Fastest the legs may cycle, in strides per second, however fast the body is moved. */
const MAX_CADENCE = 2.4;
const MAX_HIP_YAW = (55 * Math.PI) / 180;
/** Movement more than this far off the facing is taken as backpedalling. */
const REVERSE_ANGLE = (105 * Math.PI) / 180;
const REVERSE_HYSTERESIS = (12 * Math.PI) / 180;

export function createGaitWeights(): GaitWeights {
  return { idle: 1, walk: 0, jog: 0, run: 0, crouchIdle: 0, crouchWalk: 0, crouchJog: 0 };
}

function addBands(bands: readonly Band[], speed: number, share: number, out: GaitWeights): void {
  if (share <= 0) return;
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i]!;
    const next = bands[i + 1];
    if (speed <= band.to || !next) {
      out[band.clip] += share;
      return;
    }
    if (speed < next.from) {
      const mix = (speed - band.to) / (next.from - band.to);
      out[band.clip] += share * (1 - mix);
      out[next.clip] += share * mix;
      return;
    }
  }
}

/**
 * Clip weights for a ground speed. `crouch` is 0 standing, 1 crouched, and
 * anything between while changing stance. Writes into `out` and returns it.
 */
export function gaitWeights(speed: number, crouch: number, out: GaitWeights): GaitWeights {
  for (const clip of GAIT_CLIPS) out[clip] = 0;
  const amount = Math.min(1, Math.max(0, crouch));
  const pace = Math.max(0, speed);
  addBands(STANDING, pace, 1 - amount, out);
  addBands(CROUCHED, pace, amount, out);
  return out;
}

/** Metres of ground one full cycle (two steps) covers for this mix of clips; Infinity when not moving. */
export function cycleLength(weights: GaitWeights): number {
  let length = 0;
  let total = 0;
  for (const clip of MOVING_CLIPS) {
    const weight = weights[clip];
    if (weight <= 0) continue;
    length += weight * CLIP_META[clip].speed * CLIP_META[clip].duration;
    total += weight;
  }
  return total > 1e-4 ? length / total : Infinity;
}

/**
 * Advances the stride phase (0 - 1, 0 = left foot lands) by the ground covered
 * this step, so planted feet match the ground instead of sliding over it.
 */
export function advancePhase(phase: number, speed: number, weights: GaitWeights, dt: number, reverse: boolean): number {
  const length = cycleLength(weights);
  if (!Number.isFinite(length) || speed <= 0) return phase;
  const cadence = Math.min(speed / length, MAX_CADENCE);
  const next = phase + (reverse ? -cadence : cadence) * dt;
  return next - Math.floor(next);
}

/** Time into a looping clip for a stride phase, with every gait lined up on the left foot strike. */
export function clipTimeAtPhase(clip: (typeof MOVING_CLIPS)[number], phase: number): number {
  const meta = CLIP_META[clip];
  const shifted = phase + meta.strike;
  return (shifted - Math.floor(shifted)) * meta.duration;
}

export function isMovingClip(clip: GaitClip): clip is (typeof MOVING_CLIPS)[number] {
  return clip !== 'idle' && clip !== 'crouchIdle';
}

export interface Heading {
  /** Radians the hips turn away from the facing, positive to the left. */
  readonly hipYaw: number;
  /** Play the gait backwards. */
  readonly reverse: boolean;
}

function wrapAngle(angle: number): number {
  return angle - Math.round(angle / (2 * Math.PI)) * 2 * Math.PI;
}

/**
 * How the legs handle movement that is not straight ahead. `moveAngle` is the
 * direction of travel relative to the facing (0 forwards, positive left). The
 * hips turn toward the travel direction while the chest keeps aiming, and
 * movement behind the soldier plays the gait in reverse.
 */
export function resolveHeading(moveAngle: number, wasReverse: boolean): Heading {
  const angle = wrapAngle(moveAngle);
  const threshold = REVERSE_ANGLE + (wasReverse ? -REVERSE_HYSTERESIS : REVERSE_HYSTERESIS);
  const reverse = Math.abs(angle) > threshold;
  const legs = reverse ? wrapAngle(angle - Math.PI) : angle;
  return { hipYaw: Math.min(MAX_HIP_YAW, Math.max(-MAX_HIP_YAW, legs)), reverse };
}
