// In-game check for the guns-b models: starts a match on a map, equips a slot, optionally aims
// or reloads, and writes shots/<out>.png. Prints page errors and warnings.
// Usage: node scripts/dev/guns-b-ingame.mjs --out name --slot 2 [--aim] [--fire] [--reload ms] [--map range]
//        [--pose x,y,z,yaw,pitch] [--extra "q=high"] [--settle ms after the weapon switch]
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const out = arg('out', 'guns-b-ingame');
const slot = Number(arg('slot', '2'));
const pose = arg('pose', '');
const extra = arg('extra', '');
const query = `autostart&map=${arg('map', 'range')}&bots=${arg("bots", "1")}&ui=off${pose ? `&pose=${pose}` : ''}${extra ? `&${extra}` : ''}`;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
await page.goto(`http://127.0.0.1:5311/?${query}`, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
await page.waitForTimeout(1200);
// Other agents' edits can hot-reload the page mid-wait; make sure the game is back before driving it.
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
// Scripted weapon input: see DebugInput in src/weapons/intent.ts.
const drive = (input) => page.evaluate((value) => { window.__ironvale.game.weapons.debugInput = value; }, input);
await drive({ slot });
await page.waitForTimeout(Number(arg('settle', '1500')));
if (flag('fire')) {
  await drive({ fire: true });
  await page.waitForTimeout(Number(arg('firewait', '60')));
}
if (flag('aim')) {
  await drive({ aim: true });
  await page.waitForTimeout(Number(arg('aimwait', '900')));
}
if (arg('reload', '')) {
  await drive({ reload: true, aim: false });
  await page.waitForTimeout(Number(arg('reload', '0')));
}
const info = { error: await page.evaluate(() => window.__ironvale.error) };
const state = await page.evaluate(() => {
  const weapons = window.__ironvale.game.weapons;
  return { phase: window.__ironvale.game.phase, alive: window.__ironvale.game.player.alive, weapon: weapons.current.def.id, aimBlend: weapons.aimBlend, reloading: weapons.current.reloading, magazine: weapons.current.magazine };
});
await mkdir(join(root, 'shots'), { recursive: true });
const file = join(root, 'shots', `${out}.png`);
await page.screenshot({ path: file });
await browser.close();
process.stdout.write(`${file}\n${JSON.stringify({ ...info, ...state })}\n`);
for (const line of [...new Set(problems)].slice(0, 20)) process.stdout.write(`${line.slice(0, 300)}\n`);
