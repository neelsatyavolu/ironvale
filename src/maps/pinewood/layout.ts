import type { Surface } from '../../world/types';

/**
 * Pinewood layout: every position and height in the level comes from the pure
 * functions in this file, so geometry, colliders, scatter and tests agree.
 * +Z is south (player end), -Z is north (enemy end), +X is east.
 */

export interface Point {
  readonly x: number;
  readonly z: number;
}

export interface Rect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** Area the player can walk in. The bank and the invisible wall start just outside it. */
export const PLAY: Rect = { minX: -48, maxX: 48, minZ: -54, maxZ: 54 };
/** How far past PLAY the invisible wall stands (it is buried in the foot of the bank). */
export const WALL_OFFSET = 1.8;
/** Heightfield extent and resolution. */
export const FIELD: Rect = { minX: -78, maxX: 78, minZ: -84, maxZ: 84 };
export const CELL = 1;

export const TRAIL_HALF_WIDTH = 1.7;
export const CREEK_BED_HALF = 2.3;
export const CREEK_BANK = 2.8;
export const CREEK_DEPTH = 1.45;
export const RIDGE_HEIGHT = 2.6;
const BANK_HEIGHT = 5.5;
const BANK_RUN = 5.5;

export const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1]. */
export function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = mix(hash2(ix, iz, seed), hash2(ix + 1, iz, seed), ux);
  const b = mix(hash2(ix, iz + 1, seed), hash2(ix + 1, iz + 1, seed), ux);
  return mix(a, b, uz);
}

