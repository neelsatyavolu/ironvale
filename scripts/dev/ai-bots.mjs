// Watches the bots in the running dev server and reports what they did.
// Usage: node scripts/dev/ai-bots.mjs --out ai-range [--params "map=range&bots=6&botdebug"]
//          [--immortal] [--perf] [--seconds 30] [--every 10] [--top "0,0,70"] [--pose "x,y,z,yawDeg,pitchDeg"] [--difficulty elite]
// Every `--every` seconds it writes shots/<out>-<t>s.png from the player's eyes and
// shots/<out>-<t>s-top.png looking straight down from `--top` (x, z, height). At the end it
// prints bot states, timing, the state-transition log and any page errors.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const out = arg('out', 'ai-bots');
const params = arg('params', 'map=range&bots=6&botdebug');
const seconds = Number(arg('seconds', '30'));
const every = Number(arg('every', '10'));
const top = arg('top', '0,0,70').split(',').map(Number);
const pose = arg('pose', '');
const difficulty = arg('difficulty', '');
const logLines = Number(arg('log', '60'));
const immortal = process.argv.includes('--immortal');
const perf = process.argv.includes('--perf');
const [width, height] = arg('size', '1600x900').split('x').map(Number);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`);
});
page.on('response', (response) => {
  if (response.status() >= 400) problems.push(`[http ${response.status()}] ${response.url()}`);
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}\n${error.stack ?? ''}`));

if (difficulty) {
  // Settings are read from localStorage on boot; set the difficulty before the game starts.
  await page.addInitScript((level) => {
    localStorage.setItem('ironvale.settings.v1', JSON.stringify({ gameplay: { difficulty: level } }));
  }, difficulty);
}
const url = `http://127.0.0.1:${arg('port', '5311')}/?autostart&${params}${pose ? `&pose=${pose}` : ''}`;
await mkdir(join(root, 'shots'), { recursive: true });

const shoot = async (label) => {
  await page.screenshot({ path: join(root, 'shots', `${out}-${label}.png`) });
  // Swap to a top-down view for a few frames, then put the player back.
  await page.evaluate(([x, z, y]) => {
    const game = window.__ironvale.game;
    const p = game.player;
    window.__saved = { x: p.position.x, y: p.position.y, z: p.position.z, yaw: p.yaw, pitch: p.pitch, health: p.health };
    game.debugPose(x, y, z, 0, -Math.PI / 2 + 0.001);
    // Hide the first-person gun for the overview.
    window.__hidden = game.engine.camera.children.filter((child) => child.visible);
    for (const child of window.__hidden) child.visible = false;
  }, top);
  await page.waitForTimeout(120);
  await page.screenshot({ path: join(root, 'shots', `${out}-${label}-top.png`) });
  await page.evaluate(() => {
    const game = window.__ironvale.game;
    const s = window.__saved;
    game.debugPose(s.x, s.y, s.z, s.yaw, s.pitch);
    game.player.health = s.health;
    for (const child of window.__hidden) child.visible = true;
  });
};

// Other people's edits make the dev server reload the page mid-run. Swallow the hot-reload
// socket so this page keeps the code it loaded with, and start over if a reload gets through anyway.
await page.routeWebSocket(/.*/, () => undefined);
let loads = 0;
page.on('load', () => loads++);
for (let attempt = 1; attempt <= 5; attempt++) {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
  const loadsAtStart = loads;
  // Keep the player alive so a long fight can be watched from one spot.
  if (immortal) await page.evaluate(() => setInterval(() => (window.__ironvale.game.player.health = 100), 100));
  // Time the bot system each frame, leaving out what ballistics, effects and audio do when a bot fires.
  if (perf) {
    await page.evaluate(() => {
      const game = window.__ironvale.game;
      const samples = (window.__botPerf = { own: [], fire: [] });
      let inFire = 0;
      const fire = game.ballistics.fire.bind(game.ballistics);
      game.ballistics.fire = (...args) => {
        const t = performance.now();
        fire(...args);
        inFire += performance.now() - t;
      };
      const update = game.bots.update.bind(game.bots);
      game.bots.update = (dt) => {
        inFire = 0;
        const t = performance.now();
        update(dt);
        const total = performance.now() - t;
        samples.own.push(total - inFire);
        samples.fire.push(inFire);
      };
    });
  }
  problems.length = 0;
  let reloaded = false;
  try {
    for (let t = 0; t < seconds && !reloaded; t += every) {
      await page.waitForTimeout(every * 1000);
      reloaded = loads !== loadsAtStart;
      if (!reloaded) await shoot(`${t + every}s`);
    }
  } catch (error) {
    if (loads === loadsAtStart) throw error;
    reloaded = true;
  }
  if (!reloaded && loads === loadsAtStart) break;
  process.stdout.write(`page reloaded during attempt ${attempt}; starting over\n`);
}

const report = await page.evaluate((lines) => {
  const debug = window.__ironvaleBots;
  const game = window.__ironvale.game;
  return {
    error: window.__ironvale.error,
    frameMs: game.engine.frameTimeMs,
    player: { health: game.player.health, alive: game.player.alive, position: game.player.position.toArray().map((v) => Math.round(v * 10) / 10) },
    alive: game.bots?.alive,
    stats: Object.fromEntries(Object.entries(game.bots?.stats ?? {}).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
    bots: debug?.bots() ?? null,
    perf: (() => {
      const samples = window.__botPerf;
      if (!samples) return null;
      const summarize = (list) => {
        const sorted = [...list].sort((a, b) => a - b);
        const at = (q) => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0) * 100) / 100;
        const mean = Math.round((list.reduce((a, b) => a + b, 0) / Math.max(1, list.length)) * 1000) / 1000;
        return { frames: list.length, mean, p95: at(0.95), p99: at(0.99), max: at(1) };
      };
      return { botsOnly: summarize(samples.own), insideFire: summarize(samples.fire) };
    })(),
    log: debug?.log.slice(-lines) ?? null,
    logLength: debug?.log.length ?? 0,
  };
}, logLines);
await browser.close();

process.stdout.write(`${JSON.stringify({ ...report, log: undefined }, null, 1)}\n`);
process.stdout.write(`--- last ${report.log?.length ?? 0} of ${report.logLength} transitions\n${(report.log ?? []).join('\n')}\n`);
const unique = [...new Set(problems)];
process.stdout.write(`--- ${unique.length} page problems\n`);
for (const line of unique.slice(0, 25)) process.stdout.write(`${line.slice(0, 600)}\n`);
