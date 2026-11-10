import { Vector3, type Box3 } from 'three/webgpu';
import type { World } from '../world/types';

/** The parts of the collision world the navigation builder samples. */
export type NavWorld = Pick<World, 'raycast' | 'groundHeight' | 'moveCapsule'>;

/** Agent dimensions match the player's capsule so bots fit wherever the player does. */
export const NAV = {
  cell: 0.6,
  radius: 0.34,
  height: 1.8,
  /** Tallest ledge walked up without jumping. */
  step: 0.18,
  /** Surfaces with a flatter normal than this are not floor. */
  minNormalY: 0.6,
  /** Floors stacked in one column (ground, mezzanine, roof walk, ...). */
  maxLayers: 4,
  /** Obstacles this tall hide a crouching soldier. */
  coverLowHeight: 1.15,
  /** Obstacles this tall hide a standing soldier. */
  coverHighHeight: 1.65,
} as const;

/** Eight neighbours, clockwise from +X when seen from above with +Z down: E, SE, S, SW, W, NW, N, NE. */
export const DIR_X: readonly number[] = [1, 1, 0, -1, -1, -1, 0, 1];
export const DIR_Z: readonly number[] = [0, 1, 1, 1, 0, -1, -1, -1];
/** Direction index for a (dx, dz) step of -1, 0 or 1, at `(dz + 1) * 3 + dx + 1`. */
const STEP_TO_DIR: readonly number[] = [5, 6, 7, 4, -1, 0, 3, 2, 1];

const MAX_HITS_PER_COLUMN = 8;
/** The clearance probe floats this far above the floor so stair risers ahead do not count as walls. */
const PROBE_LIFT = NAV.step + 0.02;
const PROBE_TOLERANCE = 0.03;
/** Largest height change between neighbouring cells that is still worth testing. */
const MAX_EDGE_RISE = NAV.cell * 1.4;
const FLAT_EPSILON = 0.03;
const EDGE_SAMPLES = 4;
const STEP_TOLERANCE = 0.025;
const COVER_REACH = 1.0;
const COVER_REACH_DIAGONAL = 1.35;
const YIELD_EVERY = 256;

/**
 * Walkable cells over a map, stored column by column. A column (ix, iz) owns
 * zero to four nodes, one per floor level, listed top down. Each node keeps an
 * 8-bit mask of walkable neighbours and, for each direction, which level of
 * the neighbouring column the link lands on.
 */
export class NavGrid {
  readonly cell = NAV.cell;
  readonly nodeCount: number;
  private readonly colOffset: readonly number[];

  constructor(
    readonly nx: number,
    readonly nz: number,
    readonly originX: number,
    readonly originZ: number,
    /** First node of each column; `colStart[cols]` is the node count. */
    readonly colStart: Int32Array,
    /** Floor height of each node. */
    readonly nodeY: Float32Array,
    readonly nodeCol: Int32Array,
    /** Bit d is set when the neighbour in direction d can be walked to. */
    readonly edges: Uint8Array,
    /** Two bits per direction: the level index inside the neighbouring column. */
    readonly edgeLayers: Uint16Array,
    /** Bit d is set when something at least crouch-cover high stands in direction d. */
    readonly coverLow: Uint8Array,
    /** Bit d is set when that obstacle also hides a standing soldier. */
    readonly coverHigh: Uint8Array,
    /** 1 where the floor is water (a wadeable basin). Routes avoid these cells and nobody is sent to one. */
    readonly wet: Uint8Array,
  ) {
    this.nodeCount = nodeY.length;
    this.colOffset = DIR_X.map((dx, d) => dx + (DIR_Z[d] ?? 0) * nx);
  }

  nodeX(node: number): number {
    return this.originX + (((this.nodeCol[node] ?? 0) % this.nx) + 0.5) * this.cell;
  }

  nodeZ(node: number): number {
    return this.originZ + ((((this.nodeCol[node] ?? 0) / this.nx) | 0) + 0.5) * this.cell;
  }

  /** Node reached by walking from `node` in direction `d`, or -1. */
  neighbor(node: number, d: number): number {
    if (((this.edges[node] ?? 0) & (1 << d)) === 0) return -1;
    const col = (this.nodeCol[node] ?? 0) + (this.colOffset[d] ?? 0);
    return (this.colStart[col] ?? 0) + (((this.edgeLayers[node] ?? 0) >> (d * 2)) & 3);
  }

