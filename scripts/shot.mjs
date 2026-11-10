// Takes a screenshot of the running dev server (npm run dev) with real GPU rendering.
// Usage: npm run shot -- --out name [--params "map=range&pose=0,0,6,0,0"] [--wait 2500] [--size 1600x900] [--webgl]
// Writes shots/<name>.png and prints console errors from the page.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const out = arg('out', 'shot');
const params = arg('params', 'map=range');
const wait = Number(arg('wait', '2500'));
const [width, height] = arg('size', '1600x900').split('x').map(Number);
const port = arg('port', '5311');
const webgl = process.argv.includes('--webgl');

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

const url = `http://127.0.0.1:${port}/?${params.includes("view=") ? "" : "autostart&"}${params}${webgl ? "&webgl" : ""}`;
let status = 'ok';
try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
  await page.waitForTimeout(wait);
} catch (error) {
  status = `timeout: ${error.message.split('\n')[0]}`;
}
const info = await page
  .evaluate(() => ({
    error: window.__ironvale?.error ?? null,
    webgpu: window.__ironvale?.game.engine.isWebGPU ?? null,
    frameMs: window.__ironvale?.game.engine.frameTimeMs ?? null,
    scale: window.__ironvale?.game.engine.renderScale ?? null,
  }))
  .catch(() => null);
await mkdir(join(root, 'shots'), { recursive: true });
const file = join(root, 'shots', `${out}.png`);
await page.screenshot({ path: file });
await browser.close();

process.stdout.write(`${file}\nstatus: ${status}\ninfo: ${JSON.stringify(info)}\n`);
const unique = [...new Set(problems)];
for (const line of unique.slice(0, 8)) process.stdout.write(`${line.replace(/\s+/g, ' ').slice(0, 240)}\n`);
if (unique.length > 8) process.stdout.write(`... ${unique.length - 8} more\n`);
