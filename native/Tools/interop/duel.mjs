// PLAN.md 5.4 layer 4, the M6 duel scenario: the real web build in Chrome (Playwright, Vite on
// port 5311) against the native app, through a local relay running the unchanged signaling/src.
// One run = one duel to the kill target on one map with one side hosting.
//
// The two take turns so every kill goes one known way: on an even kill total the web player hunts
// the native one (`hunt` from scripts/dev/net-lib.mjs: stand three metres from the target, aim at
// its chest, hold the trigger); on an odd total the web player stands still in clear view a few
// metres from the native player, whose DuelPilot (IronvaleNet) aims and fires through the game's
// own input. Nothing on the native side is scripted beyond that pilot.
//
// Assertions: the duel ends on both machines with complementary results; each side's kills equal
// the other's deaths; the winner reached the target; the web dropped no shot or hit from the
// native player (WeaponGate, damage cap, sender id), and the native app rejected nothing (its
// match log). Writes out/duel-<map>-<host>-<run>/: web.png, web-console.log, native.log, result.json.
//
// Usage: node native/Tools/interop/duel.mjs --app PATH/Ironvale.app --map railyard --host native|web
//          [--signal ws://127.0.0.1:8792] [--port 5311] [--target 10] [--run 1] [--repo ROOT]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = arg('app', '');
const mapId = arg('map', 'railyard');
const hostSide = arg('host', 'native');
const signal = arg('signal', 'ws://127.0.0.1:8792');
const port = arg('port', '5311');
const target = Number(arg('target', '10'));
const run = arg('run', '1');
/** Seconds into the run at which the native app loses its display link for 10 s (owner decision Q5); 0: never. */
const hideAt = Number(arg('hide', '0'));
const repo = arg('repo', join(here, '..', '..', '..'));
const mapName = { railyard: 'Railyard', headworks: 'Headworks', harbor: 'Harbor', range: 'Test Range' }[mapId];
/** Generous: about two minutes is typical for a duel to 10. */
const MATCH_TIMEOUT_MS = Number(arg('timeout', '480')) * 1000;
const WEB_NAME = 'Web';
const NATIVE_NAME = 'Native';

