// Effects screenshot helper, modelled on scripts/shot.mjs.
// Usage: node scripts/dev/fx-shot.mjs --out fx-name --params "map=range&bots=0&fxdemo=gun" [--wait 3000]
//          [--burst 4 --interval 120] [--clip x,y,w,h] [--eval "js run in the page before the shots" --settle ms] [--size 1600x900]
// Writes shots/<out>.png (or <out>-0.png ... with --burst) and prints page errors.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const out = arg('out', 'fx-shot');
const params = arg('params', 'map=range&bots=0');
const wait = Number(arg('wait', '3000'));
const burst = Number(arg('burst', '1'));
const interval = Number(arg('interval', '100'));
const expression = arg('eval', '');
const settle = Number(arg('settle', '0'));
const [width, height] = arg('size', '1600x900').split('x').map(Number);
const clipArg = arg('clip', '');
const clip = clipArg ? (([x, y, w, h]) => ({ x, y, width: w, height: h }))(clipArg.split(',').map(Number)) : undefined;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    problems.push(`[${message.type()}] ${message.text()} ${message.location().url ?? ''}`);
  }
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}\n${(error.stack ?? '').split('\n').slice(0, 4).join('\n')}`));
page.on('response', (response) => {
  if (response.status() >= 400) problems.push(`[http ${response.status()}] ${response.url()}`);
});

let status = 'ok';
try {
  await page.goto(`http://127.0.0.1:5311/?autostart&${params}`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
  await page.waitForTimeout(wait);
} catch (error) {
  status = `timeout: ${error.message.split('\n')[0]}`;
}
// Other work in the repo can hot-reload the page at any moment. A marker set with the expression
// shows whether the page survived until the last shot; if not, the whole sequence is run again.
await mkdir(join(root, 'shots'), { recursive: true });
const files = [];
for (let attempt = 0; attempt < 5; attempt++) {
  files.length = 0;
  await page.waitForFunction(() => window.__ironvale?.ready && window.__ironvale.game.map, null, { timeout: 60000 }).catch(() => undefined);
  if (attempt > 0) await page.waitForTimeout(wait);
  await page.evaluate(() => { window.__fxShotMarker = true; }).catch(() => undefined);
  if (expression) {
    const value = await page.evaluate(expression).catch((error) => `eval failed: ${error.message}`);
    process.stdout.write(`eval: ${JSON.stringify(value)}\n`);
    await page.waitForTimeout(settle);
  }
  for (let i = 0; i < burst; i++) {
    const file = join(root, 'shots', burst > 1 ? `${out}-${i}.png` : `${out}.png`);
    await page.screenshot({ path: file, clip });
    files.push(file);
    if (i < burst - 1) await page.waitForTimeout(interval);
  }
  const survived = await page.evaluate(() => window.__fxShotMarker === true && Boolean(window.__ironvale?.game.map)).catch(() => false);
  if (survived) break;
  process.stdout.write('page reloaded during the capture; trying again\n');
}
for (const file of files) process.stdout.write(`${file}\n`);
const info = await page
  .evaluate(() => ({
    error: window.__ironvale?.error ?? null,
    webgpu: window.__ironvale?.game.engine.isWebGPU ?? null,
    frameMs: window.__ironvale?.game.engine.frameTimeMs ?? null,
    scale: window.__ironvale?.game.engine.renderScale ?? null,
  }))
  .catch(() => null);
process.stdout.write(`status: ${status}\ninfo: ${JSON.stringify(info)}\n`);
await browser.close();
const unique = [...new Set(problems)];
for (const line of unique.slice(0, 25)) process.stdout.write(`${line.slice(0, 600)}\n`);
