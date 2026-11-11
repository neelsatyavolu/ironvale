// Loads the Headworks map in the running dev server and checks it against the real collision world:
//   - every spawn has ground just under it, has headroom and is not inside or touching a collider
//   - every enemy spawn can be reached on foot from every player spawn through gaps at least 0.9 m wide
//   - a capsule really walks from each player spawn to the middle of the map with moveCapsule
//   - all four terrace ramps can be walked up, and every pump house door lets the capsule through
//   - no lip on the ground is taller than a bot can step over
// Usage: node scripts/dev/map-headworks-check.mjs      (exit code 1 when anything fails)
import { chromium } from 'playwright';

const port = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '5311';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

/** Runs inside the page. Returns { failures: string[], notes: string[] }. */
function inspect() {
  const game = window.__ironvale.game;
  const { world, map } = game;
  const Vec3 = game.player.position.constructor;
  const RADIUS = 0.34;
  const HEIGHT = 1.8;
  const GRAVITY = 17.5;
  const WALK_SPEED = 4.5;
  const CELL = 0.4;
  const ROUTE_RADIUS = 0.45;
  const failures = [];
  const notes = [];
  const fixed = (n) => Number(n.toFixed(2));
  const label = (kind, i, s) => `${kind} spawn ${i} (${fixed(s.position.x)}, ${fixed(s.position.z)})`;

  /** true when an upright capsule with its feet at (x, y, z) overlaps nothing. */
  const fits = (x, y, z, radius = RADIUS) => {
    const start = new Vec3(x, y + 0.03, z);
    const moved = world.moveCapsule(start, new Vec3(0, 0, 0), 0, radius, HEIGHT).position;
    return Math.hypot(moved.x - start.x, moved.z - start.z) < 0.004 && Math.abs(moved.y - start.y) < 0.02;
  };

  // ---- the checker checks itself: a point in a container wall must not fit, open road must.
  if (fits(-33.9, 0, 0)) failures.push('self-test: a capsule in the face of the control building was reported as clear');
  if (!fits(-32, 0, -29)) failures.push('self-test: a capsule on the open road was reported as blocked');
  if (world.raycast(new Vec3(-40, 1, -29), new Vec3(1, 0, 0), 3)) failures.push('self-test: ray across open road hit something');
  if (!world.raycast(new Vec3(-22, 1, -5), new Vec3(1, 0, 0), 3)) failures.push('self-test: ray into the clarifier hit nothing');

  // ---- spawns
  const spawns = [
    ...map.playerSpawns.map((s, i) => ({ s, name: label('player', i, s) })),
    ...map.enemySpawns.map((s, i) => ({ s, name: label('enemy', i, s) })),
  ];
  for (const { s, name } of spawns) {
    const { x, y, z } = s.position;
    if (!map.bounds.containsPoint(s.position)) failures.push(`${name}: outside the map bounds`);
    const ground = world.groundHeight(x, z, y + 0.6, 3);
    if (ground === null) failures.push(`${name}: no ground under it`);
    else if (Math.abs(y - ground - 0.05) > 0.06) failures.push(`${name}: feet ${fixed(y - ground)} m above the ground, expected about 0.05`);
    if (!fits(x, ground ?? y, z)) failures.push(`${name}: capsule overlaps a collider`);
    // Under open sky nothing should be overhead at all (that would mean the spawn is inside a box); indoors only headroom matters.
    const indoors = map.interiors.some((zone) => zone.box.containsPoint(new Vec3(x, y + 1, z)));
    const clearance = indoors ? 1.9 : 6;
    if (world.raycast(new Vec3(x, y + 0.3, z), new Vec3(0, 1, 0), clearance)) failures.push(`${name}: something overhead within ${clearance} m`);
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      for (const h of [0.45, 1.0, 1.6]) {
        const hit = world.raycast(new Vec3(x, y + h, z), new Vec3(Math.cos(angle), 0, Math.sin(angle)), 0.7);
        if (hit) {
          failures.push(`${name}: ${hit.surface} ${fixed(hit.distance)} m away at height ${h}`);
          i = 99;
          break;
        }
      }
    }
  }

  // ---- walkable grid at yard level
  const min = map.bounds.min;
  const max = map.bounds.max;
  const columns = Math.floor((max.x - min.x) / CELL);
  const rows = Math.floor((max.z - min.z) / CELL);
  // Two grids: `free` for a body 0.9 m wide (the narrowest gap bots are promised on routes), and
  // `freeCapsule` for the 0.68 m capsule itself, which is what has to fit through a 0.95 m doorway.
  let free = new Uint8Array(columns * rows);
  const freeCapsule = new Uint8Array(columns * rows);
  // Anything standing proud of the slab by more than a finger would be a trip for the bots; the level has none.
  const lips = new Set();
  const RAMPS = [[-27.4, -19.8, 16.8, 20.2], [-8.2, -0.6, 20.4, 23.8]];
  const onRamp = (x, z) => RAMPS.some(([x0, x1, z0, z1]) => [1, -1].some((s) => s * x > x0 && s * x < x1 && s * z > z0 && s * z < z1));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const x = min.x + (c + 0.5) * CELL;
      const z = min.z + (r + 0.5) * CELL;
      const ground = world.groundHeight(x, z, 0.5, 1);
      if (ground === null || ground >= 0.2) continue;
      if (ground > 0.02 && !onRamp(x, z)) lips.add(`${fixed(ground)} m at (${fixed(x)}, ${fixed(z)})`);
      if (fits(x, ground, z, ROUTE_RADIUS)) free[r * columns + c] = 1;
      if (fits(x, ground, z)) freeCapsule[r * columns + c] = 1;
    }
  }
  const freeRoute = free;
  if (lips.size) failures.push(`raised lips on the ground: ${[...lips].slice(0, 6).join('; ')}`);
  const cellOf = (x, z) => [Math.floor((x - min.x) / CELL), Math.floor((z - min.z) / CELL)];
  const centreOf = (c, r) => [min.x + (c + 0.5) * CELL, min.z + (r + 0.5) * CELL];

  /** Breadth-first flood from a point; returns the parent table for path recovery. */
  const flood = (x, z) => {
    const parent = new Int32Array(columns * rows).fill(-1);
    const [c0, r0] = cellOf(x, z);
    const startIndex = r0 * columns + c0;
    if (!free[startIndex]) return parent;
    parent[startIndex] = startIndex;
    const queue = [startIndex];
    for (let head = 0; head < queue.length; head++) {
      const index = queue[head];
      const c = index % columns;
      const r = (index - c) / columns;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= columns || nr >= rows) continue;
        const next = nr * columns + nc;
        if (!free[next] || parent[next] !== -1) continue;
        parent[next] = index;
        queue.push(next);
      }
    }
    return parent;
  };
  const pathTo = (parent, x, z) => {
    const [c, r] = cellOf(x, z);
    let index = r * columns + c;
    if (parent[index] === -1) return null;
    const path = [];
    while (parent[index] !== index) {
      path.push(index);
      index = parent[index];
    }
    return path.reverse().map((i) => centreOf(i % columns, (i - (i % columns)) / columns));
  };

  /** Walk the capsule along waypoints with gravity. Returns the final position. */
  const walk = (from, waypoints, seconds) => {
    let position = from.clone();
    let vy = 0;
    let target = 0;
    const dt = 1 / 60;
    for (let step = 0; step < seconds * 60 && target < waypoints.length; step++) {
      const [tx, tz] = waypoints[target];
      const dx = tx - position.x;
      const dz = tz - position.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 0.3) {
        target++;
        continue;
      }
      vy -= GRAVITY * dt;
      const velocity = new Vec3((dx / distance) * WALK_SPEED, vy, (dz / distance) * WALK_SPEED);
      const result = world.moveCapsule(position, velocity, dt, RADIUS, HEIGHT);
      position = result.position;
      vy = result.onGround ? 0 : result.velocity.y;
    }
    return { position, reached: target >= waypoints.length };
  };

  const middle = [0, 0];
  // Places each of the three routes and both interiors must pass through.
  const landmarks = {
    'Filter Walk, west road': [-30, -29],
    'Filter Walk, east road': [30, 29],
    'west court': [-30, 8],
    'east court': [30, -8],
    'slot between the clarifiers': [0, 0],
    'south court under the west terrace': [-8, 8],
    'north court under the east terrace': [8, -8],
    'west maintenance court': [-6, 32],
    'east maintenance court': [6, -32],
    'south-west corner': [-42, 36],
    'north-east corner': [42, -36],
  };
  const doorways = {
    'west pump house (north door)': [-20.75, 29],
    'west pump house (west door)': [-26, 32.25],
    'west pump house (east door)': [-13.6, 35.75],
    'east pump house (south door)': [20.75, -29],
    'east pump house (east door)': [26, -32.25],
    'east pump house (west door)': [13.6, -35.75],
  };
  map.playerSpawns.forEach((spawn, i) => {
    const name = label('player', i, spawn);
    const parent = flood(spawn.position.x, spawn.position.z);
    for (const [place, [px, pz]] of Object.entries(landmarks)) {
      if (!pathTo(parent, px, pz)) failures.push(`${name}: no walking route to the ${place}`);
    }
    // Through ordinary doors, checked at the capsule's own width.
    free = freeCapsule;
    const throughDoors = flood(spawn.position.x, spawn.position.z);
    free = freeRoute;
    for (const [place, [px, pz]] of Object.entries(doorways)) {
      if (!pathTo(throughDoors, px, pz)) failures.push(`${name}: the capsule cannot reach the ${place}`);
    }
    map.enemySpawns.forEach((enemy, j) => {
      if (!pathTo(parent, enemy.position.x, enemy.position.z)) failures.push(`${name}: no walking route to ${label('enemy', j, enemy)}`);
    });
    const path = pathTo(parent, middle[0], middle[1]);
    if (!path) {
      failures.push(`${name}: no walking route to the map centre`);
      return;
    }
    // Thin the cell path to a waypoint every few cells, then walk it for real.
    const waypoints = path.filter((_, k) => k % 3 === 2 || k === path.length - 1);
    const outcome = walk(spawn.position, waypoints, 90);
    const miss = Math.hypot(outcome.position.x - middle[0], outcome.position.z - middle[1]);
    if (!outcome.reached || miss > 1) failures.push(`${name}: capsule stopped ${fixed(miss)} m short of the centre at (${fixed(outcome.position.x)}, ${fixed(outcome.position.z)})`);
    else notes.push(`${name}: walked ${fixed(path.length * CELL)} m to the centre`);
  });

  // ---- high ground
  const climbs = [
    { name: 'west court ramp', from: [-29, 0.05, 18.5], to: [[-27, 18.5], [-19, 18.5], [-14, 17.5]], expectY: 2.4 },
    { name: 'west lane ramp', from: [0.5, 0.05, 22.1], to: [[-1, 22.1], [-9, 22.1], [-9.5, 18]], expectY: 2.4 },
    { name: 'east court ramp', from: [29, 0.05, -18.5], to: [[27, -18.5], [19, -18.5], [14, -17.5]], expectY: 2.4 },
    { name: 'east lane ramp', from: [-0.5, 0.05, -22.1], to: [[1, -22.1], [9, -22.1], [9.5, -18]], expectY: 2.4 },
  ];
  for (const climb of climbs) {
    const outcome = walk(new Vec3(...climb.from), climb.to, 20);
    if (!outcome.reached || Math.abs(outcome.position.y - climb.expectY) > 0.12) {
      failures.push(`${climb.name}: ended at height ${fixed(outcome.position.y)} (${fixed(outcome.position.x)}, ${fixed(outcome.position.z)}), expected ${climb.expectY}`);
    } else notes.push(`${climb.name}: reached height ${fixed(outcome.position.y)}`);
  }

  // ---- nobody leaves: push hard at the edges from several places.
  const escapes = [
    [[0, 0.05, -30], [0, -90]],
    [[44, 0.05, -20], [90, -20]],
    [[-6, 0.05, 36], [-6, 90]],
    [[-44, 0.05, 20], [-90, 20]],
    [[-14, 2.45, 17.5], [-14, -40]],
    [[-9.5, 2.45, 22], [-9.5, 60]],
  ];
  for (const [from, toward] of escapes) {
    const outcome = walk(new Vec3(...from), [toward], 12);
    if (!map.bounds.containsPoint(outcome.position)) failures.push(`walked out of bounds toward (${toward}) and ended at (${fixed(outcome.position.x)}, ${fixed(outcome.position.y)}, ${fixed(outcome.position.z)})`);
  }

  const freeCells = free.reduce((sum, v) => sum + v, 0);
  notes.push(`walkable yard area about ${Math.round(freeCells * CELL * CELL)} m2 of ${Math.round(columns * rows * CELL * CELL)} m2 in bounds`);
  notes.push(`${map.playerSpawns.length} player spawns, ${map.enemySpawns.length} enemy spawns, ${map.interiors.length} interiors`);
  // ---- plan view for reading the layout: '.' reachable on foot from the first player spawn by a 0.9 m body,
  // '#' not, P and E the spawns. One character is 1.2 m; north is up.
  const STEP = 3;
  const plan = [];
  const reached = flood(map.playerSpawns[0].position.x, map.playerSpawns[0].position.z);
  for (let r = 0; r + STEP <= rows; r += STEP) {
    let line = '';
    for (let c = 0; c + STEP <= columns; c += STEP) {
      let open = 0;
      for (let dr = 0; dr < STEP; dr++) for (let dc = 0; dc < STEP; dc++) open += reached[(r + dr) * columns + c + dc] !== -1 ? 1 : 0;
      line += open >= 5 ? '.' : open > 0 ? ':' : '#';
    }
    plan.push(line.split(''));
  }
  const mark = (s, letter) => {
    const [c, r] = cellOf(s.position.x, s.position.z);
    const row = plan[Math.floor(r / STEP)];
    if (row) row[Math.floor(c / STEP)] = letter;
  };
  map.playerSpawns.forEach((s) => mark(s, 'P'));
  map.enemySpawns.forEach((s) => mark(s, 'E'));
  return { failures, notes, plan: plan.map((row) => row.join('')) };
}

