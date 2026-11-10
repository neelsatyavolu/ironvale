// Contact sheets of the soldier viewer: several states and camera angles in one browser session.
// Usage: node scripts/dev/characters-shots.mjs <sheet-name> "<query>;<query>;..." [--cols 3] [--size 640x720] [--wait 1200]
// Each query is appended to view=characters/soldier&floor=0. Writes shots/characters-<sheet-name>.png.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const sheet = process.argv[2];
const queries = process.argv[3].split(';').map((q) => q.trim()).filter(Boolean);
const cols = Number(arg('cols', '3'));
const [width, height] = arg('size', '640x720').split('x').map(Number);
const wait = Number(arg('wait', '1200'));
const base = arg('base', 'view=characters/soldier&floor=0');
// --measure prints head, hands and muzzle positions of the first soldier for each tile.
const measure = process.argv.includes('--measure');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const problems = new Set();
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.add(`[${message.type()}] ${message.text()} ${message.location()?.url ?? ''}`);
});
page.on('pageerror', (error) => problems.add(`[pageerror] ${error.message}`));
page.on('response', (response) => {
  if (response.status() >= 400) problems.add(`[http ${response.status()}] ${response.url()}`);
});

const tiles = [];
for (const query of queries) {
  await page.goto(`http://127.0.0.1:5311/?${base}&${query}`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
  await page.waitForTimeout(wait);
  let shot = await page.screenshot();
  // The first frames after a load can still be compiling shaders; retry while the frame is blank.
  for (let attempt = 0; attempt < 4; attempt++) {
    const stats = await sharp(shot).stats();
    if (stats.channels[0].max > 60) break;
    await page.waitForTimeout(800);
    shot = await page.screenshot();
  }
  tiles.push(shot);
  if (measure) {
    const data = await page.evaluate(() => {
      const soldier = window.__soldiers?.[0]?.visual;
      if (!soldier) return null;
      soldier.root.updateWorldMatrix(true, true);
      const at = (name) => soldier.root.getObjectByName(name).matrixWorld.elements.slice(12, 15).map((v) => +v.toFixed(3));
      const muzzle = soldier.muzzleWorld(soldier.root.position.clone());
      return { head: at('Head'), hips: at('Hips'), leftHand: at('LeftHand'), rightHand: at('RightHand'), leftFoot: at('LeftFoot'), rightFoot: at('RightFoot'), muzzle: muzzle.toArray().map((v) => +v.toFixed(3)) };
    });
    process.stdout.write(`${query}\n  ${JSON.stringify(data)}\n`);
  }
}
const info = await page.evaluate(() => ({ frameMs: window.__ironvale?.game?.engine?.frameTimeMs ?? null })).catch(() => null);
await browser.close();

const rows = Math.ceil(tiles.length / cols);
await mkdir(join(root, 'shots'), { recursive: true });
const file = join(root, 'shots', `characters-${sheet}.png`);
await sharp({ create: { width: cols * width, height: rows * height, channels: 3, background: '#000' } })
  .composite(tiles.map((input, index) => ({ input, left: (index % cols) * width, top: Math.floor(index / cols) * height })))
  .png()
  .toFile(file);
process.stdout.write(`${file}\n${JSON.stringify(info)}\n`);
for (const line of [...problems].slice(0, 20)) process.stdout.write(`${line.slice(0, 300)}\n`);
