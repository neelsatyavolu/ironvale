// Visits camera poses on one map load, screenshots each and scores flicker: the share of pixels that change
// noticeably when the camera slides 1 mm sideways (z-fighting speckle reshuffles; real detail does not).
// Effects that change every frame (grain, TAA, rain, bloom, light shafts) are switched off for the score.
// Usage: node scripts/dev/map-tour.mjs <map> <poses.json> [--out shots/tour] [--port 5311] [--look]
//   poses.json: { "name": [x, y, z, yawDeg, pitchDeg] } camera (eye) positions, or { "name": { "at": [x,y,z], "from": [x,y,z] } }
//   --look keeps every effect on and only takes the screenshot (how the player sees it).
//   <poses.json> may be "spawns": every spawn at eye height, looking at the map centre and away from it.
//   --zfight shots/zfight/<map>.json adds a view of each overlap found by map-zfight.mjs (largest 20).
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const [mapId, posesFile] = process.argv.slice(2);
const port = arg('--port', '5311');
const out = arg('--out', 'shots/tour');
const look = process.argv.includes('--look');
// --live: every effect on except film grain (which is meant to change each frame); scores a still camera only.
const live = process.argv.includes('--live');
const poses = posesFile === 'spawns' ? {} : JSON.parse(await readFile(posesFile, 'utf8'));
const zfightFile = arg('--zfight', null);
if (zfightFile) {
  const found = JSON.parse(await readFile(zfightFile, 'utf8')).pairs
    .filter((p) => !(Math.abs(p.normal[1]) > 0.9 && p.gap >= 0.002))
    .sort((p, q) => q.area - p.area)
    .slice(0, 20);
  found.forEach((p, i) => {
    const [x, y, z] = p.where[0];
    const [nx, ny, nz] = p.normal;
    const flat = Math.abs(ny) > 0.9;
    const from = flat ? [x + 5, y + 4 * Math.sign(ny || 1), z + 5] : [x + nx * 7, y + 0.5, z + nz * 7];
    poses[`z${String(i).padStart(2, '0')}`] = { at: [x, y, z], from };
  });
}
await mkdir(out, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const off = look ? '' : live ? '&no=grain' : '&no=grain,aa,bloom,godrays';
await page.goto(`http://127.0.0.1:${port}/?autostart&map=${mapId}&bots=0&q=high${off}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 180000 });
await page.evaluate((lookMode) => {
  window.__tourLook = lookMode;
  const game = window.__ironvale.game;
  const camera = game.engine.camera;
  window.__tour = { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 };
  game.player.update = () => {
    const t = window.__tour;
    camera.rotation.order = 'YXZ';
    camera.position.set(t.x, t.y, t.z);
    camera.rotation.set(t.pitch, t.yaw, 0);
    camera.updateMatrixWorld(true);
  };
  // Keep only the map and lights: no rain, weapon or effects, so frame-to-frame noise is the map's own.
  const root = game.map.root;
  window.__tourHide = () => {
    for (const child of game.engine.scene.children) if (child !== root && !child.isLight && child !== camera && (child.isMesh || child.isGroup || child.isPoints || child.isLine)) child.visible = false;
    // The gun rig turns itself back on every frame, so pin it off.
    for (const child of camera.children) Object.defineProperty(child, 'visible', { get: () => false, set: () => {}, configurable: true });
  };
  if (!window.__tourLook) window.__tourHide();
  for (const el of document.querySelectorAll('.hud, #hud, [class*="hud"]')) el.style.visibility = 'hidden';
});

const DEG = Math.PI / 180;
if (posesFile === 'spawns') {
  const spawns = await page.evaluate(() => {
    const { map } = window.__ironvale.game;
    const c = map.bounds.getCenter(map.bounds.min.clone());
    return [...map.playerSpawns.map((s) => ['p', s]), ...map.enemySpawns.map((s) => ['e', s])].map(([k, s]) => [k, s.position.x, s.position.y, s.position.z, c.x, c.z]);
  });
  spawns.forEach(([k, x, y, z, cx, cz], i) => {
    const toward = (Math.atan2(-(cx - x), -(cz - z)) * 180) / Math.PI;
    poses[`${k}${i}-in`] = [x, y + 1.64, z, toward, -4];
    poses[`${k}${i}-out`] = [x, y + 1.64, z, toward + 180, -4];
  });
}
const toPose = (p) => {
  if (Array.isArray(p)) return { x: p[0], y: p[1], z: p[2], yaw: p[3] * DEG, pitch: p[4] * DEG };
  const [ax, ay, az] = p.at, [fx, fy, fz] = p.from;
  const dx = ax - fx, dy = ay - fy, dz = az - fz;
  return { x: fx, y: fy, z: fz, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
};
const set = (pose) => page.evaluate((p) => { Object.assign(window.__tour, p); if (window.__tourHide && !window.__tourLook) window.__tourHide(); }, pose);
const grab = () => page.screenshot();
/** Fraction of pixels whose luma moves by more than 24/255 between two PNG screenshots. */
const diff = async (a, b, overlay) => {
  const [p, q] = await Promise.all([a, b].map((png) => sharp(png).greyscale().raw().toBuffer()));
  let n = 0;
  const mask = overlay ? Buffer.alloc(p.length * 3) : null;
  for (let i = 0; i < p.length; i++) {
    const hit = Math.abs(p[i] - q[i]) > 24;
    if (hit) n++;
    if (mask) {
      mask[i * 3] = hit ? 255 : p[i] >> 2;
      mask[i * 3 + 1] = hit ? 0 : p[i] >> 2;
      mask[i * 3 + 2] = hit ? 0 : p[i] >> 2;
    }
  }
  if (mask) {
    const { width, height } = await sharp(a).metadata();
    await sharp(mask, { raw: { width, height, channels: 3 } }).png().toFile(overlay);
  }
  return n / p.length;
};

for (const [name, raw] of Object.entries(poses)) {
  const pose = toPose(raw);
  await set(pose);
  await page.waitForTimeout(look ? 1500 : 900);
  await page.screenshot({ path: `${out}/${mapId}-${name}.png` });
  if (look) {
    process.stdout.write(`${name}\n`);
    continue;
  }
  if (live) {
    await page.waitForTimeout(700);
    const a = await grab();
    await page.waitForTimeout(400);
    const b = await grab();
    const still = await diff(a, b, `${out}/${mapId}-${name}-live-diff.png`);
    process.stdout.write(`${name.padEnd(28)} live-still ${(still * 100).toFixed(2).padStart(6)}%\n`);
    continue;
  }
  const a = await grab();
  const right = { x: Math.cos(pose.yaw) * 0.001, z: -Math.sin(pose.yaw) * 0.001 };
  await set({ ...pose, x: pose.x + right.x, z: pose.z + right.z });
  await page.waitForTimeout(250);
  const b = await grab();
  await set(pose);
  await page.waitForTimeout(250);
  const c = await grab();
  // Same pose twice gives the noise floor (animated water, lamps); the 1 mm move adds z-fight speckle.
  const moved = await diff(a, b, `${out}/${mapId}-${name}-diff.png`);
  const still = await diff(a, c);
  process.stdout.write(`${name.padEnd(28)} moved ${(moved * 100).toFixed(2).padStart(6)}%  still ${(still * 100).toFixed(2).padStart(6)}%\n`);
}
if (errors.length) process.stdout.write(`page errors: ${[...new Set(errors)].slice(0, 5).join(' | ')}\n`);
await browser.close();
