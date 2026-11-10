// Watches the dynamic render scale in a live page: steady when frames are on budget, and what it
// does when every frame is made slow on the CPU (lowering resolution cannot help, so it must give
// the pixels back) and when the stall ends.
// Usage: node scripts/dev/review-perf-dynres.mjs [map]
import { chromium } from 'playwright';

const map = process.argv[2] ?? 'harbor';
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
await page.evaluate(() => {
  const game = window.__ironvale.game;
  game.settings.update('graphics', { dynamicResolution: true });
  window.__scaleLog = [];
  let last = game.engine.renderScale;
  const t0 = performance.now();
  window.__stall = 0;
  game.engine.onFrame(() => {
    const until = performance.now() + window.__stall;
    while (performance.now() < until);
    if (game.engine.renderScale !== last) {
      last = game.engine.renderScale;
      window.__scaleLog.push(`${((performance.now() - t0) / 1000).toFixed(1)}s ${last.toFixed(3)}`);
    }
  });
});
const report = async (label) => {
  const { log, scale } = await page.evaluate(() => ({ log: window.__scaleLog.splice(0), scale: window.__ironvale.game.engine.renderScale }));
  process.stdout.write(`${label}: scale now ${scale.toFixed(3)}; changes: ${log.join(', ') || 'none'}\n`);
};
await page.waitForTimeout(12000);
await report('12 s on budget');
await page.evaluate(() => (window.__stall = 24));
await page.waitForTimeout(22000);
await report('22 s with a 24 ms CPU stall per frame');
await page.evaluate(() => (window.__stall = 0));
await page.waitForTimeout(12000);
await report('12 s after the stall ends');
await browser.close();
