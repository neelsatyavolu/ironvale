// Two-player duel, end to end, in two real Chrome pages on the running dev server.
// Needs the signaling Worker running locally: cd signaling && npm run dev
// Usage: node scripts/dev/net-duel.mjs [--only room|paste] [--delay 40] [--signal ws://127.0.0.1:8799]
// Connects through a room code, plays (movement, a hit, a kill, a respawn) and drops the guest;
// then connects again through copy-and-paste codes, plays the same and finishes a first-to-three. Writes shots/net-duel-*.png and exits 1 on any failure.
import { arg, check, clickButton, connectByPastedCodes, connectByRoomCode, finish, hunt, inGame, launch, openPlayer, place, section, shot, startMatch, until, wait } from './net-lib.mjs';

const only = arg('only', '');
const pasteDelay = Number(arg('delay', '0')) * 1000;
const browser = await launch();
const everyone = [];

/** Samples of where `watcher` shows the other player, one per frame, for `ms`. */
function watchRemote(watcher, ms) {
  return watcher.page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const remote = window.__ironvale.game.net.sync.remote;
        const samples = [];
        const start = performance.now();
        const tick = () => {
          const now = performance.now();
          samples.push({ t: now - start, x: remote.position.x, z: remote.position.z });
          if (now - start < duration) requestAnimationFrame(tick);
          else resolve(samples);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

/** Largest speed between two frames, and the distance covered, from position samples. */
function motion(samples) {
  let fastest = 0;
  let path = 0;
  let stalls = 0;
  for (let i = 1; i < samples.length; i++) {
    const step = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    path += step;
    if (dt > 0) fastest = Math.max(fastest, step / dt);
    if (step === 0) stalls++;
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  return { fastest, path, stalls, frames: samples.length, net: Math.hypot(last.x - first.x, last.z - first.z) };
}

const A_SPOT = [0, 0.05, 5];
const B_SPOT = [0, 0.05, -4];
const chest = (spot) => [spot[0], spot[1] + 1.25, spot[2]];

async function faceOff(a, b) {
  await place(a, A_SPOT, chest(B_SPOT));
  await place(b, B_SPOT, chest(A_SPOT));
  await wait(600);
}

async function play(a, b, tag, target = 10) {
  section(`${tag}: both in the match`);
  const config = await inGame(a, (game) => ({ mode: game.config.mode, bots: game.bots.alive, target: game.config.killTarget }));
  check('the match is a duel with no bots', config.mode === 'duel' && config.bots === 0 && config.target === target, JSON.stringify(config));
  const starts = await Promise.all([a, b].map((p) => inGame(p, (game) => [game.player.position.x, game.player.position.z])));
  const apart = Math.hypot(starts[0][0] - starts[1][0], starts[0][1] - starts[1][1]);
  check('the two start far apart', apart > 30, `${apart.toFixed(1)} m`);
  const rtt = await until(a, (game) => game.net.snapshot().rttMs >= 0 && game.net.snapshot().rttMs);
  check('round-trip time is measured', rtt !== null && rtt < 500, `${rtt} ms`);
  await a.page.keyboard.press('Backquote');
  const perf = await a.page.locator('.iv-perf').textContent();
  check('the performance readout shows round-trip time', /rtt \d+ ms/.test(perf ?? ''), (perf ?? '').trim());
  await a.page.keyboard.press('Backquote');

  section(`${tag}: each sees the other move`);
  await faceOff(a, b);
  for (const player of [a, b]) {
    await inGame(player, (game) => {
      window.__heard = { steps: 0, shots: 0, switches: [], actions: 0 };
      game.events.on('footstep', (event) => !event.local && window.__heard.steps++);
      game.events.on('shotFired', (event) => !event.local && window.__heard.shots++);
      game.events.on('weaponSwitch', (event) => !event.local && window.__heard.switches.push(event.weapon.id));
      game.events.on('weaponAction', (event) => !event.local && window.__heard.actions++);
    });
  }
  for (const [mover, watcher] of [
    [b, a],
    [a, b],
  ]) {
    const before = await inGame(mover, (game) => [game.player.position.x, game.player.position.z]);
    const watching = watchRemote(watcher, 2200);
    await wait(150);
    await mover.page.keyboard.down('KeyD');
    await wait(1500);
    await mover.page.keyboard.up('KeyD');
    const samples = await watching;
    await wait(500);
    const after = await inGame(mover, (game) => [game.player.position.x, game.player.position.z]);
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1]);
    const seen = await inGame(watcher, (game) => [game.net.sync.remote.position.x, game.net.sync.remote.position.z]);
    const m = motion(samples);
    check(`${mover.label} walked`, moved > 3, `${moved.toFixed(2)} m`);
    check(`${watcher.label} saw ${mover.label} cover the same ground`, Math.abs(m.net - moved) < 0.8, `saw ${m.net.toFixed(2)} m of ${moved.toFixed(2)} m`);
    // Walking is 4.2 m/s. A teleport or a snap back would show as a far higher speed between two frames.
    check(`${watcher.label} saw smooth movement`, m.fastest < 9 && m.path < moved * 1.25 + 0.5, `fastest ${m.fastest.toFixed(1)} m/s over ${m.frames} frames, path ${m.path.toFixed(2)} m`);
    check(`${watcher.label} ends up showing ${mover.label} where they are`, Math.hypot(seen[0] - after[0], seen[1] - after[1]) < 0.3, `${Math.hypot(seen[0] - after[0], seen[1] - after[1]).toFixed(2)} m off`);
  }

  section(`${tag}: screenshots`);
  await faceOff(a, b);
  await shot(a, `net-duel-${tag}-host`);
  await shot(b, `net-duel-${tag}-guest`);
  const visible = await Promise.all([a, b].map((p) => inGame(p, (game) => game.net.sync.remote.visual.root.visible && game.net.sync.remote.alive)));
  check('each page shows the other soldier alive', visible[0] && visible[1]);

  section(`${tag}: a shot from the host lowers the guest's health on the guest's page`);
  await faceOff(a, b);
  const walkSteps = await Promise.all([a, b].map((p) => inGame(p, () => window.__heard.steps)));
  check('each heard the other walk', walkSteps[0] > 0 && walkSteps[1] > 0, `${walkSteps[0]} and ${walkSteps[1]} footsteps`);
  // One round from the pistol: enough to hurt, not to kill.
  await inGame(a, (game) => {
    game.weapons.debugInput = { slot: 7 };
  });
  const pistol = await until(b, (game) => game.net.sync.remote.weapon === 'm1911' && window.__heard.switches.includes('m1911'), 4000);
  check('the guest saw and heard the host change weapon', pistol === true);
  await until(a, (game) => game.weapons.current.def.id === 'm1911', 4000);
  await wait(400);
  const healthBefore = await inGame(b, (game) => game.player.health);
  // Hold the trigger until the round has left: a semi-automatic fires once per pull however long it is held.
  const fired = await inGame(a, (game) => {
    const before = game.shotsFired;
    game.weapons.debugInput = { fire: true, aim: true };
    return new Promise((resolve) => {
      const started = performance.now();
      const poll = () => {
        if (game.shotsFired > before || performance.now() - started > 4000) {
          game.weapons.debugInput = { fire: false, aim: true };
          resolve(game.shotsFired - before);
        } else requestAnimationFrame(poll);
      };
      poll();
    });
  });
  check('the host fired one round', fired === 1, `${fired} fired`);
  const hurt = await until(b, (game, before) => (game.player.health < before ? { health: game.player.health, alive: game.player.alive } : null), 3000, healthBefore);
  check('the guest lost health and is still alive', hurt !== null && hurt.health < healthBefore && hurt.alive, `${healthBefore} -> ${hurt?.health}`);
  const heard = await inGame(b, () => window.__heard.shots);
  check('the guest heard and saw the shot replayed', heard === 1, `${heard} shot events`);
  await wait(300);
  const hud = await b.page.locator('.iv-health .iv-fig__value').textContent();
  check("the guest's HUD shows the lower health", Number(hud) < 100 && Number(hud) > 0, hud ?? '');
  const aHealth = await inGame(a, (game) => game.player.health);
  check('the host was not hurt by their own shots', aHealth === 100);

  section(`${tag}: a kill counts on both pages`);
  await inGame(a, (game) => {
    game.weapons.debugInput = { slot: 1 };
  });
  await until(a, (game) => game.weapons.current.def.id === 'm4a1', 4000);
  await wait(400);
  await inGame(a, (game) => {
    game.weapons.debugInput = { fire: true, aim: true };
  });
  const dead = await until(b, (game) => !game.player.alive, 8000);
  await inGame(a, (game) => {
    game.weapons.debugInput = { fire: false };
  });
  check('the guest died on their own page', dead === true);
  const hostScore = await until(a, (game) => game.kills === 1 && game.net.snapshot().peerKills === 0, 3000);
  check('the host has one kill', hostScore === true);
  const guestScore = await inGame(b, (game) => ({ kills: game.kills, deaths: game.deaths, peer: game.net.snapshot().peerKills }));
  check('the guest shows the host on one kill', guestScore.peer === 1 && guestScore.deaths === 1 && guestScore.kills === 0, JSON.stringify(guestScore));
  await a.page.waitForTimeout(150);
  const boards = await Promise.all([a, b].map((p) => p.page.locator('.iv-hud__status .iv-fig:not([hidden])').allTextContents()));
  check('the host scoreboard reads Ada 1, Grace 0', boards[0].join(' | ') === `Ada1 | Grace0 | First to${target}`, boards[0].join(' | '));
  check('the guest scoreboard reads Grace 0, Ada 1', boards[1].join(' | ') === `Grace0 | Ada1 | First to${target}`, boards[1].join(' | '));
  const corpse = await inGame(a, (game) => !game.net.sync.remote.alive);
  check('the host sees the guest down', corpse === true);
  const feed = await inGame(a, (game) => game.killFeed.map((entry) => `${entry.killer} > ${entry.victim}`));
  check('the kill feed names the guest', feed.includes('You > Grace'), feed.join(', '));

  section(`${tag}: the guest comes back far from the host`);
  const back = await until(b, (game) => game.player.alive && [game.player.position.x, game.player.position.z], 6000);
  check('the guest respawned', Array.isArray(back));
  const hostAt = await inGame(a, (game) => [game.player.position.x, game.player.position.z]);
  const gap = back ? Math.hypot(back[0] - hostAt[0], back[1] - hostAt[1]) : 0;
  check('at the spawn furthest from the host', gap > 40, `${gap.toFixed(1)} m away`);
  const seenAlive = await until(a, (game, at) => game.net.sync.remote.alive && Math.hypot(game.net.sync.remote.position.x - at[0], game.net.sync.remote.position.z - at[1]) < 0.5, 3000, back);
  check('the host sees the guest alive at the new place', seenAlive === true);
  // Empty the magazine so the reload is sent across.
  await inGame(a, (game) => {
    game.weapons.debugInput = { reload: true };
  });
  const reloadHeard = await until(b, () => window.__heard.actions > 0 && window.__heard.actions, 5000);
  check('the guest heard the host reload', reloadHeard > 0, `${reloadHeard} reload stages`);
  await inGame(a, (game) => {
    game.weapons.debugInput = null;
  });
}

async function disconnect(a, b, tag) {
  section(`${tag}: the guest disconnects`);
  await b.context.close();
  const ended = await until(a, (game) => game.phase === 'won' || game.phase === 'lost', 9000);
  check('the duel ended on the host', ended === true);
  const title = await a.page.locator('.iv-end .iv-title').textContent();
  check('the end screen says who left', title === 'Grace disconnected', title ?? '');
  const lobby = await inGame(a, (game) => ({ step: game.net.state.step, error: game.net.state.error, inMatch: game.net.inMatch }));
  check('the session is closed with a reason', lobby.step === 'idle' && (lobby.error === 'peer-left' || lobby.error === 'peer-timeout') && !lobby.inMatch, JSON.stringify(lobby));
  await shot(a, `net-duel-${tag}-ended`);
  await clickButton(a.page, 'Menu');
  const menu = await until(a, (game) => game.phase === 'menu', 3000);
  check('the host is back at the menu', menu === true);
}

/** The host wins a first-to-three; both see the result, go back to the lobby, and the host leaves. */
async function finishDuel(a, b, tag) {
  section(`${tag}: first to three`);
  for (let kills = 1; kills < 3; kills++) {
    await until(a, (game) => game.net.sync.remote.alive, 6000);
    const name = await hunt(a, { who: 'player' });
    check(`kill ${kills + 1}`, name === 'Grace', name);
  }
  const ended = await Promise.all([a, b].map((p) => until(p, (game) => game.phase === 'won' || game.phase === 'lost', 6000)));
  const phases = await Promise.all([a, b].map((p) => inGame(p, (game) => game.phase)));
  check('the duel ended for both: the host won, the guest lost', ended.every(Boolean) && phases[0] === 'won' && phases[1] === 'lost', phases.join(', '));
  const titles = await Promise.all([a, b].map((p) => p.page.locator('.iv-end .iv-title').textContent()));
  check('each end screen says who won', titles[0] === 'You won the duel' && titles[1] === 'Ada won the duel', titles.join(' / '));
  const scores = await Promise.all([a, b].map((p) => p.page.locator('.iv-end .iv-stat:not([hidden])').allTextContents()));
  check('each end screen shows three to nil', scores[0].join(' | ').startsWith('You3 | Grace0') && scores[1].join(' | ').startsWith('You0 | Ada3'), scores.map((row) => row.join(' | ')).join(' / '));
  await shot(b, `net-duel-${tag}-lost-guest`);
  await wait(5500);
  const still = await Promise.all([a, b].map((p) => inGame(p, (game) => game.net.state.step)));
  check('the connection stays up on the end screen', still.every((step) => step === 'connected'), still.join(', '));
  for (const player of [a, b]) await clickButton(player.page, 'Back to lobby');
  const lobby = await Promise.all([a, b].map((p) => until(p, (game) => game.phase === 'menu' && game.net.state.step === 'connected', 4000)));
  check('both are back in the lobby', lobby.every(Boolean));

  section(`${tag}: the host leaves the lobby`);
  await clickButton(a.page, 'Leave');
  const told = await until(b, (game) => game.net.state.step === 'idle' && game.net.state.error === 'peer-left', 5000);
  await wait(200);
  const message = await b.page.locator('.iv-friend__error').textContent();
  check('the guest is told and what to do next', told === true && message === 'Ada disconnected. Host or join again to play another match.', message ?? '');
  await shot(b, `net-duel-${tag}-left-guest`);
}

if (only !== 'paste') {
  section('room code');
  const host = await openPlayer(browser, 'host');
  const guest = await openPlayer(browser, 'guest');
  everyone.push(host, guest);
  const code = await connectByRoomCode(host, guest);
  check('connected with a room code', /^[A-HJ-NP-Z2-9]{6}$/.test(code), code);
  const names = await Promise.all([host, guest].map((p) => inGame(p, (game) => game.net.state.peerName)));
  check('each knows the other by name', names[0] === 'Grace' && names[1] === 'Ada', names.join(', '));
  await shot(host, 'net-duel-lobby-host');
  await shot(guest, 'net-duel-lobby-guest');
  await startMatch(host, guest, { mode: 'Duel' });
  await play(host, guest, 'room');
  await disconnect(host, guest, 'room');
  await host.context.close();
}

if (only !== 'room') {
  section('copy-and-paste codes');
  const host = await openPlayer(browser, 'host', { rooms: false });
  const guest = await openPlayer(browser, 'guest', { rooms: false });
  everyone.push(host, guest);
  const codes = await connectByPastedCodes(host, guest, ['Ada', 'Grace'], pasteDelay);
  check('connected with pasted codes', codes.invite.startsWith('IVH1.') && codes.reply.startsWith('IVG1.'), `invite ${codes.invite.length} characters, reply ${codes.reply.length}`);
  await startMatch(host, guest, { mode: 'Duel', target: 3 });
  await play(host, guest, 'paste', 3);
  await finishDuel(host, guest, 'paste');
  await host.context.close();
  await guest.context.close();
}

await browser.close();
process.exit(finish(everyone));
