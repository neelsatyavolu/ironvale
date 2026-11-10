// Screenshot of the weapon list, a kill note and an enemy health bar in a running match.
// Usage: node scripts/dev/ui-extras.mjs  ->  shots/ui-extras.png (needs npm run dev)
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(m.text().slice(0, 200)));
page.on('pageerror', (e) => problems.push(e.message));
await page.goto('http://127.0.0.1:5311/?autostart&map=range&bots=3&q=medium');
await page.waitForFunction(() => window.__ironvale?.ready, null, { timeout: 60000 });
await page.waitForTimeout(1500);
const info = await page.evaluate(() => {
  const game = window.__ironvale.game;
  const player = game.player;
  const bots = game.combat.all().filter((c) => c.kind === 'bot' && c.alive);
  const bot = bots[0];
  // Face the first bot from 9 m away.
  const dx = bot.position.x - player.position.x, dz = bot.position.z - player.position.z;
  const len = Math.hypot(dx, dz);
  game.debugPose(bot.position.x - (dx / len) * 9, bot.position.y + 0.05, bot.position.z - (dz / len) * 9, Math.atan2(-dx, -dz), 0);
  const weapon = game.weapons.current.def;
  game.events.emit('weaponSwitch', { shooterId: player.id, weapon, local: true });
  bot.health = 46;
  game.events.emit('combatantHit', { weapon, targetId: bot.id, attackerId: player.id, hit: { distance: 9, zone: 'torso', point: bot.position.clone() }, direction: bot.position.clone(), fatal: false });
  game.events.emit('died', { victimId: bots[1].id, killerId: player.id, weaponId: weapon.id, headshot: true });
  return { bots: bots.length };
});
await page.waitForTimeout(350);
await page.screenshot({ path: 'shots/ui-extras.png' });
await browser.close();
process.stdout.write(`${JSON.stringify(info)} ${JSON.stringify(problems.slice(0, 5))}\n`);
