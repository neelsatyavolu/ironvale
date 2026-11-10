/**
 * Chooses how a gunshot is layered: close crack against distant take, how
 * much of the recorded outdoor tail, the sub thump and mechanism for the
 * shooter, and the reverb send. Pure.
 */
import type { ReverbPreset } from '../world/types';

export interface ShotLayers {
  /** Close-microphone crack and body. */
  readonly close: number;
  /** Mid-distance take, which replaces the crack as range grows. */
  readonly distant: number;
  /** Recorded outdoor tail. */
  readonly tail: number;
  /** Low-pass on the tail in Hz. */
  readonly tailCutoff: number;
  /** Chest thump below 80 Hz, only for the shooter. */
  readonly sub: number;
  /** Action cycling, only for the shooter and bystanders within a few metres. */
  readonly mech: number;
  /** Level into the reverb for this environment. */
  readonly reverbSend: number;
}

interface Environment {
  readonly tail: number;
  readonly tailCutoff: number;
  readonly send: number;
}

/**
 * The recorded tails were made on an open range, so they are used in full
 * outdoors and held back where the reverb should supply the space instead.
 */
const ENVIRONMENTS: Readonly<Record<ReverbPreset, Environment>> = {
  'open-field': { tail: 1, tailCutoff: 9000, send: 0.16 },
  forest: { tail: 0.8, tailCutoff: 4200, send: 0.34 },
  street: { tail: 0.7, tailCutoff: 7000, send: 0.42 },
  industrial: { tail: 0.62, tailCutoff: 8000, send: 0.5 },
  interior: { tail: 0.16, tailCutoff: 3000, send: 0.72 },
};

/** Close takes carry to here at full level, then give way to the distant take. */
export const CLOSE_UNTIL = 35;
export const DISTANT_FROM = 130;
const MECH_RANGE = 7;

function smoothstep(from: number, to: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

export function chooseShotLayers(options: {
  /** true for the player's own weapon. */
  readonly local: boolean;
  /** Metres from the listener; ignored when `local`. */
  readonly distance: number;
  readonly environment: ReverbPreset;
}): ShotLayers {
  const env = ENVIRONMENTS[options.environment];
  if (options.local) {
    return { close: 1, distant: 0, tail: env.tail, tailCutoff: env.tailCutoff, sub: 0.9, mech: 0.4, reverbSend: env.send };
  }
  const far = smoothstep(CLOSE_UNTIL, DISTANT_FROM, options.distance);
  // Equal-power crossfade so the shot does not dip half-way between the two takes.
  const close = Math.cos((far * Math.PI) / 2);
  const distant = Math.sin((far * Math.PI) / 2);
  return {
    close,
    distant,
    // Far away the distant take already holds its own reflections.
    tail: env.tail * (1 - 0.45 * far),
    tailCutoff: env.tailCutoff,
    sub: 0,
    mech: options.distance < MECH_RANGE ? 0.3 * (1 - options.distance / MECH_RANGE) : 0,
    reverbSend: env.send * (1 - 0.3 * far),
  };
}

/** The reverb in force: the interior zone's preset under a roof, the map's own outside. */
export function activeReverb(mapPreset: ReverbPreset, indoors: boolean, zonePreset: ReverbPreset | null): ReverbPreset {
  return indoors ? (zonePreset ?? 'interior') : mapPreset;
}