/** Catmull-Rom through the control points, sampled every span into `steps` segments. */
function smoothPath(points: readonly Point[], steps = 10): readonly Point[] {
  const out: Point[] = [];
  const at = (i: number): Point => points[Math.min(points.length - 1, Math.max(0, i))] as Point;
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const blend = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push({ x: blend(p0.x, p1.x, p2.x, p3.x), z: blend(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  out.push(at(points.length - 1));
  return out;
}

/** Dirt trail, south to north. The central route and the longest sight line. */
export const TRAIL = smoothPath([
  { x: 7, z: 70 },
  { x: 7.6, z: 50 },
  { x: 7.2, z: 46.5 },
  { x: 2.6, z: 40.5 },
  { x: 2, z: 28 },
  { x: -3.2, z: 9 },
  { x: -3, z: -10 },
  { x: 4, z: -28 },
  { x: 8, z: -46 },
  { x: 6, z: -70 },
]);

/** Dry creek, north to south along the west side. A sunken flanking route. */
export const CREEK = smoothPath([
  { x: -25, z: -72 },
  { x: -28, z: -44 },
  { x: -22, z: -26 },
  { x: -26, z: -8 },
  { x: -34, z: 9 },
  { x: -31, z: 27 },
  { x: -37, z: 44 },
  { x: -38, z: 72 },
]);

export function distanceToPath(path: readonly Point[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i] as Point;
    const b = path[i + 1] as Point;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    const px = a.x + dx * t - x;
    const pz = a.z + dz * t - z;
    const d = px * px + pz * pz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Point on a path nearest to a z coordinate, with the path's heading there (yaw, 0 looks down -Z). */
export function pathAtZ(path: readonly Point[], z: number): Point & { readonly yaw: number } {
  let index = 0;
  for (let i = 1; i < path.length - 1; i++) {
    if (Math.abs((path[i] as Point).z - z) < Math.abs((path[index] as Point).z - z)) index = i;
  }
  const a = path[Math.max(0, index - 1)] as Point;
  const b = path[Math.min(path.length - 1, index + 1)] as Point;
  return { ...(path[index] as Point), yaw: Math.atan2(-(b.x - a.x), -(b.z - a.z)) };
}

export function distanceOutside(rect: Rect, x: number, z: number): number {
  return Math.hypot(Math.max(rect.minX - x, 0, x - rect.maxX), Math.max(rect.minZ - z, 0, z - rect.maxZ));
}

/** Where the ridge's foot runs, as an x for each z. It wanders so the slope is not a straight line. */
export const ridgeEdge = (z: number): number => 26.5 + 3.5 * Math.sin(z / 13) + 1.5 * Math.sin(z / 5.3 + 1.2);

/** Flattened building pads. Height is filled in from the natural ground at the centre. */
interface PadSpec extends Rect {
  readonly blend: number;
  /** Where to read the pad's height from; the rectangle's centre when omitted. */
  readonly anchor?: Point;
}
export const CABIN = { x: -13, z: -5, width: 7.4, depth: 5.4 } as const;
export const STAND = { x: 30.5, z: 3 } as const;
export const SHED = { x: -9, z: -14.5, width: 3.8, depth: 2.4 } as const;
export const FIRE_PIT = { x: -5.6, z: -0.4 } as const;
export const TRAILER = { z: 17.5 } as const;

const PAD_SPECS = {
  cabin: {
    minX: CABIN.x - CABIN.width / 2 - 0.6,
    maxX: CABIN.x + CABIN.width / 2 + 0.6,
    minZ: CABIN.z - CABIN.depth / 2 - 0.6,
    maxZ: CABIN.z + CABIN.depth / 2 + 0.6,
    blend: 3,
  },
  // The stand sits on the ridge's shoulder; anchoring near the deck keeps the slope below it gentle.
  stand: {
    minX: STAND.x - 2,
    maxX: STAND.x + 6.6,
    minZ: STAND.z - 2,
    maxZ: STAND.z + 2,
    blend: 5.5,
    anchor: { x: STAND.x + 1.2, z: STAND.z },
  },
  shed: {
    minX: SHED.x - SHED.width / 2 - 0.4,
    maxX: SHED.x + SHED.width / 2 + 0.4,
    minZ: SHED.z - SHED.depth / 2 - 0.4,
    maxZ: SHED.z + SHED.depth / 2 + 1.2,
    blend: 2.5,
  },
} satisfies Record<string, PadSpec>;

/** Ground before pads, creek and boundary bank are applied. */
function naturalHeight(x: number, z: number): number {
  const broad = (valueNoise(x / 38, z / 38, 11) - 0.5) * 2.4 + (valueNoise(x / 17, z / 17, 23) - 0.5) * 1.0;
  const fine = (valueNoise(x / 6.5, z / 6.5, 37) - 0.5) * 0.3;
  const edge = ridgeEdge(z);
  const ridge = RIDGE_HEIGHT * smoothstep(edge - 4.5, edge + 4.5, x);
  // A low rocky knoll between the trail and the ridge breaks the centre into two lanes.
  const knoll = 1.3 * Math.exp(-((x - 14) ** 2 + (z + 9) ** 2) / 70);
  const onTrail = 1 - smoothstep(TRAIL_HALF_WIDTH, TRAIL_HALF_WIDTH + 2.5, distanceToPath(TRAIL, x, z));
  return broad + ridge + knoll + fine * (1 - onTrail) - 0.07 * onTrail;
}

export const PADS = Object.fromEntries(
  Object.entries(PAD_SPECS).map(([name, spec]: [string, PadSpec]) => [
    name,
    {
      ...spec,
      height: spec.anchor
        ? naturalHeight(spec.anchor.x, spec.anchor.z)
        : naturalHeight((spec.minX + spec.maxX) / 2, (spec.minZ + spec.maxZ) / 2),
    },
  ]),
) as Record<keyof typeof PAD_SPECS, PadSpec & { readonly height: number }>;

/** Exact terrain height. Slow (two path searches); use `Heightfield.sample` for bulk queries. */
export function terrainHeight(x: number, z: number): number {
  let h = naturalHeight(x, z);
  for (const pad of Object.values(PADS)) {
    const w = 1 - smoothstep(0, pad.blend, distanceOutside(pad, x, z));
    if (w > 0) h = mix(h, pad.height, w);
  }
  const creek = distanceToPath(CREEK, x, z);
  const carve = 1 - smoothstep(CREEK_BED_HALF, CREEK_BED_HALF + CREEK_BANK, creek);
  if (carve > 0) h -= CREEK_DEPTH * carve - (valueNoise(x / 2.3, z / 2.3, 53) - 0.5) * 0.14 * carve;
  const outside = distanceOutside(PLAY, x, z);
  if (outside > 0) h += BANK_HEIGHT * smoothstep(0, BANK_RUN, outside) + 1.5 * smoothstep(5, 26, outside);
  return h;
}

/** 0 - 1 weights that paint the terrain: x = trail dirt, y = creek gravel, z = worn bare earth. */
export function terrainPaint(x: number, z: number): readonly [number, number, number] {
  const ragged = (valueNoise(x / 1.9, z / 1.9, 71) - 0.5) * 0.9;
  const trail = 1 - smoothstep(TRAIL_HALF_WIDTH - 0.5, TRAIL_HALF_WIDTH + 1.1, distanceToPath(TRAIL, x, z) + ragged);
  const creek =
    1 - smoothstep(CREEK_BED_HALF + 0.2, CREEK_BED_HALF + CREEK_BANK * 0.75, distanceToPath(CREEK, x, z) + ragged);
  const yard = Math.max(
    1 - smoothstep(0.5, 4, distanceOutside(PADS.cabin, x, z) + ragged * 2),
    1 - smoothstep(1.5, 4.5, Math.hypot(x - FIRE_PIT.x, z - FIRE_PIT.z) + ragged * 2),
    1 - smoothstep(0, 2.5, distanceOutside(PADS.shed, x, z) + ragged * 2),
    (1 - smoothstep(0, 2, distanceOutside(PADS.stand, x, z) + ragged * 2)) * 0.7,
  );
  return [trail, creek, yard];
}

export function surfaceAt(x: number, z: number): Surface {
  if (distanceToPath(CREEK, x, z) < CREEK_BED_HALF + 0.8) return 'gravel';
  if (distanceToPath(TRAIL, x, z) < TRAIL_HALF_WIDTH + 0.3) return 'dirt';
  if (distanceOutside(PADS.cabin, x, z) < 0.5) return 'dirt';
  return 'grass';
}

/** Terrain heights on a regular grid, with the same triangle split the meshes use. */
export class Heightfield {
  readonly columns = Math.round((FIELD.maxX - FIELD.minX) / CELL) + 1;
  readonly rows = Math.round((FIELD.maxZ - FIELD.minZ) / CELL) + 1;
  readonly heights = new Float32Array(this.columns * this.rows);

  constructor() {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.columns; c++) {
        this.heights[r * this.columns + c] = terrainHeight(FIELD.minX + c * CELL, FIELD.minZ + r * CELL);
      }
    }
  }

  at(column: number, row: number): number {
    const c = Math.min(this.columns - 1, Math.max(0, column));
    const r = Math.min(this.rows - 1, Math.max(0, row));
    return this.heights[r * this.columns + c] as number;
  }

  /** Height of the rendered and collidable surface at a point. */
  sample(x: number, z: number): number {
    const gx = Math.min(this.columns - 1.001, Math.max(0, (x - FIELD.minX) / CELL));
    const gz = Math.min(this.rows - 1.001, Math.max(0, (z - FIELD.minZ) / CELL));
    const c = Math.floor(gx);
    const r = Math.floor(gz);
    const fx = gx - c;
    const fz = gz - r;
    const h00 = this.at(c, r);
    const h10 = this.at(c + 1, r);
    const h01 = this.at(c, r + 1);
    const h11 = this.at(c + 1, r + 1);
    // Cells are split along the (c, r+1) - (c+1, r) diagonal.
    return fx + fz <= 1 ? h00 + (h10 - h00) * fx + (h01 - h00) * fz : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  /** Steepest slope around a point, as rise over run. */
  slope(x: number, z: number): number {
    const dx = (this.sample(x + CELL, z) - this.sample(x - CELL, z)) / (2 * CELL);
    const dz = (this.sample(x, z + CELL) - this.sample(x, z - CELL)) / (2 * CELL);
    return Math.hypot(dx, dz);
  }
}

export interface SpawnSpec extends Point {
  /** Yaw in radians; 0 looks down -Z (north). */
  readonly yaw: number;
}

/**
 * Players start at the south end of the trail, facing north. Two outcrops
 * (see rocks.ts) stand between them and the rest of the map, and the trail
 * winds between the two, so nothing up the trail has a line on the spawn.
 */
export const PLAYER_SPAWNS: readonly SpawnSpec[] = [
  { x: 7.4, z: 49.6, yaw: 0.05 },
  { x: 9.8, z: 50.8, yaw: 0.2 },
  { x: 5.0, z: 51.0, yaw: -0.1 },
  { x: 7.6, z: 52.2, yaw: 0.05 },
];

const SOUTH = Math.PI;
/** Enemies start across the north half and on both flanks. */
export const ENEMY_SPAWNS: readonly SpawnSpec[] = [
  { x: 7.6, z: -47, yaw: SOUTH },
  { x: 3, z: -37, yaw: SOUTH },
  { x: -27.5, z: -45, yaw: SOUTH },
  { x: -23, z: -30, yaw: SOUTH },
  { x: 39, z: -44, yaw: SOUTH },
  { x: 36, z: -27, yaw: SOUTH + 0.4 },
  { x: -41, z: -33, yaw: SOUTH - 0.5 },
  { x: -12, z: -43, yaw: SOUTH },
  { x: 20, z: -46, yaw: SOUTH + 0.3 },
  { x: 17, z: -27, yaw: SOUTH + 0.3 },
  { x: -42, z: -6, yaw: SOUTH - 1.1 },
  { x: 43, z: -9, yaw: SOUTH + 1.0 },
  { x: -8, z: -24, yaw: SOUTH },
];

/** Circles nothing may be scattered into: structures, spawns and props placed by hand. */
export interface KeepOut extends Point {
  readonly radius: number;
}

/** Row of circles that together cover a rectangle (corners included) plus a margin. */
export function rectKeepOuts(rect: Rect, margin: number): KeepOut[] {
  const width = rect.maxX - rect.minX;
  const depth = rect.maxZ - rect.minZ;
  const alongX = width >= depth;
  const long = Math.max(width, depth);
  const short = Math.min(width, depth);
  const count = Math.max(1, Math.ceil(long / short));
  const step = long / count;
  const radius = Math.hypot(short / 2, step / 2) + margin;
  return Array.from({ length: count }, (_, i) => {
    const along = step * (i + 0.5);
    return alongX
      ? { x: rect.minX + along, z: (rect.minZ + rect.maxZ) / 2, radius }
      : { x: (rect.minX + rect.maxX) / 2, z: rect.minZ + along, radius };
  });
}

export function isKeptOut(keepOuts: readonly KeepOut[], x: number, z: number, margin = 0): boolean {
  for (const k of keepOuts) {
    const r = k.radius + margin;
    if ((x - k.x) ** 2 + (z - k.z) ** 2 < r * r) return true;
  }
  return false;
}
