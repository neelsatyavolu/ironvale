// Loads the Harbor map in headless Chrome and reports renderer.info for a list of poses.
// Usage: node scripts/dev/map-harbor-info.mjs [--q high] [--shots] [--clean] [--only name,name] [--poses "x,y,z,yaw,pitch;..."]
// --clean hides the weapon and HUD so the level itself can be judged.
// With --shots it also writes shots/harbor-<tier>-<n>.png for each pose.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const tier = arg('q', 'high');
const port = arg('port', '5311');
const shots = process.argv.includes('--shots');
const clean = process.argv.includes('--clean');
const prefix = arg('prefix', `harbor-${tier}`);
const extra = arg('extra', '');

export const POSES = [
  ['spawn-quay', 48.5, 0, 13.2, 90, 0],
  ['spawn-street', 47.5, 0, -1.4, 90, 2],
  ['quay-mid', 22, 0, 15, 96, -2],
  ['quay-long', -46, 0, 15.5, -90, 0],
  ['square', 9.6, 0, 0.6, 32, 4],
  ['square-stairs', -9.5, 0, -2, -55, 8],
  ['terrace', 0, 3.06, -17.2, 180, -8],
  ['terrace-east', 40, 3.06, -19, 90, 0],
  ['alley', -30.7, 0, -4.6, 0, 14],
  ['passage', 9.25, 0, -1.5, 180, 2],
  ['cafe', -10.2, 0, 8.6, -115, 0],
  ['net-store', -27.6, 0, 3.4, 125, 0],
  ['jetty', 3, 0, 36.5, 5, 0],
  ['mole', -48.5, 0, 40, -75, -2],
  ['ramp', 32, 0, -3, 0, 10],
  ['sun', 20, 0, 16, 155, 6],
  ['street-mid', 24, 0, -1, 90, 2],
  ['lane', -14, 0, -1.5, 180, 4],
];
const custom = arg('poses', '');
const poses = custom
  ? custom.split(';').map((p, i) => [`custom${i}`, ...p.split(',').map(Number)])
  : POSES.filter(([name]) => !arg('only', '') || arg('only', '').split(',').includes(name));

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

const [, x0, y0, z0, yaw0, pitch0] = poses[0];
const url = `http://127.0.0.1:${port}/?autostart&map=harbor&bots=0&q=${tier}&pose=${x0},${y0},${z0},${yaw0},${pitch0}${extra ? `&${extra}` : ''}`;
const waitReady = () =>
  page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });

const started = Date.now();
let status = 'ok';
try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await waitReady();
} catch (error) {
  status = `timeout: ${error.message.split('\n')[0]}`;
}
const loadError = await page.evaluate(() => window.__ironvale?.error ?? null).catch((e) => `evaluate failed: ${e.message}`);
process.stdout.write(`status: ${status}, load ${Date.now() - started} ms, error: ${loadError}\n`);

const measure = ([px, py, pz, pyaw, ppitch]) =>
  page.evaluate(
    async ([x, y, z, yaw, pitch, hide]) => {
      const game = window.__ironvale.game;
      if (hide) {
        // Judge the level without the weapon and HUD in the way.
        // The weapon rig re-shows itself every frame, so take its meshes off every layer instead.
        for (const child of game.engine.camera.children) child.traverse((object) => object.layers.disableAll());
        for (const element of document.body.children) if (element.tagName !== 'CANVAS') element.style.visibility = 'hidden';
      }
      game.debugPose(x, y, z, (yaw * Math.PI) / 180, (pitch * Math.PI) / 180);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const info = game.engine.renderer.info;
      return {
        calls: info.render.drawCalls,
        triangles: info.render.triangles,
        frameCalls: info.render.frameCalls,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        frameMs: Math.round(game.engine.frameTimeMs * 10) / 10,
        scale: game.engine.renderScale,
      };
    },
    [px, py, pz, pyaw, ppitch, clean],
  );

if (status === 'ok' && !loadError) {
  await mkdir(join(root, 'shots'), { recursive: true });
  for (const [name, ...pose] of poses) {
    // Other people's edits make the dev server reload the page; wait for it and try again.
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const info = await measure(pose);
        if (shots) await page.screenshot({ path: join(root, 'shots', `${prefix}-${name}.png`), timeout: 45000 });
        process.stdout.write(`${name.padEnd(14)} ${JSON.stringify(info)}\n`);
        break;
      } catch (error) {
        process.stdout.write(`${name}: retry ${attempt + 1} (${error.message.split('\n')[0].slice(0, 90)})\n`);
        await page.waitForTimeout(1500);
        await waitReady().catch(() => {});
      }
    }
  }
}
await browser.close();
const unique = [...new Set(problems)];
for (const line of unique.slice(0, 20)) process.stdout.write(`${line.slice(0, 500)}\n`);
if (unique.length > 20) process.stdout.write(`... ${unique.length - 20} more\n`);
