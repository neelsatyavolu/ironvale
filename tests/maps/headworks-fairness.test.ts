import { Box3, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { buildNavGrid, DIR_X, DIR_Z, type NavGrid } from '../../src/ai/navgrid';
import { registerColliders } from '../../src/maps/headworks/colliders';
import { BOUNDS, DECK_HEIGHT, ENEMY_SPAWNS, PLAYER_SPAWNS, TERRACE, type Spot } from '../../src/maps/headworks/plan';
import { CollisionWorld } from '../../src/world/collision';

/**
 * Duel fairness measured on the bots' own navigation grid: walking distance
 * from each duel spawn to the middle of every lane and to both terraces, and
 * what can be seen of each duel spawn. Set HEADWORKS_REPORT=1 to print the table.
 */
const EYE = 1.6;
const TOLERANCE = 0.05;
const node = (globalThis as { process?: { env: Record<string, string | undefined>; stdout: { write(text: string): void } } }).process;

const world = new CollisionWorld();
registerColliders(world);
world.build();

const spawnAt = (s: Spot): Vector3 => new Vector3(s.x, 0.05, s.z);
const bounds = new Box3(new Vector3(...BOUNDS.min), new Vector3(...BOUNDS.max));

function navGrid(): NavGrid {
  const builder = buildNavGrid(world, bounds, [...PLAYER_SPAWNS, ...ENEMY_SPAWNS].map(spawnAt));
  let step = builder.next();
  while (!step.done) step = builder.next();
  return step.value;
}

const grid = navGrid();

/** Walking distance from one node to every other (Dijkstra over the grid's links). */
function distancesFrom(start: number): Float64Array {
  const dist = new Float64Array(grid.nodeCount).fill(Infinity);
  dist[start] = 0;
  // A binary heap of [distance, node] pairs kept in two parallel arrays.
  const heapNode: number[] = [start];
  const heapDist: number[] = [0];
  const swap = (a: number, b: number): void => {
    [heapNode[a], heapNode[b]] = [heapNode[b] as number, heapNode[a] as number];
    [heapDist[a], heapDist[b]] = [heapDist[b] as number, heapDist[a] as number];
  };
  while (heapNode.length > 0) {
    const current = heapNode[0] as number;
    const d = heapDist[0] as number;
    const lastNode = heapNode.pop() as number;
    const lastDist = heapDist.pop() as number;
    if (heapNode.length > 0) {
      heapNode[0] = lastNode;
      heapDist[0] = lastDist;
      for (let i = 0; ; ) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapDist.length && (heapDist[l] as number) < (heapDist[m] as number)) m = l;
        if (r < heapDist.length && (heapDist[r] as number) < (heapDist[m] as number)) m = r;
        if (m === i) break;
        swap(i, m);
        i = m;
      }
    }
    if (d > (dist[current] as number)) continue;
    for (let dir = 0; dir < 8; dir++) {
      const next = grid.neighbor(current, dir);
      if (next < 0) continue;
      const rise = (grid.nodeY[next] as number) - (grid.nodeY[current] as number);
      const run = Math.hypot(DIR_X[dir] as number, DIR_Z[dir] as number) * grid.cell;
      const total = d + Math.hypot(run, rise);
      if (total >= (dist[next] as number)) continue;
      dist[next] = total;
      heapNode.push(next);
      heapDist.push(total);
      for (let i = heapNode.length - 1; i > 0; ) {
        const parent = (i - 1) >> 1;
        if ((heapDist[parent] as number) <= (heapDist[i] as number)) break;
        swap(i, parent);
        i = parent;
      }
    }
  }
  return dist;
}

const WEST = PLAYER_SPAWNS[0] as Spot;
const EAST = ENEMY_SPAWNS[0] as Spot;
const TERRACE_X = (TERRACE.x0 + TERRACE.x1) / 2;
const TERRACE_Z = (TERRACE.z0 + TERRACE.z1) / 2;

/** Places both duellists race to. Lane midpoints sit on the map's north-south centre line. */
const GOALS: readonly { readonly name: string; readonly at: Vector3 }[] = [
  { name: 'north lane middle', at: new Vector3(0, 0, -26) },
  { name: 'middle lane (slot)', at: new Vector3(0, 0, 0) },
  { name: 'south lane middle', at: new Vector3(0, 0, 26) },
  { name: 'west terrace', at: new Vector3(TERRACE_X, DECK_HEIGHT, TERRACE_Z) },
  { name: 'east terrace', at: new Vector3(-TERRACE_X, DECK_HEIGHT, -TERRACE_Z) },
];

const nodeNear = (p: Vector3): number => grid.nearestNode(p.x, p.y, p.z);
const fromWest = distancesFrom(nodeNear(spawnAt(WEST)));
const fromEast = distancesFrom(nodeNear(spawnAt(EAST)));
const route = (from: Float64Array, goal: Vector3): number => from[nodeNear(goal)] as number;
const turned = (p: Vector3): Vector3 => new Vector3(-p.x, p.y, -p.z);

describe('headworks duel fairness', () => {
  it('reaches every goal from both duel spawns', () => {
    const lines: string[] = [];
    for (const goal of GOALS) {
      const w = route(fromWest, goal.at);
      const e = route(fromEast, goal.at);
      lines.push(`${goal.name.padEnd(20)} west ${w.toFixed(1)} m   east ${e.toFixed(1)} m`);
      expect(Number.isFinite(w) && Number.isFinite(e), goal.name).toBe(true);
    }
    if (node?.env.HEADWORKS_REPORT) node.stdout.write(`${lines.join('\n')}\n`);
  });

  it('gives each side the same walk to the matching goal on its own side, within 5 percent', () => {
    for (const goal of GOALS) {
      const w = route(fromWest, goal.at);
      const e = route(fromEast, turned(goal.at));
      expect(Math.abs(w - e) / Math.max(w, e), `${goal.name}: west ${w.toFixed(1)} m, east ${e.toFixed(1)} m`).toBeLessThan(TOLERANCE);
    }
  });

  it('puts the slot between the clarifiers the same walk from both duel spawns', () => {
    const w = route(fromWest, new Vector3(0, 0, 0));
    const e = route(fromEast, new Vector3(0, 0, 0));
    expect(Math.abs(w - e) / Math.max(w, e), `west ${w.toFixed(1)} m, east ${e.toFixed(1)} m`).toBeLessThan(TOLERANCE);
  });

  it('hides each duel spawn from the other half of the map and from both terraces', () => {
    for (const [spot, sign] of [
      [WEST, 1],
      [EAST, -1],
    ] as const) {
      const head = new Vector3(spot.x, EYE, spot.z);
      const eye = new Vector3();
      let seenFrom = '';
      for (let n = 0; n < grid.nodeCount && !seenFrom; n++) {
        const x = grid.nodeX(n);
        const y = grid.nodeY[n] as number;
        const otherHalf = x * sign > 0;
        // Roofs keep a node but no links; only places a soldier can walk to count.
        if (!Number.isFinite(fromWest[n] as number) || (!otherHalf && y < 1)) continue;
        eye.set(x, y + EYE, grid.nodeZ(n));
        if (world.lineOfSight(eye, head)) seenFrom = `(${x.toFixed(1)}, ${y.toFixed(1)}, ${grid.nodeZ(n).toFixed(1)})`;
      }
      expect(seenFrom, `duel spawn (${spot.x}, ${spot.z}) is visible`).toBe('');
    }
  });
});
