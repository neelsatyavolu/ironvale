// Screenshots plus renderer statistics for the Railyard map, against the running dev server.
// Loads the map once and moves the camera between poses, so a full set takes one browser launch.
//
// Usage:
//   node scripts/dev/map-railyard-shot.mjs                      all named views at the high tier
//   node scripts/dev/map-railyard-shot.mjs --views spawn,quay   some of them
//   node scripts/dev/map-railyard-shot.mjs --pose name:x,y,z,yawDeg,pitchDeg   (repeatable)
//   options: --q low|medium|high|ultra  --no ssr,ao,godrays  --settle 1500  --breakdown  --prefix tag
//            --detail 0.35  rebuilds the map at that detail density (?q= only changes the renderer)
// Writes shots/railyard-<prefix><name>.png and prints draw calls, triangles and frame time per view.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/** Views a player actually gets: [x, feet y, z, yaw degrees, pitch degrees]. */
export const VIEWS = {
  spawn: [-3, 0, 45.5, 0, 0],
  'spawn-east': [9.8, 0, 45.5, 0, 0],
  avenue: [4, 0, 30, 0, -2],
  'avenue-north': [4, 0, -24, 180, 0],
  'lane-west': [-7, 0, 13, 0, 0],
  'lane-east': [12.2, 0, 22, 0, 0],
  'road-west': [-15.5, 0, 33, 0, 2],
  'warehouse-south': [-30, 0, 15, 0, 2],
  'warehouse-aisle': [-30, 0, -2, 0, 3],
  'warehouse-east': [-21, 0, 10, -40, 2],
  mezzanine: [-37, 3.06, 6, -75, -10],
  stairs: [-38.5, 0, -17, 150, 8],
  rails: [27, 0, 44, 0, 0],
  'rails-north': [26.6, 0, -27, 180, 0],
  'east-strip': [34, 0, 30, 5, 0],
  office: [37.1, 0.06, 17.2, 0, 0],
  'office-window': [36.4, 0.06, 13.6, 90, 0],
  quay: [-34, 0, -38, -90, 2],
  'quay-east': [30, 0, -40, 90, 4],
  'quay-sea': [-14, 0, -42, 15, 3],
  flatcar: [29.4, 1.2, -20, 170, -4],
  crossing: [-6.5, 0, 17.8, -90, 0],
  gate: [0, 0, 36, 180, 0],
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const quality = option('q', 'high');
const off = option('no', '');
const settle = Number(option('settle', '1500'));
const prefix = option('prefix', '');
const [width, height] = option('size', '1600x900').split('x').map(Number);
const port = option('port', '5311');
const breakdown = args.includes('--breakdown');

const custom = args.flatMap((value, index) => (args[index - 1] === '--pose' ? [value] : []));
const wanted = option('views', custom.length ? '' : Object.keys(VIEWS).join(','));
const shots = [
  ...wanted
    .split(',')
    .filter(Boolean)
    .map((name) => {
      if (!VIEWS[name]) throw new Error(`Unknown view "${name}". Known: ${Object.keys(VIEWS).join(', ')}`);
      return { name, pose: VIEWS[name] };
    }),
  ...custom.map((text) => {
    const [name, numbers] = text.split(':');
    return { name, pose: numbers.split(',').map(Number) };
  }),
];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
page.on('response', (response) => {
  if (response.status() >= 400) problems.push(`[http ${response.status()}] ${response.url()}`);
});

const first = shots[0].pose.join(',');
const query = `autostart&map=railyard&bots=${option('bots', '0')}&pose=${first}&q=${quality}${off ? `&no=${off}` : ''}`;
let status = 'ok';
try {
  await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 240000 });
} catch (error) {
  status = `timeout: ${error.message.split('\n')[0]}`;
}
const loadError = await page.evaluate(() => window.__ironvale?.error ?? null).catch((error) => String(error));
process.stdout.write(`load: ${status}${loadError ? ` error: ${loadError}` : ''}\n`);
const detail = option('detail', '');
if (detail && !loadError && status === 'ok') {
  await page.evaluate(async (value) => {
    const { game } = window.__ironvale;
    game.settings.update('graphics', { detailDensity: value });
    await game.restart();
  }, Number(detail));
}

