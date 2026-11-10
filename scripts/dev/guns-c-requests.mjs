// Lists failed requests and console problems for a viewer page. Usage: node scripts/dev/guns-c-requests.mjs "<params>"
import { chromium } from 'playwright';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('response', (response) => {
  if (response.status() >= 400) process.stdout.write(`${response.status()} ${response.url()}\n`);
});
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') process.stdout.write(`[${message.type()}] ${message.text().slice(0, 300)}\n`);
});
page.on('pageerror', (error) => process.stdout.write(`[pageerror] ${error.message}\n`));
await page.goto(`http://127.0.0.1:5311/?${process.argv[2]}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
await page.waitForTimeout(1500);
const stats = await page.evaluate(() => {
  const info = window.__ironvale.game.engine.renderer?.info;
  return { error: window.__ironvale.error ?? null, calls: info?.render?.drawCalls ?? info?.render?.calls ?? null, triangles: info?.render?.triangles ?? null };
});
process.stdout.write(`${JSON.stringify(stats)}\n`);
await browser.close();
