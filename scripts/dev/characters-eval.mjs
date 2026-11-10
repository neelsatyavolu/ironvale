// Opens the soldier viewer with a query and prints the result of evaluating an expression in the page.
// Usage: node scripts/dev/characters-eval.mjs "<query>" "<js expression using s = first soldier>"
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
page.on('pageerror', (error) => process.stdout.write(`[pageerror] ${error.message}\n`));
await page.goto(`http://127.0.0.1:5311/?view=characters/soldier&floor=0&${process.argv[2]}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
await page.waitForTimeout(Number(process.argv[4] ?? 800));
const result = await page.evaluate(`(async () => { const s = window.__soldiers[0].visual; return JSON.stringify(await (${process.argv[3]})); })()`);
process.stdout.write(`${result}\n`);
await browser.close();
