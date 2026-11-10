import { Box3, BoxGeometry, Matrix4, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { findCover } from '../../src/ai/cover';
import { buildNavGrid, type NavGrid } from '../../src/ai/navgrid';
import { PathHandle, PathQueue } from '../../src/ai/pathfinder';
import { CollisionWorld } from '../../src/world/collision';

/**
 * A quay like Harbor's: dry ground for x < 0 and x > 6, a wadeable pool
 * between them (x 0 .. 6, z -10 .. 6) and a dry causeway round its south end
 * (z 6 .. 10). A crate stands in the pool so it has cover cells of its own.
 */
function buildQuay(): NavGrid {
  const world = new CollisionWorld();
  const slab = (x0: number, x1: number, z0: number, z1: number, surface: 'concrete' | 'water'): void => {
    world.addCollider(new BoxGeometry(x1 - x0, 1, z1 - z0), new Matrix4().makeTranslation((x0 + x1) / 2, -0.5, (z0 + z1) / 2), surface);
  };
  slab(-10, 0, -10, 10, 'concrete');
  slab(6, 16, -10, 10, 'concrete');
  slab(0, 6, 6, 10, 'concrete');
  slab(0, 6, -10, 6, 'water');
  world.addCollider(new BoxGeometry(1.2, 1.4, 1.2), new Matrix4().makeTranslation(3, 0.7, -4), 'wood');
  world.build();
  const builder = buildNavGrid(world, new Box3(new Vector3(-10, -1, -10), new Vector3(16, 4, 10)), [new Vector3(-5, 0, 0)]);
  let step = builder.next();
  while (!step.done) step = builder.next();
  return step.value;
}

let grid: NavGrid;

beforeAll(() => {
  grid = buildQuay();
});

function route(sx: number, sz: number, gx: number, gz: number): PathHandle {
  const queue = new PathQueue(grid);
  const handle = new PathHandle();
  queue.request(handle, sx, 0, sz, gx, 0, gz);
  for (let i = 0; i < 10000 && handle.status === 'queued'; i++) queue.update(1e9);
  return handle;
}

describe('water', () => {
  it('marks cells whose floor is water and leaves dry ground alone', () => {
    expect(grid.wet[grid.nearestNode(3, 0, 0)]).toBe(1);
    expect(grid.wet[grid.nearestNode(-5, 0, 0)]).toBe(0);
    expect(grid.wet[grid.nearestNode(3, 0, 8)]).toBe(0);
  });

  it('routes round the water when there is a dry way', () => {
    const handle = route(-3, -2, 9, -2);
    expect(handle.status).toBe('ready');
    expect(handle.partial).toBe(false);
    let px = -3;
    let pz = -2;
    for (let i = 0; i < handle.count; i++) {
      const x = handle.points[i * 3]!;
      const z = handle.points[i * 3 + 2]!;
      // No leg of the route may cross the pool.
      for (let t = 0; t <= 1; t += 0.05) {
        const node = grid.nearestNode(px + (x - px) * t, 0, pz + (z - pz) * t);
        expect(grid.wet[node]).toBe(0);
      }
      px = x;
      pz = z;
    }
  });

  it('still reaches a goal that is in the water', () => {
    const handle = route(-3, -2, 3, -1);
    expect(handle.status).toBe('ready');
    expect(handle.partial).toBe(false);
  });

  it('never offers a cell in the water as cover', () => {
    const node = findCover(grid, { x: 3, y: 0, z: -2, threatX: 3, threatZ: -9, radius: 4 });
    expect(node === -1 || grid.wet[node] === 0).toBe(true);
    // The crate does make cover cells; they are just not handed out.
    let wetCover = 0;
    for (let n = 0; n < grid.nodeCount; n++) if (grid.wet[n] && grid.coverLow[n] && grid.edges[n]) wetCover++;
    expect(wetCover).toBeGreaterThan(0);
  });
});
