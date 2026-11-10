// Screenshots after switching sun shadows off, and back on, live (checks the change really takes effect).
// Usage: node scripts/dev/review-perf-shadowtoggle.mjs [map] [pose]
import { chromium } from 'playwright';

const map = process.argv[2] ?? 'harbor';
const pose = process.argv[3] ?? '-48.5,0.02,33.1,315,0';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.routeWebSocket(/.*/, () => undefined);
page.on('pageerror', (error) => process.stdout.write(`pageerror ${error.message}\n`));
page.on('console', (message) => {
  if (message.type() === 'error') process.stdout.write(`error ${message.text().slice(0, 200)}\n`);
});
await page.goto(`http://127.0.0.1:5311/?autostart&map=${map}&bots=0&q=high&pose=${pose}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
await page.waitForTimeout(2500);
const steps = [
  ['on', null],
  ['off', 0],
  ['on-again', 2048],
];
for (const [name, size] of steps) {
  if (size !== null) await page.evaluate((shadowMapSize) => window.__ironvale.game.settings.update('graphics', { shadowMapSize }), size);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `shots/review-perf-shadows-${name}.png` });
  process.stdout.write(`shots/review-perf-shadows-${name}.png\n`);
}
await browser.close();
