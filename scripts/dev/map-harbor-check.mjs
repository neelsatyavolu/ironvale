// Loads the Harbor map in headless Chrome and checks, against the real collision world:
//  - every spawn has ground just under it and is not inside a collider
//  - a capsule can walk from each player spawn to the middle of the map
//  - every stair, ramp and the two ways out of the water can be walked
// Usage: node scripts/dev/map-harbor-check.mjs   (exit code 1 on any failure)
import { chromium } from 'playwright';

const port = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '5311';
const TERRACE = 3.06;

// Each walk is a list of [x, z] waypoints; `endY` is the floor height expected at the end.
const WALKS = [
  { name: 'street spawn A to square', from: 'player0', via: [[42.5, -1.2], [40.3, -2.5], [37.5, -3], [30, -1], [12, -0.6], [6.5, 0.9], [5, -3]], endY: 0 },
  { name: 'street spawn B to square', from: 'player1', via: [[40.4, 1.3], [37.5, 1.2], [30, -1], [12, -0.6], [6.5, 0.9], [5, -3]], endY: 0 },
  { name: 'quay spawn A to square via passage', from: 'player2', via: [[45.3, 11.9], [42, 11.3], [39.5, 13.5], [38, 15], [12, 15], [9.25, 11.5], [9.25, 0.5], [6.5, 0.9], [5, -3]], endY: 0 },
  { name: 'quay spawn B to square via cafe', from: 'player3', via: [[45.6, 18.7], [41, 18.9], [39.4, 17], [38, 15], [0, 15], [-1.4, 11], [-1.4, 8], [-3, 5], [-3, 0.5], [-3, -2]], endY: 0 },
  { name: 'east ramp to terrace', start: [32, 0.05, -2], via: [[32, -6], [32, -18.5]], endY: TERRACE },
  { name: 'stepped alley to terrace', start: [-30.75, 0.05, -2], via: [[-30.75, -15], [-30.75, -18.5]], endY: TERRACE },
  { name: 'square stair, west flight', start: [-10.5, 0.05, -12], via: [[-9.4, -14.9], [0, -14.9], [0, -18.5]], endY: TERRACE },
  { name: 'square stair, east flight', start: [10.5, 0.05, -12], via: [[9.4, -14.9], [0, -14.9], [0, -18.5]], endY: TERRACE },
  { name: 'terrace end to end', start: [48, TERRACE + 0.05, -19], via: [[26, -18], [8, -18.8], [-14, -18.8], [-30, -20.4], [-48, -19]], endY: TERRACE },
  { name: 'quay end to end', start: [49, 0.05, 14.5], via: [[45.6, 18.7], [41, 18.9], [39.4, 17], [38, 15], [-36, 15.2], [-39.5, 17.2], [-44, 14.5]], endY: 0 },
  { name: 'main street end to end', start: [48, 0.05, -1], via: [[42.5, -1.2], [40.3, -2.5], [37.5, -3], [30, -1], [12, -0.6], [6, 0.9], [-13, 1], [-17, -0.9], [-36, -0.9], [-37, 1], [-40.5, 1], [-47, -1]], endY: 0 },
  { name: 'lane by the net store', start: [-36.75, 0.05, 12], via: [[-36.75, -1]], endY: 0 },
  { name: 'lane west of the cafe', start: [-14, 0.05, 12], via: [[-14, -1]], endY: 0 },
  { name: 'lane at the east end', start: [34.75, 0.05, 12], via: [[34.75, -1]], endY: 0 },
  { name: 'through the net store', start: [-30.25, 0.05, 12], via: [[-30.25, 8.5], [-28.6, 6.5], [-28, 3], [-28, -1]], endY: 0 },
  { name: 'cafe side door to lane', start: [-6, 0.05, 6.2], via: [[-10.5, 6], [-13.5, 6]], endY: 0 },
  { name: 'middle jetty to its head', start: [3, 0.05, 18], via: [[3, 36], [6, 36.6]], endY: 0 },
  { name: 'out along the mole', start: [-44, 0.05, 15], via: [[-48.5, 21], [-48.5, 40]], endY: 0 },
  { name: 'water steps back to the quay', start: [-9.8, -1.39, 20.75], via: [[-5.4, 20.75], [-5.4, 18]], endY: 0 },
  { name: 'slipway back to the quay', start: [43.5, -1.45, 36], via: [[43.5, 18]], endY: 0 },
];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

