// Frame time in the seconds after a match restart (looks for a lasting stall, not the load hitch).
// Usage: node scripts/dev/review-perf-restart.mjs [map]
import { chromium } from 'playwright';

const map = process.argv[2] ?? 'pinewood';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.routeWebSocket(/.*/, () => undefined);
page.on('pageerror', (error) => process.stdout.write(`pageerror ${error.message}\n`));
await page.goto(`http://127.0.0.1:5311/?autostart&map=${map}&bots=4&q=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
await page.waitForTimeout(3000);
const frames = (ms) =>
  page.evaluate(async (duration) => {
    const dts = [];
    let last = performance.now();
    const start = last;
    while (last - start < duration) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      dts.push(now - last);
      last = now;
    }
    dts.sort((a, b) => a - b);
    return `frames ${dts.length} median ${dts[dts.length >> 1].toFixed(1)} ms worst ${dts[dts.length - 1].toFixed(0)} ms`;
  }, ms);
process.stdout.write(`before restart: ${await frames(2000)}\n`);
const t0 = Date.now();
await page.evaluate(() => window.__ironvale.game.restart());
process.stdout.write(`restart took ${Date.now() - t0} ms\n`);
for (let i = 0; i < 3; i++) {
  process.stdout.write(`+${i * 2}-${i * 2 + 2} s: ${await frames(2000)}`);
  process.stdout.write(`  engine.frameTimeMs ${(await page.evaluate(() => window.__ironvale.game.engine.frameTimeMs)).toFixed(1)}\n`);
}
await browser.close();
