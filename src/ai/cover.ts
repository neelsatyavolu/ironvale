import type { NavGrid } from './navgrid';

/** 0: exposed, 1: hides a crouching soldier, 2: hides a standing one. */
export type CoverKind = 0 | 1 | 2;

/** Which of the grid's eight directions a bearing falls in. */
export function directionToward(dx: number, dz: number): number {
  return Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) & 7;
}

/** How well the cell at `node` is protected from a threat at (threatX, threatZ). */
export function coverAgainst(grid: NavGrid, node: number, threatX: number, threatZ: number): CoverKind {
  const d = directionToward(threatX - grid.nodeX(node), threatZ - grid.nodeZ(node));
  const left = 1 << ((d + 7) & 7);
  const right = 1 << ((d + 1) & 7);
  const bit = 1 << d;
  const low = grid.coverLow[node] ?? 0;
  if ((low & bit) === 0 && (low & left) * (low & right) === 0) return 0;
  const high = grid.coverHigh[node] ?? 0;
  return (high & bit) !== 0 || (high & left) * (high & right) !== 0 ? 2 : 1;
}

export interface CoverQuery {
  /** Where the soldier is. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly threatX: number;
  readonly threatZ: number;
  /** How far the soldier is willing to go. */
  readonly radius: number;
  /** Spots nearer the threat than this are rejected. */
  readonly minThreatDistance?: number;
  /** When set, spots are also scored by how close they sit to this range from the threat. */
  readonly idealThreatDistance?: number;
  /** Cells other soldiers already hold. */
  readonly taken?: readonly number[];
  /** A cell to skip, such as the one being left. */
  readonly exclude?: number;
  /** More cells to skip (already tried and rejected). */
  readonly skip?: readonly number[];
}

const SAME_FLOOR = 2.5;
const RANGE_WEIGHT = 0.6;
const STANDING_COVER_BONUS = 0.5;
/** Soldiers keep at least this far apart in cover. */
const SPACING = 1.5;

/**
 * Best cover cell near the soldier against the threat: close to reach, the
 * right distance from the threat and not already held. Returns -1 when
 * nothing nearby protects. Reads only precomputed masks: no raycasts.
 */
export function findCover(grid: NavGrid, query: CoverQuery): number {
  const cell = grid.cell;
  const reach = Math.ceil(query.radius / cell);
  const cx = Math.floor((query.x - grid.originX) / cell);
  const cz = Math.floor((query.z - grid.originZ) / cell);
  const minThreat = query.minThreatDistance ?? 0;
  const taken = query.taken;
  let best = -1;
  let bestScore = Infinity;
  for (let iz = Math.max(0, cz - reach); iz <= Math.min(grid.nz - 1, cz + reach); iz++) {
    for (let ix = Math.max(0, cx - reach); ix <= Math.min(grid.nx - 1, cx + reach); ix++) {
      const col = iz * grid.nx + ix;
      const end = grid.colStart[col + 1] ?? 0;
      for (let node = grid.colStart[col] ?? 0; node < end; node++) {
        if (grid.coverLow[node] === 0 || grid.edges[node] === 0 || grid.wet[node] || node === query.exclude) continue;
        if (Math.abs((grid.nodeY[node] ?? 0) - query.y) > SAME_FLOOR) continue;
        const x = grid.nodeX(node);
        const z = grid.nodeZ(node);
        const travel = Math.hypot(x - query.x, z - query.z);
        if (travel > query.radius) continue;
        const threatDistance = Math.hypot(x - query.threatX, z - query.threatZ);
        if (threatDistance < minThreat) continue;
        const kind = coverAgainst(grid, node, query.threatX, query.threatZ);
        if (kind === 0) continue;
        let score = travel - (kind === 2 ? STANDING_COVER_BONUS : 0);
        if (query.idealThreatDistance !== undefined) {
          score += Math.abs(threatDistance - query.idealThreatDistance) * RANGE_WEIGHT;
        }
        if (score >= bestScore) continue;
        if (query.skip && query.skip.includes(node)) continue;
        if (taken && isCrowded(grid, x, z, taken)) continue;
        bestScore = score;
        best = node;
      }
    }
  }
  return best;
}

function isCrowded(grid: NavGrid, x: number, z: number, taken: readonly number[]): boolean {
  for (const other of taken) {
    if (other < 0) continue;
    if (Math.hypot(grid.nodeX(other) - x, grid.nodeZ(other) - z) < SPACING) return true;
  }
  return false;
}
