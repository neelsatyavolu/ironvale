// Scripted check of the hand grenade in the running dev server.
// Usage: node scripts/dev/grenade-check.mjs [--port 5311] [--size 1600x900] [--q high]
// Walks through: cancel with fire, hold shows the arc, release throws, bounces, the blast kills a bot in
// the open and spares one behind a wall, the count stays 0 after a respawn, and a restart gives it back.
// Writes shots/grenade-arc.png, shots/grenade-blast.png and shots/grenade-smoke.png. Exits 1 on any failure.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const port = arg('port', '5311');
const quality = arg('q', 'high');
const [width, height] = arg('size', '1600x900').split('x').map(Number);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
// Other agents edit files while this runs; keep the hot-reload socket silent so the page stays put.
await page.routeWebSocket(/.*/, () => undefined);
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  process.stdout.write(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}\n`);
};
const shot = async (name) => {
  await page.screenshot({ path: join(root, 'shots', `${name}.png`) });
  process.stdout.write(`wrote shots/${name}.png\n`);
};
const state = () =>
  page.evaluate(() => {
    const game = window.__ironvale.game;
    const hand = game.weapons.grenade;
    return {
      count: hand.count,
      aiming: hand.aiming,
      snapshot: window.__grenade.snapshot && { grenades: window.__grenade.snapshot.grenades, aiming: window.__grenade.snapshot.grenadeAiming },
      health: game.player.health,
      alive: game.player.alive,
      kills: game.kills,
      phase: game.phase,
      hud: document.querySelector('.iv-nade')?.textContent ?? '(missing)',
      hudClass: document.querySelector('.iv-nade')?.className ?? '',
      log: window.__grenade.log.slice(),
    };
  });
const input = (patch) => page.evaluate((p) => Object.assign(window.__ironvale.game.weapons.debugInput, p), patch);
const hook = () =>
  page.evaluate(() => {
    const game = window.__ironvale.game;
    game.debugControl = true;
    game.weapons.debugInput = {};
    const record = { log: [], snapshot: null, exploded: null, hud: '' };
    window.__grenade = record;
    const t = () => game.time.toFixed(2);
    const at = (v) => `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`;
    game.events.on('grenadeThrown', (e) => record.log.push(`${t()} thrown from ${at(e.position)}`));
    game.events.on('grenadeBounced', (e) => record.log.push(`${t()} bounce ${e.surface} ${e.speed.toFixed(1)} m/s at ${at(e.position)}`));
    game.events.on('grenadeExploded', (e) => {
      record.exploded = { x: e.position.x, y: e.position.y, z: e.position.z, time: game.time };
      record.log.push(`${t()} exploded at ${at(e.position)}`);
    });
    game.events.on('died', (e) => record.log.push(`${t()} died victim=${e.victimId} killer=${e.killerId} weapon=${e.weaponId}`));
    game.events.on('matchState', (s) => (record.snapshot = s));
  });

await mkdir(join(root, 'shots'), { recursive: true });
// Stand 18 m in front of the shed's back wall, looking at it: a level throw runs into the shed and stops near the wall.
await page.goto(`http://127.0.0.1:${port}/?autostart&map=range&bots=0&q=${quality}&pose=1.5,0.05,0,0,0`, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
const bootError = await page.evaluate(() => window.__ironvale?.error ?? null);
if (bootError) {
  process.stdout.write(`boot error: ${bootError}\n${problems.slice(0, 20).join('\n')}\n`);
  await browser.close();
  process.exit(1);
}
await hook();
await page.waitForTimeout(1500);

let s = await state();
check('starts the match with one grenade', s.count === 1 && s.snapshot?.grenades === 1, `count ${s.count}`);
check('the HUD shows 1 and the key', s.hud === 'Grenade1Hold G', s.hud);

