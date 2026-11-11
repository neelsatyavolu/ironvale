// Checks the loadout in a running match: which gun each slot equips, and which guns the bots carry and fire.
// Usage: node scripts/dev/weapons-loadout.mjs [--map range] [--bots 8] [--watch 8000] [--port 5311]   (needs npm run dev)
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const map = arg('map', 'range');
const bots = arg('bots', '8');
const watch = Number(arg('watch', '8000'));
const port = arg('port', '5311');
const EXPECTED = ['m4a1', 'mp5', 'm24', 'm249'];

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

await page.goto(`http://127.0.0.1:${port}/?autostart&map=${map}&bots=${bots}&q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
await page.evaluate(() => {
  const game = window.__ironvale.game;
  window.__fired = {};
  game.events.on('shotFired', (shot) => {
    if (shot.shooterId === game.player.id) return;
    window.__fired[shot.weapon.id] = (window.__fired[shot.weapon.id] ?? 0) + 1;
  });
});

const slots = [];
for (const slot of [1, 2, 3, 4, 5, 6, 7]) {
  await page.evaluate((n) => {
    window.__ironvale.game.weapons.debugInput = { slot: n };
  }, slot);
  // A switch lowers one gun and raises the next, and a heavy map runs slowly headless: wait for it, not for a fixed time.
  const expected = EXPECTED[slot - 1];
  if (expected) await page.waitForFunction((id) => window.__ironvale.game.weapons.current.def.id === id, expected, { timeout: 8000 }).catch(() => undefined);
  else await page.waitForTimeout(1000);
  slots.push(await page.evaluate(() => window.__ironvale.game.weapons.current.def.id));
}
// A real key press for a slot that no longer exists must do nothing.
await page.evaluate(() => {
  window.__ironvale.game.weapons.debugInput = null;
});
await page.keyboard.press('Digit6');
await page.waitForTimeout(800);
const afterDeadKey = await page.evaluate(() => window.__ironvale.game.weapons.current.def.id);

await page.waitForTimeout(watch);
const result = await page.evaluate(() => ({
  error: window.__ironvale.error ?? null,
  fired: window.__fired ?? {},
  carried: window.__ironvale.game.bots.bots.map((bot) => bot.weapon.def.id),
  alive: window.__ironvale.game.bots.alive,
}));
await browser.close();

const firedIds = Object.keys(result.fired);
const carried = [...new Set(result.carried)].sort();
const checks = [
  ['slots 1 to 4 equip M4A1, MP5, M24, M249', EXPECTED.every((id, i) => slots[i] === id)],
  ['slots 5 to 7 change nothing', slots.slice(4).every((id) => id === EXPECTED[3]) && afterDeadKey === EXPECTED[3]],
  ['bots carry guns, and only guns that exist', carried.length > 0 && carried.every((id) => EXPECTED.includes(id))],
  ['any shots the bots fired came from those guns', firedIds.every((id) => EXPECTED.includes(id))],
  ['no page errors', problems.length === 0 && !result.error],
];
process.stdout.write(`map ${map}: slots ${slots.join(',')} | bots carry ${carried.join(',')} | bots fired ${JSON.stringify(result.fired)} | alive ${result.alive}\n`);
for (const [label, ok] of checks) process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
for (const line of [...new Set(problems)].slice(0, 8)) process.stdout.write(`${line.replace(/\s+/g, ' ').slice(0, 240)}\n`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
