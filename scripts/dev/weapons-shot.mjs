// Drives the player's weapons in the running dev server and takes screenshots.
// Usage:
//   node scripts/dev/weapons-shot.mjs --steps "slot:2;wait:900;shot:weapons-garand-hip;aim:1;wait:600;center:1;shot:weapons-garand-aim"
//     [--params "map=range&bots=0&pose=0,0.05,6,0,0"] [--size 1600x900] [--settle 2500]
// Steps (separated by ;):
//   slot:N        equip loadout slot N          aim:0|1     lower or raise the sights
//   fire:0|1      release or hold the trigger   breath:0|1  hold breath
//   reload        press reload                  wait:MS     let the game run
//   next / prev   cycle to the next or previous weapon
//   shot:NAME     write shots/NAME.png          center:0|1  draw a marker at the exact screen centre
//   pose:x,y,z,yawDeg,pitchDeg  move the camera eval:EXPR   print an expression (game, w = weapons in scope)
//   freeze / step:SECONDS / thaw  stop real time, advance the weapons by an exact amount, resume
//   run:FILE      evaluate a JS file as a function body with game and w in scope, print its return value
// Prints every weapon event seen, and any page errors or warnings.
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const params = arg('params', 'map=range&bots=0&pose=0,0.05,6,0,0');
const steps = arg('steps', 'wait:500;shot:weapons-default').split(';').map((step) => step.trim()).filter(Boolean);
const settle = Number(arg('settle', '2500'));
const [width, height] = arg('size', '1600x900').split('x').map(Number);
const port = arg('port', '5311');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
// Other agents edit files while this runs and the dev server would reload the page under us.
// Keep the hot-reload socket open but silent so the page we loaded stays put.
await page.routeWebSocket(/.*/, () => undefined);
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

