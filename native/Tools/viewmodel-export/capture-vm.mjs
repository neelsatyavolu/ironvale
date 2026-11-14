#!/usr/bin/env node
// View-model parity captures (M9 view-model lane, check-m9vm.sh). For every weapon, at the hip and aimed:
//   web     the real web build in Chrome (WebGPU): ?autostart&map=railyard&bots=0&pose=<spawn>&q=high&no=grain&freeze,
//           every weapon issued, the weapon equipped and the sights held through PlayerWeapons.debugInput,
//           FX root and DOM HUD hidden (as capture-web.mjs), the first-person rig kept; 2560x1600
//   native  Ironvale --map railyard --pose <spawn> --capture ... --q high --no grain --freeze --vm-weapon ID --vm-aim 0|1
// and scores each pair with SSIM (../m3-parity/ssim.mjs): the whole frame (the gate) and, for information,
// the lower-right quarter where the gun and arms sit.
//
// Usage: node native/Tools/viewmodel-export/capture-vm.mjs --app PATH/Ironvale.app [--out DIR] [--skip-web] [--settle MS]
// Writes <out>/web/<id>-<hip|ads>.png, <out>/native/<id>-<hip|ads>.png and <out>/ssim.json.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { ssim } from '../m3-parity/ssim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const app = option('app');
if (!app) throw new Error('--app PATH is required');
const out = resolve(option('out', join(repo, 'native/Parity/m9vm')));
const settle = Number(option('settle', '3500'));
const skipWeb = args.includes('--skip-web');
const constants = JSON.parse(readFileSync(join(repo, 'native/Contract/viewmodel.json'), 'utf8'));
const weapons = option('weapons') ? option('weapons').split(',') : Object.keys(constants.weapons);
const pose = JSON.parse(readFileSync(join(repo, 'native/Parity/railyard-poses.json'), 'utf8')).poses.spawn;
const views = [
  { name: 'hip', aim: 0 },
  { name: 'ads', aim: 1 },
];
const webDir = join(out, 'web');
const nativeDir = join(out, 'native');
mkdirSync(webDir, { recursive: true });
mkdirSync(nativeDir, { recursive: true });

async function captureWeb() {
  const flags = ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'];
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: flags }).catch(() => chromium.launch({ headless: true, args: flags }));
  const server = await createServer({
    configFile: join(repo, 'vite.config.ts'),
    root: repo,
    logLevel: 'warn',
    server: { host: '127.0.0.1', port: 5393, strictPort: false, hmr: false, watch: null },
  });
  await server.listen();
  try {
    for (const id of weapons) {
      for (const view of views) {
        // A fresh page per capture: nothing carries over from the previous weapon or aim.
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
        page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
        await page.goto(`${server.resolvedUrls.local[0]}?autostart&map=railyard&bots=0&pose=${pose.join(',')}&q=high&no=grain&freeze`, {
          waitUntil: 'load',
          timeout: 60000,
        });
        await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 300000 });
        const error = await page.evaluate(() => window.__ironvale?.error ?? null);
        if (error) throw new Error(`web build failed to start: ${error}`);
        await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas#view { visibility: visible !important; }' });
        await page.evaluate(([ids, weaponId, aim]) => {
          const { game } = window.__ironvale;
          const fx = game.engine.scene.getObjectByName('fx');
          if (fx) game.engine.scene.remove(fx);
          game.weapons.issue(ids);
          const slot = game.weapons.loadout.find((machine) => machine.def.id === weaponId).def.slot;
          game.weapons.debugInput = { slot, aim };
        }, [weapons, id, view.aim === 1]);
        // The slot press is a one-frame intent; keep only the aim held after it.
        await page.waitForTimeout(100);
        await page.evaluate((aim) => {
          window.__ironvale.game.weapons.debugInput = { aim };
        }, view.aim === 1);
        await page.waitForTimeout(settle);
        const current = await page.evaluate(() => {
          const { game } = window.__ironvale;
          const w = game.weapons;
          const c = game.engine.camera;
          const rig = c.children.find((child) => child.name === 'view_model');
          return {
            id: w.current.def.id, aim: w.aimBlend, fov: c.fov, projection: Number(c.projectionMatrix.elements[5].toFixed(4)),
            rigVisible: rig?.visible ?? null, scopedIn: w.scopedIn, camera: c.position.toArray().map((n) => Number(n.toFixed(3))),
          };
        });
        if (current.id !== id) throw new Error(`web: expected ${id} in the hands, got ${current.id}`);
        const file = join(webDir, `${id}-${view.name}.png`);
        // Under ?freeze two shots a second apart are the same picture; a stale or half-presented
        // canvas (seen under GPU contention) is not, so shoot until two in a row agree.
        let stable = false;
        for (let attempt = 0; attempt < 5 && !stable; attempt++) {
          await page.locator('canvas#view').screenshot({ path: `${file}.a.png`, timeout: 120000 });
          await page.waitForTimeout(1000);
          await page.locator('canvas#view').screenshot({ path: file, timeout: 120000 });
          stable = (await ssim(`${file}.a.png`, file)) > 0.995;
        }
        if (!stable) throw new Error(`web: ${id} ${view.name} never settled to a stable frame`);
        console.log(`web ${file} ${JSON.stringify(current)}`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

/** SSIM of the lower-right quarter (the gun and arms), from cropped copies. */
async function cropScore(a, b) {
  const meta = await sharp(a).metadata();
  const region = { left: Math.floor(meta.width / 2), top: Math.floor(meta.height / 2), width: Math.floor(meta.width / 2), height: Math.floor(meta.height / 2) };
  const ca = `${a}.crop.png`;
  const cb = `${b}.crop.png`;
  await sharp(a).extract(region).toFile(ca);
  await sharp(b).extract(region).toFile(cb);
  return ssim(ca, cb);
}

if (!skipWeb) await captureWeb();
const binary = join(app, 'Contents/MacOS/Ironvale');
const results = {};
for (const id of weapons) {
  for (const view of views) {
    const name = `${id}-${view.name}`;
    const file = join(nativeDir, `${name}.png`);
    execFileSync(binary, ['--map', 'railyard', '--pose', pose.join(','), '--capture', file, '--repo', repo, '--q', 'high', '--no', 'grain',
      '--freeze', '--vm-weapon', id, '--vm-aim', String(view.aim), '-ApplePersistenceIgnoreState', 'YES'], { stdio: 'inherit' });
    const reference = join(webDir, `${name}.png`);
    if (!existsSync(reference)) throw new Error(`missing web capture ${reference}`);
    results[name] = { frame: await ssim(reference, file), gunQuarter: await cropScore(reference, file) };
    console.log(`${name.padEnd(12)} frame ${results[name].frame.toFixed(4)}  gun quarter ${results[name].gunQuarter.toFixed(4)}`);
  }
}
const frames = Object.values(results).map((r) => r.frame);
const quarters = Object.values(results).map((r) => r.gunQuarter);
const summary = {
  poses: results,
  min: Math.min(...frames),
  mean: frames.reduce((s, v) => s + v, 0) / frames.length,
  gunQuarterMin: Math.min(...quarters),
  gunQuarterMean: quarters.reduce((s, v) => s + v, 0) / quarters.length,
};
console.log(`frame SSIM min ${summary.min.toFixed(4)} mean ${summary.mean.toFixed(4)}; gun quarter min ${summary.gunQuarterMin.toFixed(4)} mean ${summary.gunQuarterMean.toFixed(4)}`);
writeFileSync(join(out, 'ssim.json'), `${JSON.stringify(summary, null, 2)}\n`);
