// Times how fast bot marksmen shoot an immortal player who appears in front of them. Every 4 seconds the
// player is put 12 m in front of a living marksman (where it can see), and the check records how long that
// marksman takes to fire its M24, and whether the round hits.
// Usage: node scripts/dev/marksman-check.mjs [--difficulty veteran] [--seconds 60] [--bots 12] [--port 5311]   (needs npm run dev)
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const difficulty = arg('difficulty', 'veteran');
const seconds = Number(arg('seconds', '60'));
const bots = arg('bots', '12');
const port = arg('port', '5311');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
await page.addInitScript((level) => {
  localStorage.setItem('ironvale.settings.v1', JSON.stringify({ gameplay: { difficulty: level } }));
}, difficulty);
await page.goto(`http://127.0.0.1:${port}/?autostart&map=range&bots=${bots}&q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
await page.evaluate(() => {
  const game = window.__ironvale.game;
  setInterval(() => (game.player.health = 100), 50);
  const log = (window.__marksman = { trials: [], hits: 0 });
  let trial = null;
  game.events.on('shotFired', (shot) => {
    if (shot.local || shot.weapon.id !== 'm24' || !trial || trial.delay !== null || shot.shooterId !== trial.bot) return;
    trial.delay = (performance.now() - trial.start) / 1000;
  });
  game.events.on('combatantHit', (hit) => {
    if (hit.weapon.id === 'm24' && hit.targetId === game.player.id) log.hits++;
  });
  let next = 0;
  setInterval(() => {
    const marksmen = game.bots.bots.filter((bot) => bot.alive && bot.role === 'marksman');
    if (!marksmen.length) return;
    const bot = marksmen[next++ % marksmen.length];
    // Facing is yaw = atan2(-dx, -dz), so straight ahead is (-sin, -cos).
    const spot = bot.position.clone().add({ x: -Math.sin(bot.yaw) * 12, y: 0, z: -Math.cos(bot.yaw) * 12 });
    game.player.respawn(spot, bot.yaw + Math.PI);
    trial = { bot: bot.id, start: performance.now(), delay: null };
    log.trials.push(trial);
  }, 4000);
});
await page.waitForTimeout(seconds * 1000);
const result = await page.evaluate(() => window.__marksman);
await browser.close();

const fired = result.trials.filter((trial) => trial.delay !== null).map((trial) => trial.delay).sort((a, b) => a - b);
process.stdout.write(`${difficulty}: ${result.trials.length} appearances 12 m in front of a marksman, ${fired.length} drew a shot, ${result.hits} M24 hits on the player\n`);
process.stdout.write(`seconds from appearing to the shot: ${fired.map((delay) => delay.toFixed(2)).join(' ') || '-'}\n`);
if (problems.length) process.stdout.write(`page errors: ${problems.slice(0, 4).join(' | ')}\n`);
