// Measures frame hitches around first-time events (weapon switches, aiming, firing, a bot
// appearing) in headless Chrome on the real GPU.
//   node scripts/dev/perf-hitches.mjs [--map railyard] [--q high] [--port 5311]
// Prints the longest and the 3 longest frames in the window after each step.
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const map = arg('map', 'railyard');
const tier = arg('q', 'high');
const port = arg('port', '5311');
const bots = arg('bots', '0');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.routeWebSocket(/.*/, () => undefined);
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

// Record every GPU pipeline the page creates, so a hitch can be traced to what compiled.
await page.addInitScript(() => {
  window.__pipes = [];
  const wrap = (name) => {
    const proto = globalThis.GPUDevice?.prototype;
    if (!proto?.[name]) return;
    const original = proto[name];
    proto[name] = function (descriptor) {
      const start = performance.now();
      const result = original.call(this, descriptor);
      window.__pipes.push({ at: start, ms: performance.now() - start, kind: name, label: descriptor?.label ?? '' });
      return result;
    };
  };
  for (const name of ['createRenderPipeline', 'createComputePipeline', 'createShaderModule', 'createTexture']) wrap(name);
});
await page.goto(`http://127.0.0.1:${port}/?autostart&map=${map}&bots=${bots}&q=${tier}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });

await page.evaluate(() => {
  const game = window.__ironvale.game;
  game.weapons.debugInput = {};
  if (game.bots?.count === 0 || location.search.includes('bots=0')) {
    if (game.config) game.config = { ...game.config, botCount: Number.MAX_SAFE_INTEGER };
    if (game.phase === 'won') game.phase = 'playing';
  }
  window.__frames = [];
  let last = performance.now();
  const tick = (now) => {
    window.__frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function step(label, action, windowMs = 1400) {
  const from = await page.evaluate(() => ((window.__frames.length = 0), performance.now()));
  await page.evaluate(action);
  await wait(windowMs);
  const frames = await page.evaluate(() => window.__frames.slice());
  // Anything compiled inside the window is what a hitch there would be made of.
  const compiled = await page.evaluate((t) => window.__pipes.filter((p) => p.at > t && p.kind !== 'createTexture').length, from);
  const sorted = [...frames].sort((a, b) => b - a);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  process.stdout.write(
    `${label.padEnd(26)} worst ${sorted.slice(0, 3).map((v) => v.toFixed(0).padStart(4)).join(' ')} ms   median ${median.toFixed(1)}   frames ${frames.length}   compiled ${compiled}\n`,
  );
}
const input = (body) => new Function(`const i = window.__ironvale.game.weapons.debugInput; ${body}`);

if (process.argv.includes('--soak')) {
  // Stand in a live match and list every long frame with the time it happened.
  const seconds = Number(arg('seconds', '45'));
  const soakStart = await page.evaluate(() => performance.now());
  await page.evaluate(() => {
    window.__long = [];
    const start = performance.now();
    let last = start;
    window.__recent = [];
    const game = window.__ironvale.game;
    for (const name of ['shotFired', 'bulletImpact', 'combatantHit', 'nearMiss', 'casingLanded', 'playerHurt', 'died', 'spawned', 'botCallout', 'matchState', 'footstep']) {
      game.events.on(name, (e) => {
        const tag = `${name}:${e?.shooterId ?? e?.id ?? e?.surface ?? e?.kind ?? ''}`;
        if (!window.__recent.includes(tag)) window.__recent.push(tag);
      });
    }
    const tick = (now) => {
      if (now - last > 34) window.__long.push([((now - start) / 1000).toFixed(1), `${Math.round(now - last)} after ${window.__recent.join(' ')}`]);
      window.__recent.length = 0;
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const i = window.__ironvale.game.weapons.debugInput;
    setInterval(() => (i.fire = !i.fire), 700);
  });
  await wait(seconds * 1000);
  const long = await page.evaluate(() => window.__long);
  const late = await page.evaluate((from) => {
    const rows = window.__pipes.filter((p) => p.at > from && p.kind !== 'createTexture');
    const byLabel = new Map();
    for (const row of rows) {
      const key = `${row.kind} ${row.label}`;
      const entry = byLabel.get(key) ?? { count: 0, ms: 0 };
      byLabel.set(key, { count: entry.count + 1, ms: entry.ms + row.ms });
    }
    return { total: rows.length, ms: rows.reduce((sum, r) => sum + r.ms, 0), top: [...byLabel].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25) };
  }, soakStart);
  process.stdout.write(`pipelines and shader modules created during play: ${late.total}, ${late.ms.toFixed(0)} ms\n`);
  for (const [key, v] of late.top) process.stdout.write(`  ${v.ms.toFixed(0).padStart(6)} ms x${v.count}  ${key.slice(0, 110)}\n`);
  process.stdout.write(`long frames in ${seconds} s: ${long.length}\n${long.map(([t, ms]) => `  t=${t}s ${ms} ms`).join('\n')}\n`);
  await browser.close();
  for (const line of [...new Set(problems)].slice(0, 15)) process.stdout.write(`${line.slice(0, 300)}\n`);
  process.exit(0);
}

await wait(2500);
await step('idle', () => undefined);
await step('fire m4a1 (first)', input('i.fire = true'), 600);
await step('stop fire', input('i.fire = false'), 400);
await step('reload m4a1', input('i.reload = true'), 2600);
for (const slot of [2, 3, 4, 1, 2, 3, 4, 1]) {
  await step(`switch to slot ${slot}`, input(`i.slot = ${slot}`));
  if (slot === 3) {
    await step('  aim scope', input('i.aim = true'), 900);
    await step('  fire scoped', input('i.fire = true'), 500);
    await step('  unscope', input('i.fire = false; i.aim = false'), 900);
  } else {
    await step('  fire', input('i.fire = true'), 400);
    await step('  stop', input('i.fire = false'), 300);
  }
}
// The grenade: the arc and marker appear for the first time, then the body, then the blast 2.5 s after release.
await step('grenade aim (first)', input('i.grenade = true'), 900);
await step('grenade throw', input('i.grenade = false'), 2300);
await step('grenade blast (first)', () => undefined, 1800);
await browser.close();
for (const line of [...new Set(problems)].slice(0, 15)) process.stdout.write(`${line.slice(0, 300)}\n`);