const check = () =>
  page.evaluate((walks) => {
    const game = window.__ironvale.game;
    const world = game.world;
    const map = game.map;
    const V = map.playerSpawns[0].position.constructor;
    const failures = [];
    const RADIUS = 0.34;
    const HEIGHT = 1.8;

    const spawns = [
      ...map.playerSpawns.map((s, i) => ({ name: `player${i}`, p: s.position })),
      ...map.enemySpawns.map((s, i) => ({ name: `enemy${i}`, p: s.position })),
    ];
    for (const { name, p } of spawns) {
      const where = `${name} (${p.x}, ${p.y}, ${p.z})`;
      if (!map.bounds.containsPoint(p)) failures.push(`${where}: outside bounds`);
      const ground = world.groundHeight(p.x, p.z, p.y + 1, 4);
      if (ground === null) failures.push(`${where}: no ground below`);
      else if (Math.abs(p.y - ground - 0.05) > 0.06) failures.push(`${where}: ground is at ${ground.toFixed(3)}, expected ${(p.y - 0.05).toFixed(3)}`);
      // Nothing solid inside the capsule: probe sideways at three heights, and upward for a roof that is too low.
      for (const h of [0.45, 1.0, 1.6]) {
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          const hit = world.raycast(new V(p.x, p.y + h, p.z), new V(Math.cos(a), 0, Math.sin(a)), 0.7);
          if (hit) failures.push(`${where}: collider ${hit.distance.toFixed(2)} m away at height ${h}`);
        }
      }
      const roof = world.raycast(new V(p.x, p.y + 0.3, p.z), new V(0, 1, 0), 1.9);
      if (roof) failures.push(`${where}: only ${(roof.distance + 0.3).toFixed(2)} m of headroom`);
      const settled = world.moveCapsule(p.clone(), new V(0, -1, 0), 0.05, RADIUS, HEIGHT);
      if (Math.hypot(settled.position.x - p.x, settled.position.z - p.z) > 0.03) failures.push(`${where}: capsule is pushed sideways on spawn`);
    }

    const results = [];
    for (const walk of walks) {
      let pos;
      if (walk.from) {
        const spawn = spawns.find((s) => s.name === walk.from);
        pos = spawn.p.clone();
      } else pos = new V(walk.start[0], walk.start[1], walk.start[2]);
      let vy = 0;
      let reached = true;
      let stuckAt = null;
      for (const [tx, tz] of walk.via) {
        const budget = (Math.hypot(tx - pos.x, tz - pos.z) / 4.5) * 2.5 + 2;
        let t = 0;
        while (Math.hypot(tx - pos.x, tz - pos.z) > 0.45) {
          const dx = tx - pos.x;
          const dz = tz - pos.z;
          const d = Math.hypot(dx, dz);
          vy -= 17.5 / 60;
          const result = world.moveCapsule(pos, new V((dx / d) * 4.5, vy, (dz / d) * 4.5), 1 / 60, RADIUS, HEIGHT);
          pos = result.position;
          vy = result.onGround ? Math.max(0, result.velocity.y) : result.velocity.y;
          t += 1 / 60;
          if (t > budget || pos.y < -6) {
            reached = false;
            stuckAt = [pos.x.toFixed(2), pos.y.toFixed(2), pos.z.toFixed(2)];
            break;
          }
        }
        if (!reached) break;
      }
      const ok = reached && Math.abs(pos.y - walk.endY) < 0.25;
      results.push(`${ok ? 'ok  ' : 'FAIL'} ${walk.name}${ok ? '' : reached ? ` (ended at y ${pos.y.toFixed(2)}, expected ${walk.endY})` : ` (stuck at ${stuckAt})`}`);
      if (!ok) failures.push(`walk "${walk.name}" failed`);
    }

    // Nobody may leave: push a capsule hard at the boundary from inside at a ring of points.
    const b = map.bounds;
    const escapes = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      for (const [sx, sy, sz] of [[0, 0.05, 15], [0, 3.11, -19], [0, 0.05, -1], [3, 0.05, 30]]) {
        let pos = new V(sx, sy, sz);
        let vy = 0;
        for (let step = 0; step < 60 * 40; step++) {
          vy -= 17.5 / 60;
          const result = world.moveCapsule(pos, new V(Math.cos(a) * 6, vy, Math.sin(a) * 6), 1 / 60, RADIUS, HEIGHT);
          pos = result.position;
          vy = result.onGround ? 0 : result.velocity.y;
        }
        if (!b.containsPoint(pos)) escapes.push(`from (${sx}, ${sz}) heading ${Math.round((a * 180) / Math.PI)} deg ended at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
      }
    }
    for (const escape of escapes.slice(0, 8)) failures.push(`left the bounds: ${escape}`);

    return { spawnCount: spawns.length, results, failures, escapes: escapes.length };
  }, WALKS);

let report = null;
let fatal = null;
for (let attempt = 0; attempt < 6 && !report; attempt++) {
  try {
    await page.goto(`http://127.0.0.1:${port}/?autostart&map=harbor&bots=0&q=low`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
    const error = await page.evaluate(() => window.__ironvale.error);
    if (error) {
      fatal = error;
      break;
    }
    report = await check();
  } catch (error) {
    // The dev server reloads the page when someone else saves a file; go again.
    fatal = error.message.split('\n')[0];
  }
}
await browser.close();

if (!report) {
  process.stdout.write(`Harbor check could not run: ${fatal}\n${pageErrors.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${report.spawnCount} spawns checked\n${report.results.join('\n')}\nboundary escapes: ${report.escapes}\n`);
for (const failure of report.failures) process.stdout.write(`FAIL ${failure}\n`);
process.stdout.write(report.failures.length ? `${report.failures.length} problem(s)\n` : 'Harbor check passed\n');
process.exit(report.failures.length ? 1 : 0);
