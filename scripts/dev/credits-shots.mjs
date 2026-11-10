// Opens the Credits screen from the main menu in headless Chrome, drives it with the keyboard and
// writes shots/credits-*.png. Needs the dev server (npm run dev).
//   node scripts/dev/credits-shots.mjs [--size 1600x900] [--tag name]
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const [width, height] = arg('size', '1600x900').split('x').map(Number);
const tag = arg('tag', '') ? `-${arg('tag', '')}` : '';
const out = (name) => join(root, 'shots', `credits-${name}${tag}.png`);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
await mkdir(join(root, 'shots'), { recursive: true });
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
// Other sessions edit files while this runs; without a socket Vite cannot reload the page mid-capture.
await context.addInitScript(() => {
  window.WebSocket = class {
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  };
});
const page = await context.newPage();
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()} ${message.location().url}`);
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

await page.goto('http://127.0.0.1:5311/', { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(600);
await page.screenshot({ path: out('menu') });

const report = {};
// Keyboard only from here: Play has focus, Credits is the last button in its row.
for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
report.focusBeforeEnter = await page.evaluate(() => document.activeElement?.textContent);
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
report.focusOnOpen = await page.evaluate(() => document.activeElement?.textContent);
await page.screenshot({ path: out('top') });

await page.keyboard.press('ArrowUp');
report.focusAfterUp = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
await page.screenshot({ path: out('focus') });
for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
await page.waitForTimeout(200);
report.scrollAfterSixDown = await page.evaluate(() => document.querySelector('.iv-credits').scrollTop);
await page.screenshot({ path: out('middle') });
for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowDown');
await page.waitForTimeout(200);
report.focusAtEnd = await page.evaluate(() => document.activeElement?.textContent);
await page.screenshot({ path: out('end') });

report.sections = await page.evaluate(() =>
  [...document.querySelectorAll('.iv-credits .iv-rule')].map((rule) => rule.textContent),
);
report.creditLines = await page.evaluate(() => document.querySelectorAll('.iv-credits__line').length);
report.links = await page.evaluate(() => document.querySelectorAll('.iv-credits a[href^="https://"]').length);
report.overflowX = await page.evaluate(() => {
  const body = document.querySelector('.iv-credits');
  return body.scrollWidth - body.clientWidth;
});
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
report.afterEscape = await page.evaluate(() => ({
  creditsHidden: document.querySelector('.iv-credits').closest('.iv-screen').hidden,
  menuHidden: document.querySelector('.iv-menu').hidden,
}));

process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
process.stdout.write(problems.length ? `${problems.join('\n')}\n` : 'no console problems\n');
await browser.close();
