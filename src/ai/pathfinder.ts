import type { NavGrid } from './navgrid';

/** Most corner points a smoothed path keeps. Longer routes end early and are marked partial. */
export const PATH_MAX_POINTS = 48;
const MAX_RAW = 1024;
const MAX_EXPANSIONS = 40000;
/** How far ahead (in cells) smoothing tries to shortcut from each corner. */
const SMOOTH_LOOKAHEAD = 64;
/** Budget units charged for starting a search, so an update always makes progress. */
const START_COST = 8;
/** Smoothing keeps straight legs out of this share of an avoided radius. */
const AVOID_SMOOTH_FRACTION = 0.75;
const SQRT2 = Math.SQRT2;
/** Extra cost of stepping onto a water cell, in cells: wading is a last resort, taken only to reach someone in the water or to climb out. */
const WET_COST = 6;

export type PathStatus = 'idle' | 'queued' | 'ready' | 'failed';

/** Area a route should swing wide of (used for flanking). */
export interface PathAvoid {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  /** Extra cost per cell at the centre, fading to nothing at the edge. */
  readonly cost: number;
}

/**
 * A reusable path request and its result. Each soldier owns one, so asking
 * for a route never allocates. `points` holds x, y, z corner points from the
 * first turn to the goal; the start itself is left out.
 */
export class PathHandle {
  status: PathStatus = 'idle';
  readonly points = new Float32Array(PATH_MAX_POINTS * 3);
  count = 0;
  /** true when the route stops short of the goal (unreachable goal or a very long route). */
  partial = false;
  startX = 0;
  startY = 0;
  startZ = 0;
  goalX = 0;
  goalY = 0;
  goalZ = 0;
  avoidX = 0;
  avoidZ = 0;
  avoidRadius = 0;
  avoidCost = 0;
}

/** A* over a `NavGrid` that can stop and continue, so a long search is spread over frames. */
export class Pathfinder {
  state: 'idle' | 'running' | 'found' | 'failed' = 'idle';
  private readonly g: Float32Array;
  private readonly parent: Int32Array;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private heapNode = new Int32Array(1024);
  private heapF = new Float32Array(1024);
  private heapSize = 0;
  private searchId = 0;
  private start = -1;
  private goal = -1;
  private goalX = 0;
  private goalY = 0;
  private goalZ = 0;
  private best = -1;
  private bestH = Infinity;
  private expansions = 0;
  private avoidX = 0;
  private avoidZ = 0;
  private avoidRadius = 0;
  private avoidCost = 0;
  private readonly raw = new Int32Array(MAX_RAW);

