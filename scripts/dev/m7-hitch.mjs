// Measures the longest frames around switching to the M7 for the first time, aiming and firing it.
// scripts/dev/perf-hitches.mjs covers slots 1 to 4 on the default difficulty; the M7 needs Veteran.
// Usage: node scripts/dev/m7-hitch.mjs [--map railyard] [--q high] [--bots 8] [--port 5311]   (needs npm run dev)
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const map = arg('map', 'railyard');
const tier = arg('q', 'high');
const bots = Number(arg('bots', '8'));
const port = arg('port', '5311');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
await page.goto(`http://127.0.0.1:${port}/?autostart&map=${map}&bots=${bots}&q=${tier}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 120000 });
await page.evaluate(
  async ([mapId, botCount]) => {
    const game = window.__ironvale.game;
    await game.startMatch({ mapId, mode: 'skirmish', difficulty: 'veteran', botCount });
    game.weapons.debugInput = {};
    window.__frames = [];
    let last = performance.now();
    const tick = (now) => {
      window.__frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
  [map, bots],
);

const results = [];
async function step(label, input, windowMs) {
  await page.evaluate(() => {
    window.__frames.length = 0;
  });
  await page.evaluate((next) => {
    window.__ironvale.game.weapons.debugInput = next;
  }, input);
  await page.waitForTimeout(windowMs);
  const frames = await page.evaluate(() => window.__frames.slice());
  const sorted = [...frames].sort((a, b) => b - a);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  results.push({ label, worst: sorted[0] ?? 0, median });
  process.stdout.write(`${label.padEnd(24)} worst ${sorted.slice(0, 3).map((v) => v.toFixed(0).padStart(4)).join(' ')} ms   median ${median.toFixed(1)}   frames ${frames.length}\n`);
}

await page.waitForTimeout(3000);
await step('idle', {}, 1500);
await step('switch to M7 (first)', { slot: 5 }, 1800);
const held = await page.evaluate(() => window.__ironvale.game.weapons.current.def.id);
await step('aim', { aim: true }, 900);
await step('fire aimed', { aim: true, fire: true }, 500);
await step('lower', {}, 700);
await step('reload', { reload: true }, 2800);
await step('switch to M4A1', { slot: 1 }, 1500);
await step('switch to M7 (again)', { slot: 5 }, 1500);
await browser.close();

const idle = results[0].median;
const long = results.filter((result) => result.worst > Math.max(50, idle * 3));
process.stdout.write(`holding ${held} after the switch; steps with a frame over ${Math.max(50, idle * 3).toFixed(0)} ms: ${long.length ? long.map((result) => result.label).join(', ') : 'none'}\n`);
for (const line of [...new Set(problems)].slice(0, 6)) process.stdout.write(`${line.slice(0, 240)}\n`);
process.exit(held === 'm7' && problems.length === 0 ? 0 : 1);