// Cancel: hold, then press fire. The grenade is kept and letting go of the key does not throw it.
await input({ grenade: true });
await page.waitForTimeout(400);
s = await state();
check('holding the key aims', s.aiming === true && s.snapshot?.aiming === true);
check('the HUD says how to throw while aiming', s.hud === 'Grenade1Release G to throw' && s.hudClass.includes('is-aiming'), s.hud);
await input({ fire: true });
await page.waitForTimeout(150);
await input({ fire: false, grenade: false });
await page.waitForTimeout(500);
s = await state();
check('fire cancels without using the grenade', s.aiming === false && s.count === 1 && !s.log.some((l) => l.includes('thrown')));

// Two bots that stand still: one in the open near where the grenade will stop, one behind the shed's back wall.
await input({ grenade: true });
await page.waitForTimeout(500);
const plan = await page.evaluate(async () => {
  const game = window.__ironvale.game;
  const math = await import('/src/weapons/grenade-math.ts');
  const hand = game.weapons.grenade;
  const points = new Float32Array(math.GRENADE.maxArcPoints * 3);
  const count = math.predictArc(hand.origin, hand.velocity, game.world, points);
  const end = { x: points[(count - 1) * 3], y: points[(count - 1) * 3 + 1], z: points[(count - 1) * 3 + 2] };
  game.bots.spawn(2, 'bravo', 'recruit');
  game.bots.update = () => {};
  const bots = game.combat.all().filter((c) => c.kind === 'bot');
  const [open, covered] = bots;
  open.position.set(end.x + 2, 0.05, end.z + 1);
  covered.position.set(end.x, 0.05, -19.2);
  window.__grenade.bots = { open, covered, coveredHealth: covered.health };
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const started = performance.now();
  for (let i = 0; i < 200; i++) math.predictArc(hand.origin, hand.velocity, game.world, points);
  return {
    end,
    arcMs: (performance.now() - started) / 200,
    points: count,
    openDistance: flat(open.position, end),
    coveredDistance: flat(covered.position, end),
    playerDistance: flat(game.player.position, end),
    arcVisible: game.engine.scene.getObjectByName('fx').children.filter((c) => c.visible && c.renderOrder === 7).length,
  };
});
process.stdout.write(`predicted end ${plan.end.x.toFixed(2)},${plan.end.y.toFixed(2)},${plan.end.z.toFixed(2)} after ${plan.points} points\n`);
process.stdout.write(
  `bot in the open ${plan.openDistance.toFixed(1)} m from it, bot behind the wall ${plan.coveredDistance.toFixed(1)} m, player ${plan.playerDistance.toFixed(1)} m\n`,
);
process.stdout.write(`working out the arc takes ${plan.arcMs.toFixed(3)} ms\n`);
check('the covered bot is inside the blast radius', plan.coveredDistance < 8 && plan.openDistance < 3);
await page.waitForTimeout(200);
await shot('grenade-arc');

await input({ grenade: false });
await page.waitForFunction(() => window.__grenade.exploded !== null, null, { timeout: 8000 });
await page.waitForTimeout(60);
await shot('grenade-blast');
await page.waitForTimeout(700);
await shot('grenade-smoke');