  constructor(private readonly grid: NavGrid) {
    const n = grid.nodeCount;
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  begin(start: number, goal: number, handle: PathHandle): void {
    this.searchId++;
    this.start = start;
    this.goal = goal;
    this.goalX = this.grid.nodeX(goal);
    this.goalY = this.grid.nodeY[goal] ?? 0;
    this.goalZ = this.grid.nodeZ(goal);
    this.avoidX = handle.avoidX;
    this.avoidZ = handle.avoidZ;
    this.avoidRadius = handle.avoidRadius;
    this.avoidCost = handle.avoidCost;
    this.heapSize = 0;
    this.expansions = 0;
    this.best = start;
    this.bestH = this.heuristic(start);
    this.g[start] = 0;
    this.parent[start] = -1;
    this.seen[start] = this.searchId;
    this.push(start, this.bestH);
    this.state = 'running';
  }

  /** Expand up to `budget` nodes. Returns how many were expanded. */
  step(budget: number): number {
    const { grid, g, parent, seen, closed } = this;
    const id = this.searchId;
    const cell = grid.cell;
    let used = 0;
    while (this.state === 'running' && used < budget) {
      if (this.heapSize === 0 || this.expansions >= MAX_EXPANSIONS) {
        this.state = this.best === this.start ? 'failed' : 'found';
        break;
      }
      const node = this.pop();
      if (closed[node] === id) continue;
      closed[node] = id;
      used++;
      this.expansions++;
      if (node === this.goal) {
        this.best = node;
        this.state = 'found';
        break;
      }
      const h = this.heuristic(node);
      if (h < this.bestH) {
        this.bestH = h;
        this.best = node;
      }
      const base = g[node] ?? 0;
      const y = grid.nodeY[node] ?? 0;
      for (let d = 0; d < 8; d++) {
        const next = grid.neighbor(node, d);
        if (next < 0 || closed[next] === id) continue;
        let cost = ((d & 1) === 1 ? SQRT2 : 1) * cell + Math.abs((grid.nodeY[next] ?? 0) - y);
        if (grid.wet[next]) cost += WET_COST * cell;
        if (this.avoidRadius > 0) {
          const distance = Math.hypot(grid.nodeX(next) - this.avoidX, grid.nodeZ(next) - this.avoidZ);
          if (distance < this.avoidRadius) cost += this.avoidCost * cell * (1 - distance / this.avoidRadius);
        }
        const total = base + cost;
        if (seen[next] === id && total >= (g[next] ?? 0)) continue;
        seen[next] = id;
        g[next] = total;
        parent[next] = node;
        this.push(next, total + this.heuristic(next));
      }
    }
    return used;
  }

  /** Write the smoothed route into `handle`. Call once `state` is 'found'. */
  writePath(handle: PathHandle): void {
    const { grid, parent, raw } = this;
    const reachedGoal = this.best === this.goal;
    let length = 0;
    for (let n = this.best; n >= 0; n = parent[n] ?? -1) length++;
    // Keep the part nearest the start when the route is longer than the buffer.
    let skip = Math.max(0, length - MAX_RAW);
    const kept = length - skip;
    let end = this.best;
    for (; skip > 0; skip--) end = parent[end] ?? -1;
    let index = kept - 1;
    for (let n = end; n >= 0; n = parent[n] ?? -1) raw[index--] = n;

    handle.count = 0;
    handle.partial = !reachedGoal || kept < length;
    let anchor = 0;
    while (anchor < kept - 1) {
      // Try the longest shortcut first and halve until one is walkable: a handful of
      // line tests per corner, so smoothing a long route never costs a frame.
      let next = anchor + 1;
      for (let span = Math.min(kept - 1 - anchor, SMOOTH_LOOKAHEAD); span >= 2; span >>= 1) {
        const from = raw[anchor] ?? -1;
        const to = raw[anchor + span] ?? -1;
        // A shortcut between two dry corners may not cut across water the search went round.
        if (this.shortcutAllowed(from, to) && grid.walkLine(from, to, !grid.wet[from] && !grid.wet[to])) {
          next = anchor + span;
          break;
        }
      }
      if (handle.count === PATH_MAX_POINTS) {
        handle.partial = true;
        break;
      }
      const node = raw[next] ?? 0;
      const at = handle.count * 3;
      handle.points[at] = grid.nodeX(node);
      handle.points[at + 1] = grid.nodeY[node] ?? 0;
      handle.points[at + 2] = grid.nodeZ(node);
      handle.count++;
      anchor = next;
    }
    // Finish on the exact spot asked for when it lies inside the goal cell.
    if (!handle.partial && handle.count > 0) {
      const half = grid.cell / 2 + 1e-4;
      if (Math.abs(handle.goalX - this.goalX) <= half && Math.abs(handle.goalZ - this.goalZ) <= half) {
        const at = (handle.count - 1) * 3;
        handle.points[at] = handle.goalX;
        handle.points[at + 2] = handle.goalZ;
      }
    }
    this.state = 'idle';
  }

  abort(): void {
    this.state = 'idle';
  }

  /** A straight leg may not dip into the avoided area deeper than its own end points already are. */
  private shortcutAllowed(a: number, b: number): boolean {
    if (this.avoidRadius <= 0) return true;
    const ax = this.grid.nodeX(a) - this.avoidX;
    const az = this.grid.nodeZ(a) - this.avoidZ;
    const bx = this.grid.nodeX(b) - this.avoidX;
    const bz = this.grid.nodeZ(b) - this.avoidZ;
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 0 ? Math.min(1, Math.max(0, -(ax * dx + az * dz) / lengthSq)) : 0;
    const closest = Math.hypot(ax + dx * t, az + dz * t);
    const ends = Math.min(Math.hypot(ax, az), Math.hypot(bx, bz));
    return closest >= Math.min(this.avoidRadius * AVOID_SMOOTH_FRACTION, ends - 0.01);
  }

  /** Octile distance: exact on an open floor, never an overestimate. */
  private heuristic(node: number): number {
    const dx = Math.abs(this.grid.nodeX(node) - this.goalX);
    const dz = Math.abs(this.grid.nodeZ(node) - this.goalZ);
    const dy = Math.abs((this.grid.nodeY[node] ?? 0) - this.goalY);
    return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz) + dy;
  }

