// Pictures of a grenade blast from close by, for judging the effect.
// Usage: node scripts/dev/grenade-shot.mjs [--distance 8] [--q high] [--map range] [--pose x,y,z,yawDeg,pitchDeg]
// Writes shots/grenade-fx-<ms>.png at several moments after the blast.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const distance = Number(arg('distance', '8'));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.routeWebSocket(/.*/, () => undefined);
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${arg('port', '5311')}/?autostart&map=${arg('map', 'range')}&bots=0&q=${arg('q', 'high')}&pose=${arg('pose', '8,0.05,20,0,-8')}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
await page.waitForTimeout(1500);
await mkdir(join(root, 'shots'), { recursive: true });
await page.evaluate((ahead) => {
  const game = window.__ironvale.game;
  game.debugControl = true;
  game.weapons.debugInput = {};
  window.__boom = false;
  game.events.on('grenadeExploded', () => (window.__boom = performance.now()));
  const eye = game.engine.camera.position;
  const forward = game.player.position.clone();
  game.engine.camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();
  const origin = eye.clone().addScaledVector(forward, ahead).setY(game.player.position.y + 0.06);
  game.grenades.launch(game.player, origin, forward.clone().multiplyScalar(0), true);
}, distance);
await page.waitForFunction(() => window.__boom, null, { timeout: 8000, polling: 'raf' });
for (const ms of [50, 150, 400, 1200, 5000]) {
  await page.waitForFunction((t) => performance.now() - window.__boom >= t, ms, { polling: 'raf' });
  await page.screenshot({ path: join(root, 'shots', `grenade-fx-${ms}.png`) });
}
await browser.close();
process.stdout.write(`wrote shots/grenade-fx-{50,150,400,1200,5000}.png, ${problems.length} page problems\n`);
for (const line of [...new Set(problems)].slice(0, 15)) process.stdout.write(`${line.slice(0, 300)}\n`);
