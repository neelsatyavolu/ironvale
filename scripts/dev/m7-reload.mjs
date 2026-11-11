// Fires a few rounds from the M7 and photographs its reload in game: shots/m7-reload-game.jpg, six frames across it.
// Usage: node scripts/dev/m7-reload.mjs [--port 5311]   (needs npm run dev)
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';

const portAt = process.argv.indexOf('--port');
const port = portAt >= 0 ? process.argv[portAt + 1] : '5311';
const FRAMES = 6;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
await page.goto(`http://127.0.0.1:${port}/?autostart&map=range&bots=0&q=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
const input = (value) =>
  page.evaluate((next) => {
    window.__ironvale.game.weapons.debugInput = next;
  }, value);
await page.evaluate(async () => {
  const game = window.__ironvale.game;
  await game.startMatch({ mapId: 'range', mode: 'skirmish', difficulty: 'elite', botCount: 0 });
  game.weapons.debugInput = {};
});
await input({ slot: 5 });
await page.waitForFunction(() => window.__ironvale.game.weapons.current.def.id === 'm7', null, { timeout: 8000 });
await page.waitForTimeout(600);
await input({ fire: true });
await page.waitForTimeout(450);
await input({});
await page.waitForTimeout(300);
const reloadTime = await page.evaluate(() => window.__ironvale.game.weapons.current.def.reloadTime);
const before = await page.evaluate(() => window.__ironvale.game.weapons.current.magazine);
await input({ reload: true });
await page.waitForTimeout(60);
await input({});
const frames = [];
for (let i = 0; i < FRAMES; i++) {
  await page.waitForTimeout((reloadTime * 1000) / (FRAMES + 1));
  frames.push(await page.screenshot());
}
await page.waitForTimeout(700);
const after = await page.evaluate(() => window.__ironvale.game.weapons.current.magazine);
await browser.close();

await mkdir('shots', { recursive: true });
const sheet = await sharp({ create: { width: 960 * 3, height: 540 * 2, channels: 3, background: '#000000' } })
  .composite(frames.map((frame, index) => ({ input: frame, left: (index % 3) * 960, top: Math.floor(index / 3) * 540 })))
  .png()
  .toBuffer();
await sharp(sheet).resize({ width: 1920 }).jpeg({ quality: 86 }).toFile('shots/m7-reload-game.jpg');
process.stdout.write(`reload ${reloadTime} s: magazine ${before} before, ${after} after${problems.length ? ` | page errors: ${problems.join(' | ')}` : ''}\n`);
process.exit(after > before && problems.length === 0 ? 0 : 1);
