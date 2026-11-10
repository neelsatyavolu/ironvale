/** Height reported for a cell that has not been probed yet. High enough that rain stays hidden there. */
export const STALE_HEIGHT = 1e4;

/** Returns the height of the highest surface over a point (roof top, or the ground in the open). */
export type HeightProbe = (x: number, z: number) => number;

/**
 * A square grid of "highest surface" heights that follows the player. Rain,
 * splashes and dust motes are hidden below those heights so nothing falls
 * through a roof.
 *
 * Cells are stored at wrapped positions (`cell index mod size`), so the array
 * can be sampled on the GPU as a repeating texture with world coordinates, and
 * moving the centre only invalidates the rows and columns that scrolled in.
 */
export class RoofMask {
  /** Row-major heights, `size * size`, ready to upload as a texture. */
  readonly heights: Float32Array;
  /** Increases whenever `heights` changes. */
  version = 0;

  private readonly valid: Uint8Array;
  private readonly columnCell: Int32Array;
  private readonly rowCell: Int32Array;
  private staleCount: number;
  private cursor = 0;
  private centred = false;
  private minX = 0;
  private minZ = 0;

  constructor(
    readonly size: number,
    readonly cell: number,
  ) {
    if (!Number.isInteger(size) || size < 2 || size % 2 !== 0) throw new Error(`RoofMask size must be even, got ${size}`);
    if (!(cell > 0)) throw new Error(`RoofMask cell must be positive, got ${cell}`);
    this.heights = new Float32Array(size * size).fill(STALE_HEIGHT);
    this.valid = new Uint8Array(size * size);
    this.columnCell = new Int32Array(size);
    this.rowCell = new Int32Array(size);
    this.staleCount = size * size;
  }

  /** Cells still waiting to be probed. */
  get stale(): number {
    return this.staleCount;
  }

  /** Move the window so it is centred on a world position. */
  setCentre(x: number, z: number): void {
    const half = this.size / 2;
    const minX = Math.floor(x / this.cell) - half;
    const minZ = Math.floor(z / this.cell) - half;
    if (this.centred && minX === this.minX && minZ === this.minZ) return;
    for (let i = 0; i < this.size; i++) {
      const ix = minX + i;
      const column = this.wrap(ix);
      if (!this.centred || this.columnCell[column] !== ix) {
        this.columnCell[column] = ix;
        this.invalidate(column, this.size, this.size);
      }
      const iz = minZ + i;
      const row = this.wrap(iz);
      if (!this.centred || this.rowCell[row] !== iz) {
        this.rowCell[row] = iz;
        this.invalidate(row * this.size, 1, this.size);
      }
    }
    this.minX = minX;
    this.minZ = minZ;
    this.centred = true;
  }

  /** Probe up to `budget` stale cells. Returns how many were updated. */
  refresh(probe: HeightProbe, budget: number): number {
    if (!this.centred) return 0;
    const total = this.size * this.size;
    let done = 0;
    for (let scanned = 0; scanned < total && this.staleCount > 0 && done < budget; scanned++) {
      const index = this.cursor;
      this.cursor = (this.cursor + 1) % total;
      if (this.valid[index]) continue;
      const column = index % this.size;
      const row = (index - column) / this.size;
      const x = (this.columnCell[column]! + 0.5) * this.cell;
      const z = (this.rowCell[row]! + 0.5) * this.cell;
      this.heights[index] = probe(x, z);
      this.valid[index] = 1;
      this.staleCount--;
      done++;
    }
    if (done > 0) this.version++;
    return done;
  }

  /** Highest surface over a point, or `STALE_HEIGHT` outside the window or before the cell is probed. */
  heightAt(x: number, z: number): number {
    if (!this.centred) return STALE_HEIGHT;
    const ix = Math.floor(x / this.cell);
    const iz = Math.floor(z / this.cell);
    if (ix < this.minX || ix >= this.minX + this.size || iz < this.minZ || iz >= this.minZ + this.size) {
      return STALE_HEIGHT;
    }
    return this.heights[this.wrap(iz) * this.size + this.wrap(ix)]!;
  }

  /** true when a point is under cover (or below the ground). */
  isCovered(x: number, y: number, z: number): boolean {
    return y < this.heightAt(x, z);
  }

  private wrap(index: number): number {
    return ((index % this.size) + this.size) % this.size;
  }

  private invalidate(start: number, step: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const index = start + i * step;
      if (this.valid[index]) {
        this.valid[index] = 0;
        this.staleCount++;
      }
      this.heights[index] = STALE_HEIGHT;
    }
    this.version++;
  }
}