  private push(node: number, f: number): void {
    if (this.heapSize === this.heapNode.length) {
      const nodes = new Int32Array(this.heapSize * 2);
      const scores = new Float32Array(this.heapSize * 2);
      nodes.set(this.heapNode);
      scores.set(this.heapF);
      this.heapNode = nodes;
      this.heapF = scores;
    }
    const nodes = this.heapNode;
    const scores = this.heapF;
    let i = this.heapSize++;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if ((scores[up] ?? 0) <= f) break;
      nodes[i] = nodes[up] ?? 0;
      scores[i] = scores[up] ?? 0;
      i = up;
    }
    nodes[i] = node;
    scores[i] = f;
  }

  private pop(): number {
    const nodes = this.heapNode;
    const scores = this.heapF;
    const top = nodes[0] ?? 0;
    const size = --this.heapSize;
    if (size > 0) {
      const node = nodes[size] ?? 0;
      const f = scores[size] ?? 0;
      let i = 0;
      for (;;) {
        let child = i * 2 + 1;
        if (child >= size) break;
        if (child + 1 < size && (scores[child + 1] ?? 0) < (scores[child] ?? 0)) child++;
        if ((scores[child] ?? 0) >= f) break;
        nodes[i] = nodes[child] ?? 0;
        scores[i] = scores[child] ?? 0;
        i = child;
      }
      nodes[i] = node;
      scores[i] = f;
    }
    return top;
  }
}

/**
 * Serves path requests first come, first served, within a per-frame budget of
 * node expansions. Many soldiers can ask in the same frame; the work is spread
 * over the following frames instead of spiking one.
 */
export class PathQueue {
  private readonly finder: Pathfinder;
  private readonly waiting: PathHandle[] = [];
  private current: PathHandle | null = null;

  constructor(private readonly grid: NavGrid) {
    this.finder = new Pathfinder(grid);
  }

  /** Requests waiting or being searched. */
  get pending(): number {
    return this.waiting.length + (this.current ? 1 : 0);
  }

  request(
    handle: PathHandle,
    startX: number,
    startY: number,
    startZ: number,
    goalX: number,
    goalY: number,
    goalZ: number,
    avoid?: PathAvoid,
  ): void {
    handle.startX = startX;
    handle.startY = startY;
    handle.startZ = startZ;
    handle.goalX = goalX;
    handle.goalY = goalY;
    handle.goalZ = goalZ;
    handle.avoidX = avoid?.x ?? 0;
    handle.avoidZ = avoid?.z ?? 0;
    handle.avoidRadius = avoid?.radius ?? 0;
    handle.avoidCost = avoid?.cost ?? 0;
    handle.count = 0;
    handle.partial = false;
    if (this.current === handle) {
      this.finder.abort();
      this.current = null;
    }
    if (handle.status !== 'queued') this.waiting.push(handle);
    handle.status = 'queued';
  }

  cancel(handle: PathHandle): void {
    if (this.current === handle) {
      this.finder.abort();
      this.current = null;
    } else {
      const index = this.waiting.indexOf(handle);
      if (index >= 0) this.waiting.splice(index, 1);
    }
    handle.status = 'idle';
    handle.count = 0;
  }

  /** Work through the queue. Returns the budget spent. */
  update(budget: number): number {
    let used = 0;
    while (used < budget) {
      if (!this.current) {
        if (used + START_COST > budget && used > 0) break;
        const next = this.waiting.shift();
        if (!next) break;
        used += START_COST;
        const start = this.grid.nearestNode(next.startX, next.startY, next.startZ);
        const goal = this.grid.nearestNode(next.goalX, next.goalY, next.goalZ);
        if (start < 0 || goal < 0) {
          next.status = 'failed';
          continue;
        }
        this.current = next;
        this.finder.begin(start, goal, next);
      }
      used += this.finder.step(Math.max(0, budget - used));
      if (this.finder.state === 'running') break;
      if (this.finder.state === 'found') {
        this.finder.writePath(this.current);
        this.current.status = 'ready';
      } else {
        this.finder.abort();
        this.current.status = 'failed';
      }
      this.current = null;
    }
    return Math.min(used, budget);
  }

  clear(): void {
    for (const handle of this.waiting) handle.status = 'idle';
    this.waiting.length = 0;
    if (this.current) this.current.status = 'idle';
    this.current = null;
    this.finder.abort();
  }
}