let result = null;
let problem = 'did not load';
for (let attempt = 0; attempt < 3 && !result; attempt++) {
  try {
    await page.goto(`http://127.0.0.1:${port}/?autostart&map=headworks&bots=0&q=low`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => (window.__ironvale?.ready && window.__ironvale.game?.map) || window.__ironvale?.error, null, { timeout: 240000 });
    const loadError = await page.evaluate(() => window.__ironvale.error ?? null);
    if (loadError) {
      problem = loadError;
      break;
    }
    result = await page.evaluate(inspect);
  } catch (error) {
    // Another agent's edit can hot-reload the page mid-check; try again.
    problem = error.message.split('\n')[0];
  }
}
await browser.close();

if (!result) {
  process.stdout.write(`FAILED to run the check: ${problem}\n${pageErrors.slice(0, 5).join('\n')}\n`);
  process.exit(1);
}
if (process.argv.includes('--plan')) process.stdout.write(`${result.plan.join('\n')}\n`);
for (const note of result.notes) process.stdout.write(`ok    ${note}\n`);
for (const failure of result.failures) process.stdout.write(`FAIL  ${failure}\n`);
process.stdout.write(result.failures.length ? `${result.failures.length} problem(s)\n` : 'all checks passed\n');
process.exit(result.failures.length ? 1 : 0);
