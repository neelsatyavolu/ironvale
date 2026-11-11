/**
 * The minimap's arithmetic, with no DOM: the overhead layout raster and the transform from the world to the map.
 */

export const MINIMAP = {
  /** Metres from the player to the edge of the map. */
  range: 45,
  /** An enemy this far above or below the player is on another floor. */
  floorGap: 2,
  /** How long a shot stays marked. */
  shotSeconds: 1,
} as const;

export const CELL_FLOOR = 0;
/** Blocked, and close enough to floor to be the face of a wall or a piece of cover. */
export const CELL_WALL = 1;
/** Blocked and deep inside something, or outside the level. */
export const CELL_SOLID = 2;

/** The parts of the bots' navigation grid the layout is read from (`NavGrid` in `src/ai/navgrid.ts`). */
export interface NavSource {
  readonly nx: number;
  readonly nz: number;
  readonly originX: number;
  readonly originZ: number;
  /** Metres per cell. */
  readonly cell: number;
  /** First node of each column; one entry more than there are columns. */
  readonly colStart: ArrayLike<number>;
  /** Per node: zero when nobody can walk there. */
  readonly edges: ArrayLike<number>;
}

/** The level from above, one byte per grid cell, row by row along +Z. */
export interface Layout {
  readonly nx: number;
  readonly nz: number;
  readonly originX: number;
  readonly originZ: number;
  readonly cell: number;
  readonly cells: Uint8Array;
}

/**
 * Classify every cell of the navigation grid. A cell is floor when any level of its column can be walked on. Blocked
 * cells within `rim` cells of floor are wall; the rest is solid.
 */
export function buildLayout(source: NavSource, rim = 2): Layout {
  const { nx, nz } = source;
  const far = rim + 1;
  // Distance to the nearest floor cell in cells (diagonals count one), capped just past the rim.
  const cells = new Uint8Array(nx * nz);
  for (let col = 0; col < cells.length; col++) {
    let walkable = false;
    const end = source.colStart[col + 1] ?? 0;
    for (let n = source.colStart[col] ?? 0; n < end && !walkable; n++) walkable = (source.edges[n] ?? 0) !== 0;
    cells[col] = walkable ? 0 : far;
  }
  const at = (ix: number, iz: number): number => (ix < 0 || iz < 0 || ix >= nx || iz >= nz ? far : (cells[iz * nx + ix] ?? far));
  // Two sweeps: down and right, then back.
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const near = Math.min(at(ix - 1, iz), at(ix - 1, iz - 1), at(ix, iz - 1), at(ix + 1, iz - 1)) + 1;
      if (near < (cells[iz * nx + ix] ?? 0)) cells[iz * nx + ix] = near;
    }
  }
  for (let iz = nz - 1; iz >= 0; iz--) {
    for (let ix = nx - 1; ix >= 0; ix--) {
      const near = Math.min(at(ix + 1, iz), at(ix + 1, iz + 1), at(ix, iz + 1), at(ix - 1, iz + 1)) + 1;
      if (near < (cells[iz * nx + ix] ?? 0)) cells[iz * nx + ix] = near;
    }
  }
  for (let i = 0; i < cells.length; i++) {
    const distance = cells[i] ?? far;
    cells[i] = distance === 0 ? CELL_FLOOR : distance <= rim ? CELL_WALL : CELL_SOLID;
  }
  return { nx, nz, originX: source.originX, originZ: source.originZ, cell: source.cell, cells };
}

/** A place on the map, in pixels from its centre (x right, y down). */
export interface MapPoint {
  x: number;
  y: number;
  /** true when the point lay past the limit and was pulled back to the edge. */
  outside: boolean;
}

/**
 * Where something `dx`, `dz` metres from the player lands on a map that turns with the player, so that the way the
 * player faces is up (yaw 0 looks down -Z). `scale` is pixels per metre and `limit` the map's radius in pixels.
 * Writes into `out`, which the caller reuses every frame.
 */
export function toMap(out: MapPoint, dx: number, dz: number, yaw: number, scale: number, limit: number): MapPoint {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const x = (dx * cos - dz * sin) * scale;
  const y = (dx * sin + dz * cos) * scale;
  const length = Math.hypot(x, y);
  const outside = length > limit + 1e-6;
  const shrink = outside ? limit / length : 1;
  out.x = x * shrink;
  out.y = y * shrink;
  out.outside = outside;
  return out;
}

/** Half the horizontal view angle in radians, from a camera's vertical field of view in degrees. */
export function horizontalHalfFov(verticalDegrees: number, aspect: number): number {
  return Math.atan(Math.tan((verticalDegrees * Math.PI) / 360) * aspect);
}

/** Seconds since a shot at `firedAt` on the match clock; Infinity when there is none or the clock has restarted. */
export function shotAge(firedAt: number | undefined, now: number): number {
  return firedAt === undefined || firedAt > now ? Infinity : now - firedAt;
}
