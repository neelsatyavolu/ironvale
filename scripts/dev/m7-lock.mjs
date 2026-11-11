// Checks that the M7 is carried on Veteran and Elite only: slot 5, the weapon cycle, firing, and a restart at a lower level.
// Usage: node scripts/dev/m7-lock.mjs [--port 5311]   (needs npm run dev). Writes shots/m7-hip.png and shots/m7-aim.png.
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const portAt = process.argv.indexOf('--port');
const port = portAt >= 0 ? process.argv[portAt + 1] : '5311';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`[error] ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

await page.goto(`http://127.0.0.1:${port}/?autostart&map=range&bots=0&q=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });

const current = () => page.evaluate(() => window.__ironvale.game.weapons.current.def.id);
const start = (difficulty, mode = 'skirmish') =>
  page.evaluate(
    async ([level, kind]) => {
      const game = window.__ironvale.game;
      await game.startMatch({ mapId: 'range', mode: kind, difficulty: level, botCount: 0 });
      game.weapons.debugInput = {};
    },
    [difficulty, mode],
  );
const input = (value) =>
  page.evaluate((next) => {
    window.__ironvale.game.weapons.debugInput = next;
  }, value);
const settle = async (id) => {
  if (id) await page.waitForFunction((want) => window.__ironvale.game.weapons.current.def.id === want, id, { timeout: 8000 }).catch(() => undefined);
  else await page.waitForTimeout(1500);
  return current();
};
/** Every weapon reached by pressing "next" once round the loadout. */
const cycle = async () => {
  const seen = [];
  for (let i = 0; i < 6; i++) {
    await input({ cycle: 1 });
    await page.waitForTimeout(1500);
    seen.push(await current());
  }
  return [...new Set(seen)];
};

const checks = [];
for (const level of ['recruit', 'regular']) {
  await start(level);
  await input({ slot: 5 });
  checks.push([`${level}: slot 5 does nothing`, (await settle(null)) !== 'm7']);
  checks.push([`${level}: the cycle skips the M7`, !(await cycle()).includes('m7')]);
}
for (const level of ['veteran', 'elite']) {
  await start(level);
  await input({ slot: 5 });
  checks.push([`${level}: slot 5 equips the M7`, (await settle('m7')) === 'm7']);
  await input({ slot: 1 });
  await settle('m4a1');
  checks.push([`${level}: the cycle reaches the M7`, (await cycle()).includes('m7')]);
}

// Still on Elite: fire the M7 and photograph it.
await input({ slot: 5 });
await settle('m7');
await page.evaluate(() => {
  const game = window.__ironvale.game;
  window.__m7Shots = 0;
  game.events.on('shotFired', (shot) => {
    if (shot.weapon.id === 'm7') window.__m7Shots++;
  });
});
await mkdir('shots', { recursive: true });
await page.waitForTimeout(800);
await page.screenshot({ path: 'shots/m7-hip.png' });
await input({ aim: true });
await page.waitForTimeout(900);
await page.screenshot({ path: 'shots/m7-aim.png' });
await input({ aim: true, fire: true });
await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/m7-fire.png' });
await input({});
await page.waitForTimeout(300);
const state = await page.evaluate(() => ({ shots: window.__m7Shots, magazine: window.__ironvale.game.weapons.current.magazine }));
checks.push(['the M7 fires and uses its 20-round magazine', state.shots >= 3 && state.magazine === 20 - state.shots]);

// A new match at a lower level, and a duel, with the M7 in hand: it is put away.
await start('regular');
checks.push(['restart on Regular with the M7 in hand: back to the M4A1', (await settle('m4a1')) === 'm4a1']);
await start('elite');
await input({ slot: 5 });
await settle('m7');
await start('elite', 'duel');
await input({ slot: 5 });
checks.push(['a duel never issues the M7', (await settle(null)) !== 'm7']);

const error = await page.evaluate(() => window.__ironvale.error ?? null);
checks.push(['no page errors', problems.length === 0 && !error]);
await browser.close();

for (const [label, ok] of checks) process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
for (const line of [...new Set(problems)].slice(0, 8)) process.stdout.write(`${line.replace(/\s+/g, ' ').slice(0, 240)}\n`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
