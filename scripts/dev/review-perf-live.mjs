// Changes every graphics setting live through the settings store, several rounds, and reports
// page errors and whether GPU memory or texture counts grow (a leak in the pipeline rebuild).
// Then restarts the match with light shafts on (the GodraysNode null shadow-map case).
// Usage: node scripts/dev/review-perf-live.mjs [map] [--webgl] [--rounds 3]
import { chromium } from 'playwright';

const map = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'harbor';
const webgl = process.argv.includes('--webgl');
const roundsAt = process.argv.indexOf('--rounds');
const rounds = roundsAt >= 0 ? Number(process.argv[roundsAt + 1]) : 3;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.routeWebSocket(/.*/, () => undefined);
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text().replace(/\s+/g, ' ').slice(0, 260)}`);
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message.slice(0, 260)}`));
await page.goto(`http://127.0.0.1:5311/?autostart&map=${map}&bots=4&q=high${webgl ? '&webgl' : ''}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
await page.waitForTimeout(1500);

const memory = () =>
  page.evaluate(() => {
    const m = window.__ironvale.game.engine.renderer.info.memory;
    return { totalMB: +(m.total / 1048576).toFixed(1), textures: m.textures, renderTargets: m.renderTargets, geometries: m.geometries };
  });
const flush = (label) => {
  const unique = [...new Set(problems.splice(0))];
  process.stdout.write(`${label}: ${unique.length ? `${unique.length} problem(s)` : 'no errors'}\n`);
  for (const line of unique.slice(0, 6)) process.stdout.write(`    ${line}\n`);
};

const STEPS = [
  { reflections: false },
  { ambientOcclusion: false },
  { volumetricLight: false },
  { bloom: false },
  { antiAliasing: 'fxaa' },
  { antiAliasing: 'none' },
  { filmGrain: false },
  { shadowMapSize: 0 },
  { shadowMapSize: 1024 },
  { shadowMapSize: 2048 },
  { shadowMapSize: 4096 },
  { renderScale: 0.6 },
  { dynamicResolution: true },
  { targetFps: 30 },
  { anisotropy: 4 },
  { detailDensity: 0.4 },
  { particleDensity: 0.5 },
  { textures: '1k' },
  { tier: 'low' },
  { tier: 'medium' },
  { tier: 'ultra' },
  { tier: 'high' },
];
process.stdout.write(`start ${JSON.stringify(await memory())}\n`);
for (let round = 1; round <= rounds; round++) {
  for (const step of STEPS) {
    await page.evaluate(async (patch) => {
      const game = window.__ironvale.game;
      // A tier step applies the whole preset, as the settings screen does.
      const presets = { low: 1, medium: 1, high: 1, ultra: 1 };
      if (patch.tier in presets) {
        const { graphicsForTier } = await import('/src/core/settings.ts');
        game.settings.update('graphics', { ...graphicsForTier(patch.tier), dynamicResolution: false });
      } else {
        game.settings.update('graphics', patch);
      }
      for (let i = 0; i < 6; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    }, step);
    if (problems.length) flush(`  round ${round} ${JSON.stringify(step)}`);
  }
  process.stdout.write(`after round ${round} ${JSON.stringify(await memory())}\n`);
}
flush('live settings');

for (let i = 1; i <= 2; i++) {
  await page.evaluate(() => window.__ironvale.game.restart());
  await page.waitForTimeout(1500);
  flush(`restart ${i} (light shafts on)`);
  process.stdout.write(`after restart ${i} ${JSON.stringify(await memory())}\n`);
}
// Shadows off and on again, then a restart: the sun shadow map is recreated on the way.
await page.evaluate(async () => {
  const game = window.__ironvale.game;
  game.settings.update('graphics', { shadowMapSize: 0 });
  for (let i = 0; i < 4; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  game.settings.update('graphics', { shadowMapSize: 2048 });
  await game.restart();
});
await page.waitForTimeout(1500);
flush('shadows off/on then restart');
const final = await page.evaluate(() => ({ phase: window.__ironvale.game.phase, frameMs: window.__ironvale.game.engine.frameTimeMs }));
process.stdout.write(`final ${JSON.stringify(final)}\n`);
await browser.close();
