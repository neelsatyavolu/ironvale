// Screenshots of Pinewood from the views a player actually gets, with renderer.info numbers.
// Loads the map once, then moves the camera for each pose (feet are put on the ground).
// Usage: node scripts/dev/map-pinewood-shots.mjs [--q low|medium|high|ultra] [--only name,name] [--no ssr,godrays]
// Writes shots/map-pinewood-<name>[-<q>].png and prints draw calls, triangles and frame time per pose.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const quality = arg('q', '');
const only = arg('only', '').split(',').filter(Boolean);
const off = arg('no', '');
const port = arg('port', '5311');

// name, x, z, yaw (degrees, 0 looks north), pitch (degrees), lift above the ground,
// and optionally the height to look for ground from (to stand under a roof or on a deck).
const POSES = [
  ['spawn', 7.4, 49.6, 4, 0, 0],
  ['trail-south', 3.2, 33, 8, -2, 0],
  ['trail-long', 2.7, 39.6, 6, 1, 0],
  ['outcrops', 6.6, 44.2, 62, 0, 0],
  ['trailer', 4.5, 24.5, 20, -6, 0],
  ['yard', 0.5, 3.5, 62, -4, 0],
  ['cabin-door', 0.2, -3.6, 88, 0, 0],
  ['cabin-inside', -10.4, -5.4, 84, 0, 0, 1.6],
  ['cabin-table', -13.6, -4.2, 78, -12, 0, 1.6],
  ['cabin-breach', -17.6, -11.8, -150, 2, 0],
  ['shed', -8.2, -10.2, 14, -2, 0],
  ['shed-inside', -9.4, -14.2, 172, 0, 0, 1.6],
  ['creek-north', -26.5, -34, 178, -3, 0],
  ['creek-south', -33.5, 30, -8, -2, 0],
  ['ridge-slope', 20, 12, -70, 8, 0],
  ['ridge-top', 38, 26, 4, -3, 0],
  ['stand-stair', 38.6, 5.4, 72, 12, 0],
  ['stand-view', 30.4, 3, 84, -10, 0, 7],
  ['knoll', 8.5, -2, -52, 2, 0],
  ['north-trail', 6.5, -44, 176, 0, 0],
  ['shafts', -3.5, 15, -48, 6, 0],
  ['canopy', -12, 20, -40, 42, 0],
  ['west-bank', -42, 14, -95, -2, 0],
  ['spawn-back', 7.4, 48.6, 178, 2, 0],
  ['boundary-east', 43.5, -2, -90, 2, 0],
  ['trailer-close', 7.6, 21.6, 38, -8, 0],
  ['walls', -8, 9.5, 40, -4, 0],
];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
// "&q=" only switches render settings after the map is built. Seed the stored settings too,
// so the map is built with that tier's detail density and texture resolution.
const TIER_BUILD = {
  low: { textures: '1k', detailDensity: 0.35, anisotropy: 4 },
  medium: { textures: '1k', detailDensity: 0.6, anisotropy: 8 },
  high: { textures: '2k', detailDensity: 0.85, anisotropy: 16 },
  ultra: { textures: '2k', detailDensity: 1, anisotropy: 16 },
};
if (TIER_BUILD[quality]) {
  await page.addInitScript((graphics) => {
    localStorage.setItem('ironvale.settings.v1', JSON.stringify({ graphics }));
  }, { tier: quality, ...TIER_BUILD[quality] });
}
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

const query = `autostart&map=pinewood&bots=0${quality ? `&q=${quality}` : ''}${off ? `&no=${off}` : ''}`;
await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load', timeout: 30000 });

// Other agents edit files while this runs and the dev server reloads the page,
// so every pose waits for the map and is retaken if a reload lands in the middle.
const ready = async () => {
  await page.waitForFunction(() => window.__ironvale?.error || (window.__ironvale?.ready && window.__ironvale.game.map), null, { timeout: 120000 });
  const error = await page.evaluate(() => window.__ironvale?.error ?? null);
  if (error) throw new Error(`load error: ${error}`);
  await page.evaluate(() => {
    window.__pinewoodShot = true;
  });
};

async function shoot([name, x, z, yaw, pitch, lift, from = 40]) {
  await ready();
  const ground = await page.evaluate(
    ([px, pz, py, pyaw, ppitch, fromY]) => {
      const game = window.__ironvale.game;
      const height = game.world.groundHeight(px, pz, fromY, 80) ?? 0;
      game.debugPose(px, height + py + 0.02, pz, (pyaw * Math.PI) / 180, (ppitch * Math.PI) / 180);
      return height;
    },
    [x, z, lift, yaw, pitch, from],
  );
  await page.waitForTimeout(1500);
  const info = await page.evaluate(async () => {
    const { engine } = window.__ironvale.game;
    const stats = engine.renderer.info;
    const frames = 8;
    stats.autoReset = false;
    stats.reset();
    for (let i = 0; i < frames; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    const result = {
      drawCalls: Math.round(stats.render.drawCalls / frames),
      triangles: Math.round(stats.render.triangles / frames),
      frameMs: Number(engine.frameTimeMs.toFixed(1)),
      scale: engine.renderScale,
      geometries: stats.memory.geometries,
      textures: stats.memory.textures,
    };
    stats.autoReset = true;
    return result;
  });
  const file = join(root, 'shots', `map-pinewood-${name}${quality ? `-${quality}` : ''}.png`);
  await page.screenshot({ path: file });
  if (!(await page.evaluate(() => window.__pinewoodShot === true))) throw new Error('page reloaded');
  process.stdout.write(`${name}: ground ${ground.toFixed(2)} ${JSON.stringify(info)}\n`);
}

await mkdir(join(root, 'shots'), { recursive: true });
for (const pose of POSES) {
  if (only.length > 0 && !only.includes(pose[0])) continue;
  for (let attempt = 1; ; attempt++) {
    try {
      await shoot(pose);
      break;
    } catch (error) {
      if (attempt >= 5 || String(error.message).startsWith('load error')) {
        process.stdout.write(`${pose[0]}: failed, ${error.message.split('\n')[0]}\n`);
        break;
      }
      await page.waitForTimeout(1500);
    }
  }
}
await browser.close();
const unique = [...new Set(problems)];
for (const line of unique.slice(0, 25)) process.stdout.write(`${line.slice(0, 400)}\n`);
if (unique.length > 25) process.stdout.write(`... ${unique.length - 25} more\n`);
