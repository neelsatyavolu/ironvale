import { beforeAll, describe, expect, it } from 'vitest';
import type { NavGrid } from '../../src/ai/navgrid';
import { PATH_MAX_POINTS, PathHandle, PathQueue } from '../../src/ai/pathfinder';
import { buildTestGrid, buildTestWorld } from './helpers';

let grid: NavGrid;

beforeAll(() => {
  grid = buildTestGrid(buildTestWorld());
});

function solve(handle: PathHandle, queue: PathQueue, budget = 1e9): void {
  for (let i = 0; i < 10000 && handle.status === 'queued'; i++) queue.update(budget);
}

function route(sx: number, sy: number, sz: number, gx: number, gy: number, gz: number): PathHandle {
  const queue = new PathQueue(grid);
  const handle = new PathHandle();
  queue.request(handle, sx, sy, sz, gx, gy, gz);
  solve(handle, queue);
  return handle;
}

function length(handle: PathHandle, sx: number, sz: number): number {
  let total = 0;
  let px = sx;
  let pz = sz;
  for (let i = 0; i < handle.count; i++) {
    const x = handle.points[i * 3]!;
    const z = handle.points[i * 3 + 2]!;
    total += Math.hypot(x - px, z - pz);
    px = x;
    pz = z;
  }
  return total;
}

/** true when the segment (ax, az) - (bx, bz) crosses the tall wall at z = -5, x -5 .. 5. */
function crossesWall(ax: number, az: number, bx: number, bz: number): boolean {
  if ((az + 5) * (bz + 5) > 0) return false;
  const t = (-5 - az) / (bz - az);
  return Math.abs(ax + (bx - ax) * t) < 5;
}

describe('Pathfinder', () => {
  it('smooths a path across open floor to a single straight leg', () => {
    const handle = route(-8, 0, 6, 8, 0, 3);
    expect(handle.status).toBe('ready');
    expect(handle.partial).toBe(false);
    expect(handle.count).toBe(1);
    expect(handle.points[0]).toBeCloseTo(8, 5);
    expect(handle.points[2]).toBeCloseTo(3, 5);
  });

  it('goes round a wall instead of through it', () => {
    const handle = route(0, 0, -3, 0, 0, -8);
    expect(handle.status).toBe('ready');
    expect(handle.count).toBeGreaterThanOrEqual(2);
    let px = 0;
    let pz = -3;
    for (let i = 0; i < handle.count; i++) {
      const x = handle.points[i * 3]!;
      const z = handle.points[i * 3 + 2]!;
      expect(crossesWall(px, pz, x, z)).toBe(false);
      px = x;
      pz = z;
    }
    // Shortest way round a 10 m wall from 2 m in front to 3 m behind is about 12.3 m.
    const walked = length(handle, 0, -3);
    expect(walked).toBeGreaterThan(11.5);
    expect(walked).toBeLessThan(14.5);
  });

  it('climbs the ramp to reach the platform above the start', () => {
    const handle = route(12, 0, 0, 12, 3, 0);
    expect(handle.status).toBe('ready');
    expect(handle.partial).toBe(false);
    const last = (handle.count - 1) * 3;
    expect(handle.points[last + 1]).toBeCloseTo(3, 1);
    let usedRamp = false;
    for (let i = 0; i < handle.count; i++) {
      const x = handle.points[i * 3]!;
      const y = handle.points[i * 3 + 1]!;
      if (x < 9.5 && y > 0.2 && Math.abs(handle.points[i * 3 + 2]!) < 1.5) usedRamp = true;
    }
    expect(usedRamp).toBe(true);
  });

  it('returns an empty ready path when start and goal share a cell', () => {
    const handle = route(5, 0, 5, 5.1, 0, 5.1);
    expect(handle.status).toBe('ready');
    expect(handle.count).toBeLessThanOrEqual(1);
  });

  it('snaps a goal inside an obstacle to the nearest walkable cell', () => {
    const handle = route(0, 0, 0, 0, 0, -5);
    expect(handle.status).toBe('ready');
    const last = (handle.count - 1) * 3;
    expect(Math.hypot(handle.points[last]!, handle.points[last + 2]! + 5)).toBeLessThan(1.5);
  });

  it('fails cleanly when the start is off the grid', () => {
    const handle = route(400, 0, 400, 0, 0, 0);
    expect(handle.status).toBe('failed');
    expect(handle.count).toBe(0);
  });

  it('gives the same answer whether searched in one go or in small slices', () => {
    const whole = route(-15, 0, -15, 14, 3, 2);
    const queue = new PathQueue(grid);
    const sliced = new PathHandle();
    queue.request(sliced, -15, 0, -15, 14, 3, 2);
    let updates = 0;
    while (sliced.status === 'queued' && updates < 100000) {
      queue.update(25);
      updates++;
    }
    expect(updates).toBeGreaterThan(3);
    expect(sliced.status).toBe('ready');
    expect(sliced.count).toBe(whole.count);
    expect([...sliced.points.subarray(0, sliced.count * 3)]).toEqual([...whole.points.subarray(0, whole.count * 3)]);
  });

  it('swings wide of an avoided area', () => {
    const direct = route(-10, 0, 5, 10, 0, 5);
    const queue = new PathQueue(grid);
    const handle = new PathHandle();
    queue.request(handle, -10, 0, 5, 10, 0, 5, { x: 0, z: 5, radius: 4, cost: 6 });
    solve(handle, queue);
    expect(handle.status).toBe('ready');
    expect(length(handle, -10, 5)).toBeGreaterThan(length(direct, -10, 5) + 0.5);
    let nearest = Infinity;
    let px = -10;
    let pz = 5;
    for (let i = 0; i < handle.count; i++) {
      const x = handle.points[i * 3]!;
      const z = handle.points[i * 3 + 2]!;
      for (let t = 0; t <= 1; t += 0.05) nearest = Math.min(nearest, Math.hypot(px + (x - px) * t, pz + (z - pz) * t - 5));
      px = x;
      pz = z;
    }
    expect(nearest).toBeGreaterThan(2);
  });

  it('keeps every leg of a smoothed path walkable', () => {
    const handle = route(-15, 0, -15, 14, 3, 2);
    let from = grid.nearestNode(-15, 0, -15);
    for (let i = 0; i < handle.count; i++) {
      const to = grid.nearestNode(handle.points[i * 3]!, handle.points[i * 3 + 1]!, handle.points[i * 3 + 2]!);
      expect(grid.walkLine(from, to)).toBe(true);
      from = to;
    }
    expect(handle.count).toBeLessThanOrEqual(PATH_MAX_POINTS);
  });
});