if (!app || !existsSync(app) || !mapName || !['native', 'web'].includes(hostSide)) {
  process.stderr.write('usage: duel.mjs --app Ironvale.app --map railyard|headworks --host native|web\n');
  process.exit(2);
}
const out = join(here, 'out', `duel-${mapId}-${hostSide}-host-${run}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
  process.stdout.write(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  (${detail})`}\n`);
}
const say = (line) => process.stdout.write(`-- ${line}\n`);

// ---- the native app -------------------------------------------------------------------------

const nativeLog = join(out, 'native.log');
const codeFile = join(out, 'room-code.txt');
let native = null;
let nativeExit = null;
function launchNative(extra) {
  // The isolated copy (isolate-app.sh) renames the executable.
  const binary = ['IronvaleM6', 'Ironvale'].map((name) => join(app, 'Contents', 'MacOS', name)).find((path) => existsSync(path));
  const args = ['--repo', repo, '--signal', signal, '--net-name', NATIVE_NAME, '--match-log', nativeLog, '--duel-map', mapId,
    '--kill-target', String(target), '--duel-shot', join(out, 'native-view.png'),
    // No "reopen windows?" prompt after another run of the app was killed.
    '-ApplePersistenceIgnoreState', 'YES', ...(hideAt > 0 ? ['--duel-hide', String(hideAt)] : []), ...extra];
  native = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  native.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  nativeExit = new Promise((resolve) => native.on('exit', (code) => resolve({ code, stderr })));
}
function nativeLines() {
  if (!existsSync(nativeLog)) return [];
  return readFileSync(nativeLog, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

// ---- the web page ---------------------------------------------------------------------------

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const context = await browser.newContext({ viewport: { width: 1120, height: 630 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
await page.routeWebSocket(new RegExp(`^wss?://(127\\.0\\.0\\.1|localhost):${port}/`), () => undefined);
await page.goto(`http://127.0.0.1:${port}/?dev&q=low&signal=${encodeURIComponent(signal)}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });

const inGame = (fn, value) => page.evaluate(`(${fn.toString()})(window.__ironvale.game, ${JSON.stringify(value ?? null)})`);
async function until(fn, ms, value) {
  const end = Date.now() + ms;
  for (;;) {
    const result = await inGame(fn, value).catch(() => null);
    if (result || Date.now() > end) return result;
    await wait(100);
  }
}
const visible = (selector) => page.locator(selector).filter({ visible: true });
const clickButton = (name) => page.getByRole('button', { name, exact: true }).filter({ visible: true }).first().click();

let exitCode = 1;
try {
  await clickButton('Play with a friend');
  await page.getByLabel('Your name').fill(WEB_NAME);
  await page.getByLabel('Your name').blur();
  await visible('button:has-text("Use copy-and-paste codes instead")').waitFor({ timeout: 15000 });

  if (hostSide === 'web') {
    say('web hosts, native joins');
    await clickButton('Host a game');
    const codeText = visible('.iv-friend__room');
    await codeText.waitFor({ timeout: 15000 });
    const code = (await codeText.textContent()).replace('Code', '').trim();
    check('web host got a room code', /^[A-HJ-NP-Z2-9]{6}$/.test(code), code);
    // Choose the match before the guest arrives, so it readies for exactly this config.
    await page.getByRole('radio', { name: 'Duel', exact: true }).filter({ visible: true }).click();
    await page.getByRole('radiogroup', { name: 'Map' }).filter({ visible: true }).getByRole('radio', { name: mapName }).click();
    await page.getByLabel('Kills to win').filter({ visible: true }).evaluate((input, next) => {
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, target);
    launchNative(['--autojoin', code]);
    await page.waitForFunction(() => window.__ironvale.game.net.state.step === 'connected', null, { timeout: 60000 });
    await visible('button:has-text("Start match"):not([disabled])').waitFor({ timeout: 30000 });
    await clickButton('Start match');
  } else {
    say('native hosts, web joins');
    launchNative(['--autohost', '--code-out', codeFile]);
    const end = Date.now() + 60000;
    while (!existsSync(codeFile) && Date.now() < end) await wait(100);
    const code = existsSync(codeFile) ? readFileSync(codeFile, 'utf8').trim() : '';
    check('native host got a room code', /^[A-HJ-NP-Z2-9]{6}$/.test(code), code);
    await page.getByLabel('Invite link or room code').fill(code.toLowerCase());
    await clickButton('Join');
    await page.waitForFunction(() => window.__ironvale.game.net.state.step === 'connected', null, { timeout: 60000 });
    // Ready only once the native host's config has arrived.
    const config = await until((game, want) => {
      const c = game.net.state.config;
      return c.mode === 'duel' && c.mapId === want.mapId && c.killTarget === want.target && c;
    }, 15000, { mapId, target });
    check('web guest sees the native host config', Boolean(config), JSON.stringify(config));
    await clickButton('Ready');
  }

  // Both in the match and past the countdown.
  const started = await page.waitForFunction(() => {
    const game = window.__ironvale.game;
    const net = game.net.snapshot();
    return net !== null && game.map !== null && !game.net.frozen && net.countdown === 0 && net.notice !== 'waiting-peer';
  }, null, { timeout: 120000 }).then(() => true, () => false);
  check('the match started on the web page', started);
  if (!started) throw new Error('no match');
  const setup = await inGame((game) => {
    game.debugControl = true;
    game.resume();
    return { mode: game.config.mode, map: game.config.mapId, target: game.config.killTarget, bots: game.bots.alive };
  });
  check('a duel on the chosen map with no bots', setup.mode === 'duel' && setup.map === mapId && setup.target === target && setup.bots === 0,
    JSON.stringify(setup));

  // Count everything the web match code drops from the native player (layer 4: zero rejections).
  await page.evaluate(async () => {
    const { maxHitDamage } = await import('/src/net/limits.ts');
    const { WEAPON_DEFS } = await import('/src/weapons/defs.ts');
    const sync = window.__ironvale.game.net.sync;
    const tally = { shots: 0, hits: 0, rejectedShots: 0, rejectedHits: 0, cappedHits: 0, reasons: [], maxFrameGapMs: 0, rejectAtMs: [] };
    window.__duel = tally;
    // Diagnostics, not a gate: the longest gap between the page's frames (a stalled page receives the
    // peer's backlog at once, which the WeaponGate rate-limits) and when each rejection happened.
    const t0 = performance.now();
    let last = t0;
    const watch = (now) => {
      tally.maxFrameGapMs = Math.max(tally.maxFrameGapMs, Math.round(now - last));
      last = now;
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    const reject = (kind, why) => {
      tally[kind]++;
      if (tally.reasons.length < 50) tally.reasons.push(why);
      if (tally.rejectAtMs.length < 50) tally.rejectAtMs.push(Math.round(performance.now() - t0));
    };
    const gate = sync.gate.bind(sync);
    const wrapped = new Set();
    sync.gate = (wire) => {
      const g = gate(wire);
      if (!wrapped.has(g)) {
        wrapped.add(g);
        const shot = g.allowShot.bind(g);
        const hit = g.allowHit.bind(g);
        g.allowShot = (def, now) => shot(def, now) || (reject('rejectedShots', `shot rate ${def.id}`), false);
        g.allowHit = (def, now) => hit(def, now) || (reject('rejectedHits', `hit rate ${def.id}`), false);
      }
      return g;
    };
    const onShot = sync.onRemoteShot.bind(sync);
    sync.onRemoteShot = (message, now) => {
      tally.shots++;
      if (!sync.remoteActor(message.actor)) reject('rejectedShots', `shot from unknown actor ${message.actor}`);
      onShot(message, now);
    };
    const onHit = sync.onRemoteHit.bind(sync);
    sync.onRemoteHit = (hit, now) => {
      tally.hits++;
      if (hit.target !== sync.myWire || hit.attacker !== sync.peerWire) reject('rejectedHits', `hit ${hit.attacker}->${hit.target}`);
      const def = WEAPON_DEFS[hit.weapon];
      if (!def) reject('rejectedHits', `hit with ${hit.weapon}`);
      else if (!(hit.amount > 0) || hit.amount > maxHitDamage(def)) reject('cappedHits', `hit ${hit.amount} over cap ${maxHitDamage(def)}`);
      onHit(hit, now);
    };
  });

  // ---- turns -------------------------------------------------------------------------------
  const deadline = Date.now() + MATCH_TIMEOUT_MS;
  let lastTotal = -1;
  let shotTaken = false;
  for (;;) {
    const state = await inGame((game) => ({ phase: game.phase, kills: game.kills, deaths: game.deaths, alive: game.player.alive,
      remoteAlive: game.net.sync?.remote.alive ?? false, step: game.net.state.step }));
    if (state.phase === 'won' || state.phase === 'lost' || state.step !== 'connected' || Date.now() > deadline) break;
    const total = state.kills + state.deaths;
    if (total !== lastTotal) {
      lastTotal = total;
      say(`score web ${state.kills} - native ${state.deaths}`);
    }
    if (!state.alive || !state.remoteAlive) {
      await wait(100);
      continue;
    }
    if (!shotTaken && total >= 2) {
      // Mid-match picture: the native soldier, drawn by the web.
      shotTaken = true;
      await page.screenshot({ path: join(out, 'web-mid.png') });
    }
    if (total % 2 === 0) {
      // The web player's turn: hunt the native player down.
      await inGame((game) => new Promise((resolve) => {
        const target = game.net.sync.remote;
        const me = game.player;
        const eye = me.position.clone();
        const chest = me.position.clone();
        const spot = me.position.clone();
        const started = performance.now();
        const input = { fire: true, aim: true };
        game.weapons.debugInput = input;
        const tick = () => {
          if (!target.alive || !me.alive || game.phase !== 'playing' || performance.now() - started > 20000) {
            game.weapons.debugInput = { fire: false };
            return resolve(target.alive);
          }
          const at = target.position;
          chest.set(at.x, at.y + 1.25, at.z);
          for (let i = 0; i < 8; i++) {
            const angle = (i * Math.PI) / 4;
            spot.set(at.x + Math.sin(angle) * 3, at.y + 0.05, at.z + Math.cos(angle) * 3);
            eye.set(spot.x, spot.y + 1.64, spot.z);
            if (game.world.capsuleFits(spot, 0.34, 1.8) && game.world.lineOfSight(eye, chest)) break;
          }
          me.position.copy(spot);
          me.velocity.set(0, 0, 0);
          const dx = chest.x - eye.x;
          const dz = chest.z - eye.z;
          me.yaw = Math.atan2(-dx, -dz);
          me.pitch = Math.atan2(chest.y - eye.y, Math.hypot(dx, dz));
          input.reload = game.weapons.current.magazine === 0;
          requestAnimationFrame(tick);
        };
        tick();
      }));
    } else {
      // The native player's turn: stand still in its clear view, six metres off, and wait.
      await inGame((game) => new Promise((resolve) => {
        const target = game.net.sync.remote;
        const me = game.player;
        const eye = me.position.clone();
        const theirEye = me.position.clone();
        const spot = me.position.clone();
        const started = performance.now();
        game.weapons.debugInput = { fire: false, aim: false };
        let chosen = null;
        const tick = () => {
          if (!target.alive || !me.alive || game.phase !== 'playing' || performance.now() - started > 20000) {
            game.weapons.debugInput = null;
            return resolve(me.alive);
          }
          const at = target.position;
          if (!chosen || chosen.from.distanceTo(at) > 0.5) {
            theirEye.set(at.x, at.y + 1.64, at.z);
            chosen = null;
            for (const distance of [6, 4, 8, 3]) {
              for (let i = 0; i < 8 && !chosen; i++) {
                const angle = (i * Math.PI) / 4;
                spot.set(at.x + Math.sin(angle) * distance, at.y + 0.05, at.z + Math.cos(angle) * distance);
                eye.set(spot.x, spot.y + 1.25, spot.z);
                if (game.world.capsuleFits(spot, 0.34, 1.8) && game.world.lineOfSight(theirEye, eye)) chosen = { spot: spot.clone(), from: at.clone() };
              }
              if (chosen) break;
            }
          }
          if (chosen) {
            me.position.copy(chosen.spot);
            me.velocity.set(0, 0, 0);
            me.yaw = Math.atan2(-(at.x - chosen.spot.x), -(at.z - chosen.spot.z));
            me.pitch = 0;
          }
          requestAnimationFrame(tick);
        };
        tick();
      }));
    }
  }

  // ---- results -----------------------------------------------------------------------------
  const web = await inGame((game) => ({ phase: game.phase, kills: game.kills, deaths: game.deaths, step: game.net.state.step,
    error: game.net.state.error, tally: window.__duel }));
  await page.screenshot({ path: join(out, 'web-end.png') });
  say(`web: ${JSON.stringify(web)}`);
  const exited = await Promise.race([nativeExit, wait(20000).then(() => null)]);
  const lines = nativeLines();
  const result = lines.find((line) => line.event === 'result');
  const nativeRejects = lines.filter((line) => line.event === 'reject');
  say(`native: ${JSON.stringify(result ?? null)}, exit ${exited?.code ?? 'still running'}`);

  check('the duel ended on the web page', web.phase === 'won' || web.phase === 'lost', web.phase);
  check('the duel ended on the native app', result?.phase === 'won' || result?.phase === 'lost', result?.phase ?? 'no result');
  check('the results are complementary', result && ((web.phase === 'won' && result.phase === 'lost') || (web.phase === 'lost' && result.phase === 'won')),
    `web ${web.phase}, native ${result?.phase}`);
  check('scores agree: web kills = native deaths', result && Number(result.deaths) === web.kills, `${web.kills} / ${result?.deaths}`);
  check('scores agree: web deaths = native kills', result && Number(result.kills) === web.deaths, `${web.deaths} / ${result?.kills}`);
  check(`the winner reached ${target}`, Math.max(web.kills, web.deaths) === target, `${web.kills}-${web.deaths}`);
  check('both sides scored (kills went both ways)', web.kills > 0 && web.deaths > 0, `${web.kills}-${web.deaths}`);
  check('the web accepted every native shot', web.tally.rejectedShots === 0 && web.tally.shots > 0,
    `${web.tally.shots} shots, ${web.tally.rejectedShots} rejected ${web.tally.reasons.join('; ')}`);
  check('the web accepted every native hit under the cap', web.tally.rejectedHits === 0 && web.tally.cappedHits === 0 && web.tally.hits > 0,
    `${web.tally.hits} hits, ${web.tally.rejectedHits} rejected, ${web.tally.cappedHits} capped`);
  check('the native app rejected nothing', nativeRejects.length === 0 && result?.rejections === '0',
    nativeRejects.slice(0, 5).map((l) => l.reason).join('; ') || `rejections ${result?.rejections}`);
  // Headworks' render export may not be drawable yet: the match then runs on collision alone.
  const rendered = !(exited?.stderr ?? '').includes('map renderer unavailable');
  say(`native map renderer: ${rendered ? 'drawn' : 'unavailable, collision-only run'}`);
  if (hideAt > 0) {
    const shown = lines.find((line) => line.event === 'shown');
    check('the native app kept playing without its display link', shown && Number(shown.stalledTicks) > 400,
      shown ? `${shown.stalledTicks} frames without a display link` : 'never hidden');
  }
  // An artifact, not a gate: it needs a frame drawn while on screen, which the desktop decides.
  say(`native view of the web player: ${existsSync(join(out, 'native-view.png')) ? 'native-view.png' : 'not captured (window off screen)'}`);
  check('the native app exited cleanly', exited?.code === 0, `exit ${exited?.code ?? 'none'} ${exited?.stderr?.slice(-300) ?? ''}`);
  writeFileSync(join(out, 'result.json'), JSON.stringify({ map: mapId, host: hostSide, run, target, web, native: result ?? null, nativeRenderer: rendered ? 'drawn' : 'collision-only', checks: results }, null, 2));
  exitCode = results.every((r) => r.pass) ? 0 : 1;
} catch (error) {
  check('the scenario ran', false, error instanceof Error ? error.message : String(error));
  await page.screenshot({ path: join(out, 'web-error.png') }).catch(() => undefined);
} finally {
  writeFileSync(join(out, 'web-console.log'), consoleLines.join('\n'));
  if (native && native.exitCode === null) native.kill('SIGKILL');
  await browser.close();
}
const failed = results.filter((r) => !r.pass);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed (${out})\n`);
process.exit(failed.length === 0 ? exitCode : 1);