await mkdir(join(root, 'shots'), { recursive: true });
const DEG = Math.PI / 180;
/** Other agents' edits hot-reload the page; wait for the match to be back before posing the camera. */
async function place(pose) {
  const [x, y, z, yaw, pitch] = pose;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.waitForFunction(() => window.__ironvale?.ready && window.__ironvale.game?.map, null, { timeout: 240000 });
      await page.evaluate(([px, py, pz, pyaw, ppitch]) => window.__ironvale.game.debugPose(px, py, pz, pyaw, ppitch), [x, y, z, yaw * DEG, pitch * DEG]);
      await page.waitForTimeout(settle);
      const stillThere = await page.evaluate(([px, pz]) => {
        const at = window.__ironvale?.game?.player?.position;
        return Boolean(at) && Math.hypot(at.x - px, at.z - pz) < 0.5;
      }, [x, z]);
      if (stillThere) return;
    } catch {
      // Navigation mid-call: try again once the page is back.
    }
  }
  throw new Error('page kept reloading');
}

/** One view: pose, measure, screenshot. Retried when a hot reload interrupts it. */
async function capture(shot) {
  await place(shot.pose);
  const info = await page.evaluate(async (wantBreakdown) => {
    const { engine } = window.__ironvale.game;
    const stats = engine.renderer.info;
    // Median of real frame intervals; the engine's own figure is a slow average.
    const intervals = await new Promise((resolve) => {
      const samples = [];
      let last = performance.now();
      const started = last;
      const tick = (now) => {
        samples.push(now - last);
        last = now;
        if (now - started < 900 && samples.length < 70) requestAnimationFrame(tick);
        else resolve(samples.slice(1).sort((a, b) => a - b));
      };
      requestAnimationFrame(tick);
    });
    const heavy = [];
    engine.scene.traverse((object) => {
      if (!object.isMesh || !object.geometry) return;
      const geometry = object.geometry;
      const count = (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
      const copies = object.isInstancedMesh ? object.count : 1;
      heavy.push([Math.round(count * copies), copies, object.material?.name || object.material?.type || '?']);
    });
    heavy.sort((a, b) => b[0] - a[0]);
    return {
      frameMs: Number((intervals[Math.floor(intervals.length / 2)] ?? 0).toFixed(1)),
      drawCalls: stats.render.drawCalls,
      triangles: stats.render.triangles,
      sceneTriangles: heavy.reduce((sum, row) => sum + row[0], 0),
      detail: window.__ironvale.game.settings?.value.graphics.detailDensity ?? null,
      textures: stats.memory.textures,
      geometries: stats.memory.geometries,
      position: window.__ironvale.game.player.position.toArray().map((n) => Number(n.toFixed(2))),
      heaviest: wantBreakdown ? heavy.slice(0, 14) : undefined,
    };
  }, breakdown);
  const file = join(root, 'shots', `railyard-${prefix}${shot.name}.png`);
  await page.screenshot({ path: file, timeout: 120000 });
  const moved = await page.evaluate(() => !window.__ironvale?.ready);
  if (moved) throw new Error('reloaded during capture');
  process.stdout.write(`${file} ${JSON.stringify(info)}\n`);
}

for (const shot of loadError || status !== 'ok' ? [] : shots) {
  let done = false;
  for (let attempt = 0; attempt < 4 && !done; attempt++) {
    try {
      await capture(shot);
      done = true;
    } catch (error) {
      if (attempt === 3) process.stdout.write(`${shot.name}: failed: ${error.message.split('\n')[0]}\n`);
    }
  }
}
await browser.close();

const unique = [...new Set(problems)];
for (const line of unique.slice(0, 20)) process.stdout.write(`${line.slice(0, 500)}\n`);
if (unique.length > 20) process.stdout.write(`... ${unique.length - 20} more\n`);
