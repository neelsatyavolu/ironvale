// Gameplay checks for Pinewood, run against the real map in the dev server:
//  - every spawn has ground under it, is not inside a collider and has head room;
//  - a capsule can walk from each player spawn to the middle of the map;
//  - the trail, the creek and the ridge can each be walked end to end;
//  - the hunting stand's stair takes a capsule up onto the deck;
//  - nobody can walk out of the play area;
//  - no enemy spawn has a line of sight to a player spawn.
// Usage: node scripts/dev/map-pinewood-check.mjs    (exit code 1 when a check fails)
import { chromium } from 'playwright';

const port = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '5311';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const problems = [];
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

async function run() {
  await page.goto(`http://127.0.0.1:${port}/?autostart&map=pinewood&bots=0&q=low`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ironvale?.error || (window.__ironvale?.ready && window.__ironvale.game.map), null, { timeout: 120000 });
  return page.evaluate(() => {
    const { game, error } = window.__ironvale;
    if (error) return { failures: [`load error: ${error}`], notes: [] };
    const { world, map } = game;
    const RADIUS = 0.34;
    const HEIGHT = 1.8;
    const STEP = 1 / 60;
    const failures = [];
    const notes = [];
    const vec = (x, y, z) => map.playerSpawns[0].position.clone().set(x, y, z);
    const ground = (x, z, from = 40) => world.groundHeight(x, z, from, 90);

    // Spawns.
    const spawns = [
      ...map.playerSpawns.map((spawn, i) => ({ name: `player ${i}`, spawn })),
      ...map.enemySpawns.map((spawn, i) => ({ name: `enemy ${i}`, spawn })),
    ];
    for (const { name, spawn } of spawns) {
      const p = spawn.position;
      const at = `${name} (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`;
      const floor = ground(p.x, p.z, p.y + 1.5);
      if (floor === null) failures.push(`${at}: no ground`);
      else if (Math.abs(p.y - 0.05 - floor) > 0.12) failures.push(`${at}: spawn y ${p.y.toFixed(2)} but ground is ${floor.toFixed(2)}`);
      if (!map.bounds.containsPoint(p)) failures.push(`${at}: outside bounds`);
      const settled = world.moveCapsule(vec(p.x, p.y + 0.02, p.z), vec(0, 0, 0), STEP, RADIUS, HEIGHT);
      const shove = Math.hypot(settled.position.x - p.x, settled.position.z - p.z);
      if (shove > 0.02) failures.push(`${at}: inside a collider (pushed ${shove.toFixed(2)} m)`);
      if (world.raycast(vec(p.x, p.y + 0.4, p.z), vec(0, 1, 0), 2.2)) failures.push(`${at}: no head room`);
      for (let k = 0; k < 8; k++) {
        const angle = (k / 8) * Math.PI * 2;
        const hit = world.raycast(vec(p.x, p.y + 1.0, p.z), vec(Math.cos(angle), 0, Math.sin(angle)), 0.6);
        if (hit) failures.push(`${at}: geometry ${hit.distance.toFixed(2)} m away at chest height`);
      }
    }

    /**
     * Walk a capsule through waypoints. Steers straight at the next waypoint and
     * side-steps for a moment whenever it stops making progress.
     */
    const walk = (label, points, { speed = 4.2, reach = 1.6, seconds = 90, startFrom = 40 } = {}) => {
      const [sx, sz] = points[0];
      let position = vec(sx, (ground(sx, sz, startFrom) ?? 0) + 0.05, sz);
      let velocityY = 0;
      let target = 1;
      let sidestep = 0;
      let sideSign = 1;
      let lastProgress = Infinity;
      let sinceProgress = 0;
      let maxDrop = 0;
      for (let t = 0; t < seconds; t += STEP) {
        const [tx, tz] = points[target];
        const dx = tx - position.x;
        const dz = tz - position.z;
        const distance = Math.hypot(dx, dz);
        if (distance < reach) {
          target++;
          lastProgress = Infinity;
          if (target >= points.length) return { ok: true, position, time: t };
          continue;
        }
        if (distance < lastProgress - 0.05) {
          lastProgress = distance;
          sinceProgress = 0;
        } else sinceProgress += STEP;
        if (sinceProgress > 0.6 && sidestep <= 0) {
          sidestep = 0.7;
          sideSign = -sideSign;
          sinceProgress = 0;
          lastProgress = Infinity;
        }
        let heading = Math.atan2(dz, dx);
        if (sidestep > 0) {
          heading += sideSign * 1.35;
          sidestep -= STEP;
        }
        velocityY -= 22 * STEP;
        const result = world.moveCapsule(position, vec(Math.cos(heading) * speed, velocityY, Math.sin(heading) * speed), STEP, RADIUS, HEIGHT);
        maxDrop = Math.max(maxDrop, position.y - result.position.y);
        position = result.position;
        velocityY = result.onGround ? Math.min(0, result.velocity.y) : result.velocity.y;
        if (position.y < map.bounds.min.y) {
          failures.push(`${label}: fell out of the world at (${position.x.toFixed(1)}, ${position.z.toFixed(1)})`);
          return { ok: false, position };
        }
      }
      failures.push(`${label}: stuck at (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}) heading for waypoint ${target} (${points[target].join(', ')})`);
      return { ok: false, position };
    };

    // Player spawns to the middle of the map.
    map.playerSpawns.forEach((spawn, i) => {
      const result = walk(`player ${i} to centre`, [[spawn.position.x, spawn.position.z], [-3.6, 2]]);
      if (result.ok) notes.push(`player ${i} reached the centre in ${result.time.toFixed(1)} s`);
    });

    // The three routes, south to north.
    const routes = {
      trail: [[7.4, 49.6], [7.2, 45.5], [4.4, 43], [2.4, 39], [2.4, 34], [0.6, 24], [-2.4, 13], [-4, 6], [-3.4, -8], [0.5, -20], [4.6, -30], [7.4, -40], [7.6, -47]],
      creek: [[5, 51], [-18, 48], [-36.5, 46], [-31, 28], [-33.8, 10], [-26, -8], [-22.4, -25], [-27.6, -42], [-27.5, -48]],
      ridge: [[9.8, 50.8], [26, 47], [38, 44], [39.5, 24], [38.5, 5.5], [39, -12], [37.5, -30], [39, -44]],
    };
    for (const [name, points] of Object.entries(routes)) {
      const result = walk(`${name} route`, points, { seconds: 140 });
      if (result.ok) notes.push(`${name} route walked in ${result.time.toFixed(1)} s`);
    }

    // Into the cabin by the door and out through the breach.
    const cabin = walk('cabin door to breach', [[-5, -4.4], [-8.6, -4.3], [-12, -5], [-15.2, -6.4], [-15.4, -9.6]], { reach: 0.8, seconds: 40 });
    if (cabin.ok) notes.push('cabin: in by the door, out by the breach');

    // Up the hunting stand's stair.
    const stair = walk('stand stair', [[38.4, 3], [36.6, 3], [31.4, 3], [30.4, 3]], { reach: 0.7, seconds: 30, speed: 3 });
    const deck = ground(30.4, 3, 7);
    if (stair.ok && deck !== null && Math.abs(stair.position.y - deck) < 0.3) notes.push(`stand: climbed to the deck at y ${stair.position.y.toFixed(2)}`);
    else if (stair.ok) failures.push(`stand stair: ended at y ${stair.position.y.toFixed(2)}, deck is at ${deck}`);

    // Nobody leaves: push outward from the middle in sixteen directions.
    for (let k = 0; k < 16; k++) {
      const angle = (k / 16) * Math.PI * 2;
      let position = vec(Math.cos(angle) * 30, 0, Math.sin(angle) * 30);
      position.y = (ground(position.x, position.z) ?? 0) + 0.05;
      let velocityY = 0;
      for (let t = 0; t < 40; t += STEP) {
        velocityY -= 22 * STEP;
        const result = world.moveCapsule(position, vec(Math.cos(angle) * 6, velocityY, Math.sin(angle) * 6), STEP, RADIUS, HEIGHT);
        position = result.position;
        velocityY = result.onGround ? Math.min(0, result.velocity.y) : result.velocity.y;
      }
      if (!map.bounds.containsPoint(position)) failures.push(`escaped the play area heading ${Math.round((angle * 180) / Math.PI)} deg, ended at (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`);
    }
    // No enemy starts with a line on a player spawn, and none starts close to one.
    const eye = (spawn) => spawn.position.clone().setY(spawn.position.y + 1.64);
    let nearest = Infinity;
    map.enemySpawns.forEach((enemy, i) => {
      map.playerSpawns.forEach((player, k) => {
        const distance = enemy.position.distanceTo(player.position);
        nearest = Math.min(nearest, distance);
        if (world.lineOfSight(eye(enemy), eye(player))) failures.push(`enemy spawn ${i} can see player spawn ${k} from ${distance.toFixed(0)} m`);
      });
    });
    if (nearest < 40) failures.push(`an enemy spawns ${nearest.toFixed(0)} m from a player spawn`);
    else notes.push(`no enemy spawn sees a player spawn; the nearest is ${nearest.toFixed(0)} m away`);
    notes.push(`spawns: ${map.playerSpawns.length} player, ${map.enemySpawns.length} enemy; interiors: ${map.interiors.length}`);
    return { failures, notes };
  });
}

let result = null;
for (let attempt = 1; attempt <= 4 && !result; attempt++) {
  try {
    result = await run();
  } catch (error) {
    // The dev server reloads the page when another agent saves a file; try again.
    if (attempt === 4) result = { failures: [`could not run: ${error.message.split('\n')[0]}`], notes: [] };
  }
}
await browser.close();
for (const note of result.notes) process.stdout.write(`ok   ${note}\n`);
for (const failure of [...result.failures, ...problems]) process.stdout.write(`FAIL ${failure}\n`);
process.stdout.write(result.failures.length + problems.length === 0 ? 'pinewood: all checks passed\n' : `pinewood: ${result.failures.length + problems.length} problem(s)\n`);
process.exit(result.failures.length + problems.length === 0 ? 0 : 1);
