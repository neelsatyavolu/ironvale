/**
 * Shape of a small wooden fishing boat, as pure maths so it can be tested.
 * Boat coordinates: X runs stern (-) to bow (+), Y is up from the lowest point
 * of the keel, Z is across the beam.
 */

export interface HullForm {
  readonly length: number;
  readonly beam: number;
  /** Double-ended like a gozzo, or cut off square for an outboard. */
  readonly stern: 'pointed' | 'transom';
}

/** Height of the gunwale amidships above the keel. */
export const DEPTH = 0.95;
/** How deep the keel sits below the water. */
export const DRAFT = 0.34;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface Section {
  readonly gunwale: number;
  readonly keel: number;
  /** Half-breadth at girth parameter `s` (0 keel, 1 gunwale). */
  half(s: number): number;
  height(s: number): number;
  /** Hull half-width at a given height, 0 below the keel. */
  halfAt(y: number): number;
}

/** How full the section is at `t` along the length (0 stern, 1 bow), 0 - 1. */
export function fullness(t: number, form: HullForm): number {
  // The widest section sits a little aft of the middle and the bow is finer than the stern.
  const body = Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(t, 0.92))), 0.62);
  if (form.stern === 'transom' && t < 0.42) return Math.max(body, 0.78 + 0.22 * Math.sin((Math.PI / 2) * (t / 0.42)));
  return Math.max(0.025, body);
}

/** Section of the hull at `t` along its length (0 stern, 1 bow). */
export function section(t: number, form: HullForm): Section {
  const full = fullness(t, form);
  const end = Math.abs(2 * t - 1);
  const aft = t < 0.5;
  const square = form.stern === 'transom' && aft;
  // Sheer: the gunwale sweeps up to both ends, most at the bow.
  const gunwale = DEPTH + 0.3 * end * end * (aft ? (square ? 0.45 : 1) : 1.5);
  // Rocker: the keel rises toward the ends.
  const keel = 0.34 * end * end * end * (square ? 0.4 : 1);
  const halfBeam = (form.beam / 2) * full;
  return {
    gunwale,
    keel,
    half: (s) => halfBeam * Math.pow(s, 0.5),
    height: (s) => keel + (gunwale - keel) * Math.pow(s, 1.7),
    halfAt: (y) => {
      if (y <= keel) return 0;
      const s = Math.pow(Math.min(1, (y - keel) / (gunwale - keel)), 1 / 1.7);
      return halfBeam * Math.pow(s, 0.5);
    },
  };
}

/** Fore-and-aft position of a point on the hull: the stem rakes forward as it rises, and so does a pointed stern, aft. */
export function stationX(t: number, s: number, form: HullForm): number {
  const rake = form.length * 0.04 * s;
  const bow = smooth(0.62, 1, t);
  const sternward = form.stern === 'pointed' ? smooth(0.38, 0, t) : smooth(0.3, 0, t) * 0.35;
  return (t - 0.5) * form.length + rake * (bow - sternward);
}

/** Point on the hull surface on the +Z side. */
export function hullPoint(t: number, s: number, form: HullForm): readonly [number, number, number] {
  const shape = section(t, form);
  return [stationX(t, s, form), shape.height(s), shape.half(s)];
}