  /** Column index for a world position, or -1 outside the grid. */
  columnAt(x: number, z: number): number {
    const ix = Math.floor((x - this.originX) / this.cell);
    const iz = Math.floor((z - this.originZ) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    return iz * this.nx + ix;
  }

  /** Walkable node in the column under (x, z) whose floor is closest to `y`, or -1. */
  nodeAt(x: number, y: number, z: number): number {
    const col = this.columnAt(x, z);
    return col < 0 ? -1 : this.nodeInColumn(col, y);
  }

  /** `nodeAt`, widening ring by ring when the column itself has no walkable node. */
  nearestNode(x: number, y: number, z: number, maxRing = 6): number {
    const cx = Math.floor((x - this.originX) / this.cell);
    const cz = Math.floor((z - this.originZ) / this.cell);
    for (let ring = 0; ring <= maxRing; ring++) {
      let best = -1;
      let bestScore = Infinity;
      for (let iz = cz - ring; iz <= cz + ring; iz++) {
        if (iz < 0 || iz >= this.nz) continue;
        const edgeRow = iz === cz - ring || iz === cz + ring;
        const stride = edgeRow || ring === 0 ? 1 : ring * 2;
        for (let ix = cx - ring; ix <= cx + ring; ix += stride) {
          if (ix < 0 || ix >= this.nx) continue;
          const node = this.nodeInColumn(iz * this.nx + ix, y);
          if (node < 0) continue;
          const dx = this.nodeX(node) - x;
          const dz = this.nodeZ(node) - z;
          const dy = ((this.nodeY[node] ?? 0) - y) * 2;
          const score = dx * dx + dz * dz + dy * dy;
          if (score < bestScore) {
            bestScore = score;
            best = node;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * Line-of-walk: true when a soldier can go straight from `a` to `b`. Follows
   * the grid line between the two cells and needs every step to be a link.
   * With `dryOnly` the line may not touch a water cell either.
   */
  walkLine(a: number, b: number, dryOnly = false): boolean {
    if (a < 0 || b < 0) return false;
    if (a === b) return true;
    const colA = this.nodeCol[a] ?? 0;
    const colB = this.nodeCol[b] ?? 0;
    let ix = colA % this.nx;
    let iz = (colA / this.nx) | 0;
    const tx = colB % this.nx;
    const tz = (colB / this.nx) | 0;
    const dx = Math.abs(tx - ix);
    const dz = Math.abs(tz - iz);
    const sx = tx > ix ? 1 : -1;
    const sz = tz > iz ? 1 : -1;
    let err = dx - dz;
    let node = a;
    while (ix !== tx || iz !== tz) {
      const e2 = err * 2;
      let mx = 0;
      let mz = 0;
      if (e2 > -dz) {
        err -= dz;
        mx = sx;
      }
      if (e2 < dx) {
        err += dx;
        mz = sz;
      }
      node = this.neighbor(node, STEP_TO_DIR[(mz + 1) * 3 + mx + 1] ?? 0);
      if (node < 0 || (dryOnly && this.wet[node])) return false;
      ix += mx;
      iz += mz;
    }
    return node === b;
  }

  private nodeInColumn(col: number, y: number): number {
    let best = -1;
    let bestDy = Infinity;
    const end = this.colStart[col + 1] ?? 0;
    for (let n = this.colStart[col] ?? 0; n < end; n++) {
      if (this.edges[n] === 0) continue;
      const dy = Math.abs((this.nodeY[n] ?? 0) - y);
      if (dy < bestDy) {
        bestDy = dy;
        best = n;
      }
    }
    return best;
  }
}

const DOWN = new Vector3(0, -1, 0);
const ZERO = new Vector3();
const origin = new Vector3();
const direction = new Vector3();

/**
 * Samples the collision world into a `NavGrid`. A generator, so the caller can
 * spread the work over frames: each `next()` does a small slice and yields the
 * fraction done. `seeds` are points known to be reachable (spawns); cells that
 * cannot be walked to from any of them are dropped.
 */
export function* buildNavGrid(world: NavWorld, bounds: Box3, seeds: readonly Vector3[]): Generator<number, NavGrid, void> {
  const cell = NAV.cell;
  const nx = Math.max(1, Math.floor((bounds.max.x - bounds.min.x) / cell));
  const nz = Math.max(1, Math.floor((bounds.max.z - bounds.min.z) / cell));
  const cols = nx * nz;
  const originX = bounds.min.x;
  const originZ = bounds.min.z;
  const top = bounds.max.y + 0.5;
  const bottom = bounds.min.y - 0.5;

  // 1. Floors: cast down through each column and keep every surface a capsule can stand on.
  const colStart = new Int32Array(cols + 1);
  let capacity = cols + (cols >> 2) + 16;
  let heights = new Float32Array(capacity);
  let water = new Uint8Array(capacity);
  let count = 0;
  for (let iz = 0; iz < nz; iz++) {
    const z = originZ + (iz + 0.5) * cell;
    for (let ix = 0; ix < nx; ix++) {
      const x = originX + (ix + 0.5) * cell;
      colStart[iz * nx + ix] = count;
      let fromY = top;
      let ceiling = Infinity;
      let layers = 0;
      for (let i = 0; i < MAX_HITS_PER_COLUMN && layers < NAV.maxLayers && fromY > bottom; i++) {
        const hit = world.raycast(origin.set(x, fromY, z), DOWN, fromY - bottom);
        if (!hit) break;
        const y = hit.point.y;
        if (hit.normal.y >= NAV.minNormalY && ceiling - y >= NAV.height && capsuleFits(world, x, y, z)) {
          if (count === capacity) {
            capacity *= 2;
            const grown = new Float32Array(capacity);
            grown.set(heights);
            heights = grown;
            const grownWater = new Uint8Array(capacity);
            grownWater.set(water);
            water = grownWater;
          }
          water[count] = hit.surface === 'water' ? 1 : 0;
          heights[count++] = y;
          layers++;
        }
        ceiling = y;
        fromY = y - 0.05;
      }
    }
    yield (0.55 * (iz + 1)) / nz;
  }
  colStart[cols] = count;

  const nodeY = heights.slice(0, count);
  const wet = water.slice(0, count);
  const nodeCol = new Int32Array(count);
  for (let col = 0; col < cols; col++) {
    for (let n = colStart[col] ?? 0; n < (colStart[col + 1] ?? 0); n++) nodeCol[n] = col;
  }
  const edges = new Uint8Array(count);
  const edgeLayers = new Uint16Array(count);
  const coverLow = new Uint8Array(count);
  const coverHigh = new Uint8Array(count);
  const grid = new NavGrid(nx, nz, originX, originZ, colStart, nodeY, nodeCol, edges, edgeLayers, coverLow, coverHigh, wet);

  const link = (a: number, d: number, b: number): void => {
    const colA = nodeCol[a] ?? 0;
    const colB = nodeCol[b] ?? 0;
    edges[a] = (edges[a] ?? 0) | (1 << d);
    edgeLayers[a] = ((edgeLayers[a] ?? 0) & ~(3 << (d * 2))) | ((b - (colStart[colB] ?? 0)) << (d * 2));
    const back = (d + 4) & 7;
    edges[b] = (edges[b] ?? 0) | (1 << back);
    edgeLayers[b] = ((edgeLayers[b] ?? 0) & ~(3 << (back * 2))) | ((a - (colStart[colA] ?? 0)) << (back * 2));
  };

  // 2. Straight links (east and south; `link` adds the way back).
  for (let n = 0; n < count; n++) {
    const col = nodeCol[n] ?? 0;
    const ix = col % nx;
    const iz = (col / nx) | 0;
    const y = nodeY[n] ?? 0;
    for (let d = 0; d <= 2; d += 2) {
      if (d === 0 ? ix + 1 >= nx : iz + 1 >= nz) continue;
      const other = col + (d === 0 ? 1 : nx);
      let best = -1;
      let bestDy = MAX_EDGE_RISE;
      for (let m = colStart[other] ?? 0; m < (colStart[other + 1] ?? 0); m++) {
        const dy = Math.abs((nodeY[m] ?? 0) - y);
        if (dy < bestDy) {
          bestDy = dy;
          best = m;
        }
      }
      if (best < 0) continue;
      if (bestDy > FLAT_EPSILON && !stepsWalkable(world, grid, n, best)) continue;
      link(n, d, best);
    }
    if (n % YIELD_EVERY === 0) yield 0.55 + (0.2 * n) / count;
  }

  // 3. Diagonal links, only where both ways round the corner exist and meet (no corner cutting).
  for (let n = 0; n < count; n++) {
    for (let d = 1; d <= 3; d += 2) {
      const side = d === 1 ? 0 : 4;
      const viaSide = grid.neighbor(n, side);
      const viaSouth = grid.neighbor(n, 2);
      if (viaSide < 0 || viaSouth < 0) continue;
      const corner = grid.neighbor(viaSide, 2);
      if (corner < 0 || corner !== grid.neighbor(viaSouth, side)) continue;
      link(n, d, corner);
    }
  }
  yield 0.8;

  // 4. Keep what can be reached from the seeds.
  if (seeds.length > 0) {
    const reached = new Uint8Array(count);
    const stack = new Int32Array(count);
    let size = 0;
    for (const seed of seeds) {
      const start = grid.nearestNode(seed.x, seed.y, seed.z);
      if (start < 0 || reached[start]) continue;
      reached[start] = 1;
      stack[size++] = start;
    }
    while (size > 0) {
      const n = stack[--size] ?? 0;
      for (let d = 0; d < 8; d++) {
        const m = grid.neighbor(n, d);
        if (m < 0 || reached[m]) continue;
        reached[m] = 1;
        stack[size++] = m;
      }
    }
    for (let n = 0; n < count; n++) if (!reached[n]) edges[n] = 0;
  }
  yield 0.85;

  // 5. Cover: which directions have something solid at crouch and standing height.
  for (let n = 0; n < count; n++) {
    const mask = edges[n] ?? 0;
    if (mask === 0 || mask === 0xff) continue;
    const x = grid.nodeX(n);
    const z = grid.nodeZ(n);
    const y = nodeY[n] ?? 0;
    for (let d = 0; d < 8; d++) {
      const diagonal = (d & 1) === 1;
      const reach = diagonal ? COVER_REACH_DIAGONAL : COVER_REACH;
      direction.set(DIR_X[d] ?? 0, 0, DIR_Z[d] ?? 0).normalize();
      if (!world.raycast(origin.set(x, y + NAV.coverLowHeight, z), direction, reach)) continue;
      coverLow[n] = (coverLow[n] ?? 0) | (1 << d);
      if (world.raycast(origin.set(x, y + NAV.coverHighHeight, z), direction, reach)) {
        coverHigh[n] = (coverHigh[n] ?? 0) | (1 << d);
      }
    }
    if (n % YIELD_EVERY === 0) yield 0.85 + (0.15 * n) / count;
  }
  return grid;
}

/** true when the capsule stands at (x, y, z) without touching anything but the floor. */
function capsuleFits(world: NavWorld, x: number, y: number, z: number): boolean {
  origin.set(x, y + PROBE_LIFT, z);
  const moved = world.moveCapsule(origin, ZERO, 0, NAV.radius, NAV.height - PROBE_LIFT).position;
  return moved.distanceToSquared(origin) < PROBE_TOLERANCE * PROBE_TOLERANCE;
}

/** Samples the floor between two neighbouring cells; no single rise or drop may exceed a step. */
function stepsWalkable(world: NavWorld, grid: NavGrid, a: number, b: number): boolean {
  const ax = grid.nodeX(a);
  const az = grid.nodeZ(a);
  const bx = grid.nodeX(b);
  const bz = grid.nodeZ(b);
  let previous = grid.nodeY[a] ?? 0;
  for (let i = 1; i <= EDGE_SAMPLES; i++) {
    const t = i / EDGE_SAMPLES;
    const height =
      i === EDGE_SAMPLES
        ? (grid.nodeY[b] ?? 0)
        : world.groundHeight(ax + (bx - ax) * t, az + (bz - az) * t, previous + 0.9, 2);
    if (height === null || Math.abs(height - previous) > NAV.step + STEP_TOLERANCE) return false;
    previous = height;
  }
  return true;
}
