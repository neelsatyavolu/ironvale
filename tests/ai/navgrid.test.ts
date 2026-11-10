import { Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildNavGrid, NAV, type NavGrid } from '../../src/ai/navgrid';
import type { CollisionWorld } from '../../src/world/collision';
import { buildTestGrid, buildTestWorld, TEST_BOUNDS } from './helpers';

let world: CollisionWorld;
let grid: NavGrid;

beforeAll(() => {
  world = buildTestWorld();
  grid = buildTestGrid(world);
});

describe('NavGrid building', () => {
  it('covers open floor with fully connected cells', () => {
    const node = grid.nodeAt(5, 0, 5);
    expect(node).toBeGreaterThanOrEqual(0);
    expect(grid.edges[node]).toBe(0xff);
    expect(grid.nodeY[node]).toBeCloseTo(0, 2);
    expect(Math.abs(grid.nodeX(node) - 5)).toBeLessThanOrEqual(NAV.cell / 2 + 1e-6);
    expect(Math.abs(grid.nodeZ(node) - 5)).toBeLessThanOrEqual(NAV.cell / 2 + 1e-6);
  });

  it('reports progress between 0 and 1 while building in slices', () => {
    const builder = buildNavGrid(world, TEST_BOUNDS, [new Vector3(0, 0, 5)]);
    let last = 0;
    let slices = 0;
    let step = builder.next();
    while (!step.done) {
      expect(step.value).toBeGreaterThanOrEqual(last);
      expect(step.value).toBeLessThanOrEqual(1);
      last = step.value;
      slices++;
      step = builder.next();
    }
    expect(slices).toBeGreaterThan(20);
  });

  it('leaves no walkable cell inside or hugging a wall', () => {
    expect(grid.nodeAt(0, 0, -5)).toBe(-1);
    expect(grid.nodeAt(3, 0, -5.2)).toBe(-1);
    // 0.34 m capsule: a cell centre must be at least that far from the wall face.
    for (let n = 0; n < grid.nodeCount; n++) {
      if (grid.edges[n] === 0) continue;
      const x = grid.nodeX(n);
      const z = grid.nodeZ(n);
      if (Math.abs(x) < 5 && grid.nodeY[n] < 1) expect(Math.abs(z + 5)).toBeGreaterThan(0.2 + 0.3);
    }
  });

  it('never links two cells through a wall', () => {
    const north = grid.nearestNode(0, 0, -6);
    const south = grid.nearestNode(0, 0, -4);
    expect(north).toBeGreaterThanOrEqual(0);
    expect(south).toBeGreaterThanOrEqual(0);
    expect(grid.walkLine(south, north)).toBe(false);
    expect(grid.walkLine(grid.nodeAt(-3, 0, 4), grid.nodeAt(4, 0, 2))).toBe(true);
  });

  it('only allows a diagonal move when both straight neighbours are open', () => {
    for (let n = 0; n < grid.nodeCount; n++) {
      for (let d = 1; d < 8; d += 2) {
        if (grid.neighbor(n, d) < 0) continue;
        expect(grid.neighbor(n, (d + 7) & 7)).toBeGreaterThanOrEqual(0);
        expect(grid.neighbor(n, (d + 1) & 7)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('keeps links symmetric', () => {
    for (let n = 0; n < grid.nodeCount; n++) {
      for (let d = 0; d < 8; d++) {
        const m = grid.neighbor(n, d);
        if (m >= 0) expect(grid.neighbor(m, (d + 4) & 7)).toBe(n);
      }
    }
  });

  it('builds two levels where a platform sits above the floor', () => {
    const below = grid.nodeAt(12, 0, 0);
    const above = grid.nodeAt(12, 3, 0);
    expect(below).toBeGreaterThanOrEqual(0);
    expect(above).toBeGreaterThanOrEqual(0);
    expect(below).not.toBe(above);
    expect(grid.nodeY[below]).toBeCloseTo(0, 2);
    expect(grid.nodeY[above]).toBeCloseTo(3, 2);
    // The two levels are not joined directly.
    for (let d = 0; d < 8; d++) {
      const m = grid.neighbor(above, d);
      if (m >= 0) expect(grid.nodeY[m]).toBeGreaterThan(2);
    }
  });

  it('walks up the ramp cell by cell', () => {
    const mid = grid.nodeAt(4.5, 1.5, 0);
    expect(mid).toBeGreaterThanOrEqual(0);
    expect(grid.nodeY[mid]).toBeGreaterThan(1);
    expect(grid.nodeY[mid]).toBeLessThan(2);
    const east = grid.neighbor(mid, 0);
    const west = grid.neighbor(mid, 4);
    expect(east).toBeGreaterThanOrEqual(0);
    expect(west).toBeGreaterThanOrEqual(0);
    expect(grid.nodeY[east]).toBeGreaterThan(grid.nodeY[mid]);
    expect(grid.nodeY[west]).toBeLessThan(grid.nodeY[mid]);
  });

  it('blocks floor under the low end of the ramp, where there is no headroom', () => {
    expect(grid.nodeAt(2, 0, 0) < 0 || grid.nodeY[grid.nodeAt(2, 0, 0)] > 0.3).toBe(true);
  });

  it('does not step onto a 0.5 m crate but does walk over a 0.15 m slab', () => {
    const crate = grid.nodeAt(-12, 0.5, 0);
    expect(crate < 0 || grid.nodeY[crate] < 0.1).toBe(true);
    const slab = grid.nodeAt(-12, 0.15, 8);
    expect(slab).toBeGreaterThanOrEqual(0);
    expect(grid.nodeY[slab]).toBeCloseTo(0.15, 2);
    expect(grid.edges[slab]).not.toBe(0);
  });

  it('drops cells that cannot be reached from the seed points', () => {
    for (let n = 0; n < grid.nodeCount; n++) {
      const onCrate = Math.abs(grid.nodeX(n) + 12) < 1.2 && Math.abs(grid.nodeZ(n)) < 1.2 && grid.nodeY[n]! > 0.4;
      const onWallTop = Math.abs(grid.nodeZ(n) + 5) < 0.3 && Math.abs(grid.nodeX(n)) < 5 && grid.nodeY[n]! > 2.4;
      if (onCrate || onWallTop) expect(grid.edges[n]).toBe(0);
    }
  });

  it('finds the nearest walkable cell for a point inside an obstacle', () => {
    const node = grid.nearestNode(0, 0, -5);
    expect(node).toBeGreaterThanOrEqual(0);
    expect(Math.hypot(grid.nodeX(node), grid.nodeZ(node) + 5)).toBeLessThan(1.5);
    expect(grid.nearestNode(500, 0, 500)).toBe(-1);
  });

  it('stays compact', () => {
    const bytes =
      grid.nodeY.byteLength +
      grid.nodeCol.byteLength +
      grid.edges.byteLength +
      grid.edgeLayers.byteLength +
      grid.coverLow.byteLength +
      grid.coverHigh.byteLength;
    expect(bytes / grid.nodeCount).toBeLessThanOrEqual(16);
  });
});
