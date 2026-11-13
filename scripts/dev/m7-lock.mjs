// Checks that a reserved gun (the M7 on slot 5, the SCAR-H on slot 6) is carried on Veteran and Elite only:
// its slot, the weapon cycle, firing, and a restart at a lower level.
// Usage: node scripts/dev/m7-lock.mjs [--gun m7|scarh] [--port 5311]   (needs npm run dev). Writes shots/<gun>-hip.png, -aim.png, -fire.png.
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const portAt = process.argv.indexOf('--port');
const port = portAt >= 0 ? process.argv[portAt + 1] : '5311';
const gunAt = process.argv.indexOf('--gun');
const GUN = gunAt >= 0 ? process.argv[gunAt + 1] : 'm7';
const SLOT = { m7: 5, scarh: 6 }[GUN];
if (!SLOT) throw new Error(`--gun must be m7 or scarh, not ${GUN}`);
const NAME = GUN === 'm7' ? 'M7' : 'SCAR-H';

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
  for (let i = 0; i < 7; i++) {
    await input({ cycle: 1 });
    await page.waitForTimeout(1500);
    seen.push(await current());
  }
  return [...new Set(seen)];
};

const checks = [];
for (const level of ['recruit', 'regular']) {
  await start(level);
  await input({ slot: SLOT });
  checks.push([`${level}: slot ${SLOT} does nothing`, (await settle(null)) !== GUN]);
  checks.push([`${level}: the cycle skips the ${NAME}`, !(await cycle()).includes(GUN)]);
}
for (const level of ['veteran', 'elite']) {
  await start(level);
  await input({ slot: SLOT });
  checks.push([`${level}: slot ${SLOT} equips the ${NAME}`, (await settle(GUN)) === GUN]);
  await input({ slot: 1 });
  await settle('m4a1');
  checks.push([`${level}: the cycle reaches the ${NAME}`, (await cycle()).includes(GUN)]);
}

// Still on Elite: fire the gun and photograph it.
await input({ slot: SLOT });
await settle(GUN);
await page.evaluate((id) => {
  const game = window.__ironvale.game;
  window.__gunShots = 0;
  game.events.on('shotFired', (shot) => {
    if (shot.weapon.id === id) window.__gunShots++;
  });
}, GUN);
await mkdir('shots', { recursive: true });
await page.waitForTimeout(800);
await page.screenshot({ path: `shots/${GUN}-hip.png` });
await input({ aim: true });
await page.waitForTimeout(900);
await page.screenshot({ path: `shots/${GUN}-aim.png` });
await input({ aim: true, fire: true });
await page.waitForTimeout(500);
await page.screenshot({ path: `shots/${GUN}-fire.png` });
await input({});
await page.waitForTimeout(300);
const state = await page.evaluate(() => ({ shots: window.__gunShots, magazine: window.__ironvale.game.weapons.current.magazine }));
checks.push([`the ${NAME} fires and uses its 20-round magazine`, state.shots >= 3 && state.magazine === 20 - state.shots]);

// A new match at a lower level, and a duel, with the gun in hand: it is put away.
await start('regular');
checks.push([`restart on Regular with the ${NAME} in hand: back to the M4A1`, (await settle('m4a1')) === 'm4a1']);
await start('elite');
await input({ slot: SLOT });
await settle(GUN);
await start('elite', 'duel');
await input({ slot: SLOT });
checks.push([`a duel never issues the ${NAME}`, (await settle(null)) !== GUN]);

const error = await page.evaluate(() => window.__ironvale.error ?? null);
checks.push(['no page errors', problems.length === 0 && !error]);
await browser.close();

for (const [label, ok] of checks) process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
for (const line of [...new Set(problems)].slice(0, 8)) process.stdout.write(`${line.replace(/\s+/g, ' ').slice(0, 240)}\n`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
