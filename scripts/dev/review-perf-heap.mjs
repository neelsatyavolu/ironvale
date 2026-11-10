// Samples heap allocations over a stretch of play (8 bots, player firing) and lists the functions
// that allocate the most, so per-frame garbage in the frame loop shows up by name.
// Usage: node scripts/dev/review-perf-heap.mjs [map] [seconds]
import { chromium } from 'playwright';

const map = process.argv[2] ?? 'harbor';
const seconds = Number(process.argv[3] ?? 30);
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.routeWebSocket(/.*/, () => undefined);
await page.goto(`http://127.0.0.1:5311/?autostart&map=${map}&bots=8&q=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
await page.evaluate(() => {
  const game = window.__ironvale.game;
  game.weapons.debugInput = { fire: true };
  setInterval(() => {
    game.player.health = 100;
    game.weapons.resupply();
  }, 250);
});
await page.waitForTimeout(4000);

const client = await page.context().newCDPSession(page);
await client.send('HeapProfiler.enable');
const frames0 = await page.evaluate(() => window.__ironvale.game.engine.renderer.info.frame);
// Include objects already collected: short-lived per-frame garbage is exactly what is being looked for.
await client.send('HeapProfiler.startSampling', {
  samplingInterval: 4096,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
await page.waitForTimeout(seconds * 1000);
const { profile } = await client.send('HeapProfiler.stopSampling');
const frames = (await page.evaluate(() => window.__ironvale.game.engine.renderer.info.frame)) - frames0;
await browser.close();

const totals = new Map();
let all = 0;
const walk = (node) => {
  const { functionName, url, lineNumber } = node.callFrame;
  const file = url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');
  const key = `${functionName || '(anonymous)'}  ${file}:${lineNumber + 1}`;
  totals.set(key, (totals.get(key) ?? 0) + node.selfSize);
  all += node.selfSize;
  for (const child of node.children) walk(child);
};
walk(profile.head);
const perFrame = (bytes) => (bytes / Math.max(1, frames)).toFixed(0).padStart(7);
process.stdout.write(`${map}: ${seconds} s, ${frames} frames, ${(all / 1048576).toFixed(1)} MB allocated, ${perFrame(all)} bytes per frame\n`);
const sorted = [...totals].sort((a, b) => b[1] - a[1]);
for (const [key, bytes] of sorted.slice(0, 30)) process.stdout.write(`${perFrame(bytes)} B/frame  ${key}\n`);
const own = sorted.filter(([key]) => /src\/(render|fx|core)\//.test(key));
process.stdout.write(`-- in src/render, src/fx, src/core --\n`);
for (const [key, bytes] of own.slice(0, 20)) process.stdout.write(`${perFrame(bytes)} B/frame  ${key}\n`);