await page.goto(`http://127.0.0.1:${port}/?autostart&${params}`, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
const bootError = await page.evaluate(() => window.__ironvale?.error ?? null);
if (bootError) {
  process.stdout.write(`boot error: ${bootError}\n`);
  for (const line of problems.slice(0, 20)) process.stdout.write(`${line.slice(0, 400)}\n`);
  await browser.close();
  process.exit(1);
}

// Other agents edit files while this runs, and the dev server reloads the page when they do.
// Re-attach to the game before every step so a reload costs a step, not the run.
let reloads = -1;
async function attach() {
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
  const fresh = await page.evaluate(() => {
    if (window.__weaponLog) return false;
    const game = window.__ironvale.game;
    game.weapons.debugInput = {};
    // With no bots the match is won on its first frame and the game stops updating; keep it running.
    if (game.config) game.config = { ...game.config, botCount: Number.MAX_SAFE_INTEGER };
    if (game.phase === 'won') game.phase = 'playing';
    const log = [];
    window.__weaponLog = log;
    const t = () => game.time.toFixed(2);
    game.events.on('shotFired', (e) => log.push(`${t()} shotFired ${e.weapon.id}`));
    game.events.on('weaponAction', (e) => log.push(`${t()} action ${e.stage}`));
    game.events.on('weaponSwitch', (e) => log.push(`${t()} switch ${e.weapon.id}`));
    game.events.on('dryFire', () => log.push(`${t()} dryFire`));
    game.events.on('aimChanged', (e) => log.push(`${t()} aim ${e.aiming}`));
    game.events.on('casingEjected', (e) => log.push(`${t()} casing ${e.kind}`));
    game.events.on('bulletImpact', (e) => log.push(`${t()} impact ${e.hit.surface} ${e.hit.distance.toFixed(1)}m`));
    game.events.on('combatantHit', (e) => log.push(`${t()} hit ${e.hit.zone} fatal=${e.fatal}`));
    return true;
  });
  if (fresh) reloads++;
}
await attach();
await page.waitForTimeout(settle);
await mkdir(join(root, 'shots'), { recursive: true });

for (const step of steps) {
  await attach();
  const split = step.indexOf(':');
  const name = split < 0 ? step : step.slice(0, split);
  const value = split < 0 ? '' : step.slice(split + 1);
  if (name === 'wait') {
    await page.waitForTimeout(Number(value));
  } else if (name === 'shot') {
    const file = join(root, 'shots', `${value}.png`);
    await page.screenshot({ path: file });
    process.stdout.write(`${file}\n`);
  } else if (name === 'center') {
    await page.evaluate((on) => {
      document.getElementById('__center')?.remove();
      if (!on) return;
      const marker = document.createElement('div');
      marker.id = '__center';
      marker.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999';
      marker.innerHTML =
        '<div style="position:absolute;left:50%;top:calc(50% - 14px);width:1px;height:28px;background:#f33;transform:translateX(-0.5px)"></div>' +
        '<div style="position:absolute;top:50%;left:calc(50% - 14px);height:1px;width:28px;background:#f33;transform:translateY(-0.5px)"></div>';
      document.body.append(marker);
    }, value !== '0');
  } else if (name === 'eval') {
    const result = await page.evaluate((expression) => {
      const game = window.__ironvale.game;
      const w = game.weapons;
      // eslint-disable-next-line no-new-func
      return JSON.stringify(new Function('game', 'w', `return (${expression})`)(game, w));
    }, value);
    process.stdout.write(`eval ${value} => ${result}\n`);
  } else if (name === 'freeze' || name === 'thaw' || name === 'step') {
    // freeze stops the weapons advancing in real time; step:SECONDS then advances them by exactly that much
    // (fixed 1/120 s steps), so a screenshot shows a known moment of an animation. thaw resumes real time.
    await page.evaluate(
      ([kind, seconds]) => {
        const weapons = window.__ironvale.game.weapons;
        weapons.__update ??= weapons.update.bind(weapons);
        if (kind === 'thaw') weapons.update = weapons.__update;
        else weapons.update = () => undefined;
        const steps = kind === 'step' ? Math.round(seconds * 120) : 0;
        for (let i = 0; i < steps; i++) weapons.__update(1 / 120);
      },
      [name, Number(value || 0)],
    );
    if (name === 'step') {
      // The body applies the aim zoom a frame later; let it, then refresh the pose against the settled camera.
      await page.waitForTimeout(120);
      await page.evaluate(() => window.__ironvale.game.weapons.__update(0));
      await page.waitForTimeout(200);
    }
  } else if (name === 'run') {
    // run:path/to/file.js evaluates the file as a function body with `game` and `w` in scope and prints what it returns.
    const body = await readFile(value, 'utf8');
    const result = await page.evaluate((source) => {
      const game = window.__ironvale.game;
      // eslint-disable-next-line no-new-func
      return JSON.stringify(new Function('game', 'w', source)(game, game.weapons));
    }, body);
    process.stdout.write(`run ${value} => ${result}\n`);
  } else if (name === 'pose') {
    await page.evaluate((text) => {
      const [x, y, z, yaw, pitch] = text.split(',').map(Number);
      const rad = Math.PI / 180;
      window.__ironvale.game.debugPose(x, y, z, yaw * rad, pitch * rad);
    }, value);
  } else {
    await page.evaluate(
      ([key, raw]) => {
        const input = window.__ironvale.game.weapons.debugInput;
        if (key === 'slot') input.slot = Number(raw);
        else if (key === 'reload') input.reload = true;
        else if (key === 'next') input.cycle = 1;
        else if (key === 'prev') input.cycle = -1;
        else if (key === 'aim') input.aim = raw !== '0';
        else if (key === 'fire') input.fire = raw !== '0';
        else if (key === 'breath') input.holdBreath = raw !== '0';
        else throw new Error(`Unknown step "${key}"`);
      },
      [name, value],
    );
  }
}

const log = await page.evaluate(() => window.__weaponLog ?? []);
if (reloads > 0) process.stdout.write(`note: the page reloaded ${reloads} time(s) during the run; earlier steps were lost\n`);
await browser.close();
process.stdout.write(`events (${log.length}):\n`);
for (const line of log.slice(0, 80)) process.stdout.write(`  ${line}\n`);
if (log.length > 80) process.stdout.write(`  ... ${log.length - 80} more\n`);
const unique = [...new Set(problems)];
process.stdout.write(`problems (${unique.length}):\n`);
for (const line of unique.slice(0, 25)) process.stdout.write(`  ${line.slice(0, 400)}\n`);