describe('PathQueue', () => {
  it('spends no more than its budget per update and still finishes every request in order', () => {
    const queue = new PathQueue(grid);
    const handles = Array.from({ length: 12 }, () => new PathHandle());
    handles.forEach((handle, i) => queue.request(handle, -15 + i, 0, -15, 14 - i, 0, 15));
    expect(queue.pending).toBe(12);
    const finishedAt: number[] = [];
    for (let frame = 0; frame < 5000 && queue.pending > 0; frame++) {
      const used = queue.update(200);
      expect(used).toBeLessThanOrEqual(200);
      handles.forEach((handle, i) => {
        if (handle.status !== 'queued' && finishedAt[i] === undefined) finishedAt[i] = frame;
      });
    }
    expect(queue.pending).toBe(0);
    expect(handles.every((handle) => handle.status === 'ready')).toBe(true);
    for (let i = 1; i < 12; i++) expect(finishedAt[i]!).toBeGreaterThanOrEqual(finishedAt[i - 1]!);
    expect(finishedAt[11]!).toBeGreaterThan(2);
  });

  it('replaces a waiting request from the same handle instead of queueing it twice', () => {
    const queue = new PathQueue(grid);
    const handle = new PathHandle();
    queue.request(handle, -8, 0, 6, 8, 0, 3);
    queue.request(handle, -8, 0, 6, -8, 0, 12);
    expect(queue.pending).toBe(1);
    solve(handle, queue);
    expect(handle.points[2]).toBeCloseTo(12, 5);
  });

  it('drops a cancelled request', () => {
    const queue = new PathQueue(grid);
    const handle = new PathHandle();
    queue.request(handle, -8, 0, 6, 8, 0, 3);
    queue.cancel(handle);
    expect(queue.pending).toBe(0);
    expect(handle.status).toBe('idle');
  });
});
