import { ALLEY, RAMP, TERRACE_Y } from './layout';

/** Plan grid the street lighting is baked on: `cols` by `rows` square cells from (x0, z0). */
export interface ShadeGrid {
  readonly x0: number;
  readonly z0: number;
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
}

export const SHADE_GRID: ShadeGrid = { x0: -56, z0: -26, cell: 0.75, cols: 150, rows: 102 };

/** Heights are stored in one byte: this many metres above `HEIGHT_FLOOR` fill the range. */
export const HEIGHT_RANGE = 40;
export const HEIGHT_FLOOR = -2;

/** Tier boundaries of the terraced town, shared with the shader version in grime.ts. */
export const TIER_Z = [-15.8, -34, -48] as const;
export const TIER_Y = [TERRACE_Y, 9.2, 17.4] as const;

/** Height of the street at a point in plan: the same terraces, alley steps and ramp the wall shader uses. */
export function streetLevel(x: number, z: number): number {
  let tiers = 0;
  for (let i = 0; i < TIER_Z.length; i++) if (z <= TIER_Z[i]!) tiers = TIER_Y[i]!;
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
  let climb = 0;
  if (x >= ALLEY.x0 - 0.3 && x <= ALLEY.x1 + 0.3) climb = clamp01((ALLEY.stepsFromZ - z) / (ALLEY.risers * ALLEY.tread)) * TERRACE_Y;
  if (x >= RAMP.x0 - 0.3 && x <= RAMP.x1 + 0.3) climb = Math.max(climb, clamp01((RAMP.z1 - z) / (RAMP.z1 - RAMP.z0)) * TERRACE_Y);
  return Math.max(tiers, climb);
}

/** Box blur of `passes` rounds; edges clamp. Returns a new array. */
export function boxBlur(values: Float32Array, cols: number, rows: number, radius: number, passes: number): Float32Array {
  let from = Float32Array.from(values);
  let to = new Float32Array(values.length);
  const span = radius * 2 + 1;
  for (let pass = 0; pass < passes * 2; pass++) {
    const alongX = pass % 2 === 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const c = alongX ? Math.min(cols - 1, Math.max(0, col + k)) : col;
          const r = alongX ? row : Math.min(rows - 1, Math.max(0, row + k));
          sum += from[r * cols + c]!;
        }
        to[row * cols + col] = sum / span;
      }
    }
    [from, to] = [to, from];
  }
  return from;
}

/**
 * Blur that ignores masked cells (the insides of buildings), so light does
 * not drain into walls: the blurred value over the blurred coverage.
 */
export function blurOpen(values: Float32Array, solid: Uint8Array, cols: number, rows: number, radius: number, passes: number): Float32Array {
  const weighted = new Float32Array(values.length);
  const cover = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const free = solid[i] ? 0 : 1;
    weighted[i] = values[i]! * free;
    cover[i] = free;
  }
  const top = boxBlur(weighted, cols, rows, radius, passes);
  const bottom = boxBlur(cover, cols, rows, radius, passes);
  const out = new Float32Array(values.length);
  for (let i = 0; i < out.length; i++) out[i] = bottom[i]! > 1e-4 ? top[i]! / bottom[i]! : 0;
  return out;
}

/** Grows the largest value outward by one cell per pass (8 neighbours). */
export function spreadMax(values: Float32Array, cols: number, rows: number, passes: number): Float32Array {
  let from = Float32Array.from(values);
  let to = new Float32Array(values.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        let best = 0;
        for (let dr = -1; dr <= 1; dr++) {
          const r = row + dr;
          if (r < 0 || r >= rows) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const c = col + dc;
            if (c < 0 || c >= cols) continue;
            best = Math.max(best, from[r * cols + c]!);
          }
        }
        to[row * cols + col] = best;
      }
    }
    [from, to] = [to, from];
  }
  return from;
}

export const toByte = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);