const after = await page.evaluate(() => {
  const game = window.__ironvale.game;
  const { open, covered } = window.__grenade.bots;
  return {
    exploded: window.__grenade.exploded,
    open: { alive: open.alive, health: open.health },
    covered: { alive: covered.alive, health: covered.health, before: window.__grenade.bots.coveredHealth },
    feed: window.__grenade.snapshot.killFeed.map((k) => `${k.killer} > ${k.victim} (${k.weapon})`),
    shotsHit: game.shotsHit,
  };
});
s = await state();
for (const line of s.log) process.stdout.write(`  ${line}\n`);
const thrownAt = Number(s.log.find((l) => l.includes('thrown'))?.split(' ')[0]);
const fuse = after.exploded.time - thrownAt;
const miss = Math.hypot(after.exploded.x - plan.end.x, after.exploded.y - plan.end.y, after.exploded.z - plan.end.z);
check('release throws', s.log.some((l) => l.includes('thrown')));
check('it bounces', s.log.filter((l) => l.includes('bounce')).length >= 1);
check('it explodes about 2.5 s after release', Math.abs(fuse - 2.5) < 0.1, `${fuse.toFixed(2)} s`);
check('it goes off where the arc said', miss < 0.05, `${miss.toFixed(3)} m off`);
check('the bot in the open dies', after.open.alive === false);
check('the bot behind the wall is untouched', after.covered.alive === true && after.covered.health === after.covered.before, `health ${after.covered.health} of ${after.covered.before}`);
check('the kill is credited to the thrower', s.kills === 1 && after.feed.some((f) => f.includes('(Grenade)')), after.feed.join('; '));
check('a blast does not count as a shot that hit', after.shotsHit === 0);
check('the thrower, 16 m away, is unhurt', s.health === 100);
check('the count is 0', s.count === 0 && s.snapshot?.grenades === 0);
check('the HUD shows 0', s.hud === 'Grenade0Used' && s.hudClass.includes('is-out'), s.hud);

// Respawn and resupply do not give it back.
await page.evaluate(() => {
  const game = window.__ironvale.game;
  const player = game.player;
  player.applyDamage({ amount: 1000, zone: 'torso', attackerId: -1, weaponId: 'm4a1', point: player.position, direction: player.position.clone().set(0, 0, -1) });
});
await page.waitForFunction(() => window.__ironvale.game.player.alive, null, { timeout: 8000 });
await page.evaluate(() => window.__ironvale.game.weapons.resupply());
await page.waitForTimeout(300);
await input({ grenade: true });
await page.waitForTimeout(300);
s = await state();
check('still 0 after a respawn and a resupply, and the key does nothing', s.count === 0 && s.aiming === false && s.snapshot?.grenades === 0);
await input({ grenade: false });

// A restart is a new match.
await page.evaluate(() => window.__ironvale.game.restart());
await page.waitForFunction(() => window.__ironvale.game.phase === 'playing', null, { timeout: 90000 });
await page.waitForTimeout(500);
s = await state();
check('a restart gives the grenade back', s.count === 1 && s.snapshot?.grenades === 1);

// It hurts the thrower: drop it at the feet.
await page.evaluate(() => {
  window.__grenade.exploded = null;
  window.__grenade.log.length = 0;
  window.__ironvale.game.player.pitch = -1.45;
});
await page.waitForTimeout(200);
await input({ grenade: true });
await page.waitForTimeout(300);
await input({ grenade: false });
await page.waitForFunction(() => window.__grenade.exploded !== null, null, { timeout: 8000 });
await page.waitForTimeout(200);
s = await state();
const own = await page.evaluate(() => {
  const game = window.__ironvale.game;
  const e = window.__grenade.exploded;
  return { id: game.player.id, distance: Math.hypot(e.x - game.player.position.x, e.z - game.player.position.z), deaths: game.deaths, kills: game.kills };
});
for (const line of s.log) process.stdout.write(`  ${line}\n`);
check(
  'a grenade at the feet kills the thrower and counts as a death, not a kill',
  s.alive === false && own.deaths === 1 && own.kills === 0 && s.log.some((l) => l.includes(`victim=${own.id} killer=${own.id} weapon=grenade`)),
  `${own.distance.toFixed(1)} m from the blast, health ${s.health}`,
);

const mine = problems.filter((line) => !/\[vite\]|WebSocket|ERR_CONNECTION/i.test(line));
check('no page errors or warnings', mine.length === 0, `${mine.length}`);
for (const line of mine.slice(0, 20)) process.stdout.write(`  ${line.slice(0, 400)}\n`);
await browser.close();
const failed = results.filter((r) => !r.pass).length;
process.stdout.write(`${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
