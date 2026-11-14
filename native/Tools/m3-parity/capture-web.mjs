#!/usr/bin/env node
// Web reference captures for the M3 parity check (PLAN.md section 7, M3 row).
//
// Starts Vite (no watcher, no HMR) and Chrome with WebGPU, loads
// ?autostart&map=railyard&bots=0&pose=...&q=high&no=<off> once, then moves the camera between
// the poses in native/Parity/railyard-poses.json with game.debugPose and screenshots the canvas
// at 2560x1600 (1280x800 viewport at device scale 2).
//
// Weather is switched off by removing the FX root ('fx') from the scene, and the first-person
// rig (the camera's children) and the DOM HUD are hidden: M3 renders static level geometry only.
// The web clock, water and lamp flicker still run; freezing them is W5 (PLAN.md 13, Q4), which
// needs a change under src/ and is pending the owner's approval.
//
// Usage: node native/Tools/m3-parity/capture-web.mjs [--out DIR] [--no grain,aa] [--settle MS]
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const out = resolve(option('out', join(repo, 'native/Parity/web')));
const off = option('no', 'grain,aa');
const settle = Number(option('settle', '2500'));
const { poses } = JSON.parse(readFileSync(join(repo, 'native/Parity/railyard-poses.json'), 'utf8'));
const names = Object.keys(poses);

async function launch() {
  const flags = ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'];
  try {
    return await chromium.launch({ channel: 'chrome', headless: true, args: flags });
  } catch {
    return await chromium.launch({ headless: true, args: flags });
  }
}

const server = await createServer({
  configFile: join(repo, 'vite.config.ts'),
  root: repo,
  logLevel: 'warn',
  server: { host: '127.0.0.1', port: 5391, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  const first = poses[names[0]].join(',');
  const query = `autostart&map=railyard&bots=0&pose=${first}&q=high${off ? `&no=${off}` : ''}`;
  await page.goto(`${base}?${query}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 300000 });
  const error = await page.evaluate(() => window.__ironvale?.error ?? null);
  if (error) throw new Error(`web build failed to start: ${error}`);
  const backend = await page.evaluate(() => (window.__ironvale.game.engine.isWebGPU ? 'webgpu' : 'webgl2'));
  await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas#view { visibility: visible !important; }' });
  mkdirSync(out, { recursive: true });
  for (const name of names) {
    const [x, y, z, yaw, pitch] = poses[name];
    await page.evaluate(
      ([px, py, pz, pyaw, ppitch]) => {
        const { game } = window.__ironvale;
        const { scene, camera } = game.engine;
        const fx = scene.getObjectByName('fx');
        if (fx) scene.remove(fx);
        for (const child of [...camera.children]) camera.remove(child);
        game.debugPose(px, py, pz, (pyaw * Math.PI) / 180, (ppitch * Math.PI) / 180);
      },
      [x, y, z, yaw, pitch],
    );
    await page.waitForTimeout(settle);
    const file = join(out, `railyard-${name}.png`);
    await page.locator('canvas#view').screenshot({ path: file, timeout: 120000 });
    const camera = await page.evaluate(() => {
      const c = window.__ironvale.game.engine.camera;
      return { position: c.position.toArray().map((n) => Number(n.toFixed(3))), fov: c.fov, near: c.near, far: c.far };
    });
    console.log(`${file} ${backend} ${JSON.stringify(camera)}`);
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
