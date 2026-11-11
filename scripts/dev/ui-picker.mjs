// Screenshot of the weapon picker (hold Tab) in a running match -> shots/ui-picker.png (needs npm run dev)
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(m.text().slice(0, 200)));
page.on('pageerror', (e) => problems.push(e.message));
await page.goto('http://127.0.0.1:5311/?autostart&map=railyard&bots=3&q=medium');
await page.waitForFunction(() => window.__ironvale?.ready, null, { timeout: 90000 });
await page.waitForTimeout(1500);
// A real Tab press without pointer lock moves focus out of the page, so send the event directly.
const key = (type, code) => page.evaluate(([t, c]) => window.dispatchEvent(new KeyboardEvent(t, { code: c })), [type, code]);
await key('keydown', 'KeyE');
await page.waitForTimeout(200);
const t0 = await page.evaluate(() => window.__ironvale.game.time);
await key('keydown', 'Digit3');
await key('keyup', 'Digit3');
await page.waitForTimeout(700);
const t1 = await page.evaluate(() => window.__ironvale.game.time);
await page.screenshot({ path: 'shots/ui-picker.png' });
await key('keyup', 'KeyE');
await page.waitForTimeout(1200);
const weapon = await page.evaluate(() => window.__ironvale.game.weapons.current.def.id);
await browser.close();
process.stdout.write(`clock moved ${(t1 - t0).toFixed(3)} s while open; equipped after release: ${weapon}; ${JSON.stringify(problems.slice(0, 4))}\n`);
