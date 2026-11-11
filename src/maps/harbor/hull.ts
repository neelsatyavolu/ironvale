import * as THREE from 'three/webgpu';
import { PART, painted, sweep, type Point } from './boat-parts';
import { hullPoint, section, stationX, type HullForm } from './hull-shape';

export interface HullPaint {
  readonly hull: number;
  /** Sheer strake, gunwale and posts. */
  readonly stripe: number;
}

const STATIONS = 26;
const STRAKES = 7;
/** How far each plank stands proud of the one below where they overlap. */
const LAP = 0.016;
const WOOD = 0x8a6f4d;

const stationT = (i: number): number => i / STATIONS;

/** One strip of planking between two girth lines, on one side, lofted through every station. */
function strake(form: HullForm, s0: number, s1: number, side: 1 | -1, lapLow: number, lapHigh: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= STATIONS; i++) {
    const t = stationT(i);
    // The laps close up at the ends, where the planks land flush on the posts.
    const fade = Math.min(1, Math.min(t, 1 - t) * 9);
    const low = hullPoint(t, s0, form);
    const high = hullPoint(t, s1, form);
    positions.push(low[0], low[1] - lapLow * 0.2 * fade, side * (low[2] + lapLow * fade));
    positions.push(high[0], high[1], side * (high[2] + lapHigh * fade));
  }
  for (let i = 0; i < STATIONS; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  // Smooth along the plank, flat across it: each strake keeps its own edge.
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Planked hull, both sides: clinker strakes that overlap like weatherboards,
 * or carvel planks laid flush. A transom closes a square stern.
 */
export function hullShell(form: HullForm, paint: HullPaint, clinker: boolean): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const rows = clinker ? STRAKES : STRAKES * 2;
  for (const side of [1, -1] as const) {
    for (let k = 0; k < rows; k++) {
      const s0 = k / rows;
      const s1 = (k + 1) / rows;
      const top = k >= rows - (clinker ? 1 : 2);
      const lap = clinker && k > 0 ? LAP : 0;
      parts.push(painted(strake(form, s0, s1, side, lap, 0), top ? paint.stripe : paint.hull, PART.hull));
      // Underside of the lap: the shadow line that makes clinker read.
      if (lap > 0) parts.push(painted(strake(form, s0, s0, side, 0, lap), paint.hull, PART.hull));
    }
  }
  if (form.stern === 'transom') parts.push(painted(transom(form), paint.hull, PART.hull));
  return parts;
}

/** Flat board across a square stern, following the section at the aftmost station. */
function transom(form: HullForm): THREE.BufferGeometry {
  const steps = 10;
  const positions: number[] = [];
  for (let j = 0; j < steps; j++) {
    for (const side of [1, -1]) {
      const a = hullPoint(0, j / steps, form);
      const b = hullPoint(0, (j + 1) / steps, form);
      positions.push(a[0], a[1], side * a[2], b[0], b[1], side * b[2], b[0], b[1], 0);
      positions.push(a[0], a[1], side * a[2], b[0], b[1], 0, a[0], a[1], 0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Line along the hull at girth `s`, set `inset` metres toward the centreline. */
function girthLine(form: HullForm, s: number, side: 1 | -1, inset: number, lift: number, t0 = 0, t1 = 1): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= STATIONS; i++) {
    const t = t0 + (t1 - t0) * stationT(i);
    const p = hullPoint(t, s, form);
    points.push([p[0], p[1] + lift, side * Math.max(0.012, p[2] - inset)]);
  }
  return points;
}

/** Everything timber that is built onto the planking: gunwales, rub rails, keel, posts, ribs. */
export function hullTimbers(form: HullForm, paint: HullPaint): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [1, -1] as const) {
    // Gunwale cap and the inwale under it.
    parts.push(sweep(girthLine(form, 1, side, 0.025, 0.02), 0.11, 0.045, paint.stripe));
    parts.push(sweep(girthLine(form, 0.93, side, 0.045, 0), 0.035, 0.07, WOOD));
    // Rub rail just under the sheer, standing proud of the planking.
    parts.push(sweep(girthLine(form, 0.86, side, -0.028, 0), 0.035, 0.05, 0x3a3128));
  }

  // Keel, then the stem (and stern post) carried up past the sheer in the old way.
  const keel: Point[] = [];
  for (let i = 1; i < STATIONS; i++) {
    const t = stationT(i);
    keel.push([stationX(t, 0, form), section(t, form).keel - 0.035, 0]);
  }
  parts.push(sweep(keel, 0.07, 0.09, 0x4a2a22, PART.hull));
  const post = (t: number, head: number): THREE.BufferGeometry => {
    const points: Point[] = [];
    for (let j = 0; j <= 8; j++) {
      const s = j / 8;
      const p = hullPoint(t, s, form);
      points.push([p[0] + (t > 0.5 ? 0.03 : -0.03), p[1], 0]);
    }
    const tip = points[points.length - 1]!;
    points.push([tip[0] + (t > 0.5 ? 0.02 : -0.02), tip[1] + head, 0]);
    return sweep(points, 0.085, 0.11, paint.stripe);
  };
  parts.push(post(1, 0.3));
  if (form.stern === 'pointed') parts.push(post(0, 0.16));

  // Ribs: steamed frames inside the planking, every other station.
  for (let i = 3; i < STATIONS - 2; i += 2) {
    const t = stationT(i);
    for (const side of [1, -1] as const) {
      const points: Point[] = [];
      for (let j = 2; j <= 9; j++) {
        const p = hullPoint(t, j / 10 + 0.02, form);
        points.push([p[0], p[1] + 0.012, side * Math.max(0.02, p[2] - 0.022)]);
      }
      parts.push(sweep(points, 0.04, 0.028, WOOD));
    }
  }
  return parts;
}

/**
 * Patch that lies on the hull between two stations and two girth lines, for
 * lettering. `cell` is its rectangle in the lettering atlas: [u0, v0, u1, v1].
 */
export function hullDecal(form: HullForm, side: 1 | -1, t0: number, t1: number, s0: number, s1: number, cell: readonly [number, number, number, number], hex: number): THREE.BufferGeometry {
  const columns = 6;
  const positions: number[] = [];
  const duv: number[] = [];
  const at = (i: number, j: number): { p: Point; uv: [number, number] } => {
    const u = i / columns;
    const p = hullPoint(t0 + (t1 - t0) * u, j === 0 ? s0 : s1, form);
    // Reads left to right from outside: toward the bow on the +Z side, toward the stern on the other.
    const across = side > 0 ? u : 1 - u;
    return { p: [p[0], p[1], side * (p[2] + LAP + 0.012)], uv: [cell[0] + (cell[2] - cell[0]) * across, cell[1] + (cell[3] - cell[1]) * j] };
  };
  for (let i = 0; i < columns; i++) {
    const quad = [at(i, 0), at(i + 1, 0), at(i + 1, 1), at(i, 1)];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      positions.push(...quad[k]!.p);
      duv.push(...quad[k]!.uv);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return painted(geometry, hex, PART.decal, new Float32Array(duv));
}
