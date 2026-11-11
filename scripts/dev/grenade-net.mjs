// The grenade in two-player matches, end to end, in two real Chrome pages on the running dev server.
// Connects with copy-and-paste codes, so no signaling service is needed.
// Usage: node scripts/dev/grenade-net.mjs [--only duel|coop]
// Duel: the host's grenade is seen, heard about and felt on the guest's machine, and kills the guest.
// Co-op: the guest's grenade kills one of the host's bots, is credited to the guest, and spares the partner.
// Exits 1 on any failure.
import { arg, check, connectByPastedCodes, finish, inGame, launch, openPlayer, place, section, startMatch, until, wait } from './net-lib.mjs';

const only = arg('only', '');
const browser = await launch();
const everyone = [];

/** Record grenade events and deaths in the page. */
const hook = (player) =>
  inGame(player, (game) => {
    game.weapons.debugInput = {};
    const record = { thrown: [], bounces: 0, exploded: [], died: [] };
    window.__nade = record;
    const at = (v) => [v.x, v.y, v.z];
    game.events.on('grenadeThrown', (e) => record.thrown.push({ local: e.local, owner: e.ownerId }));
    game.events.on('grenadeBounced', () => record.bounces++);
    game.events.on('grenadeExploded', (e) => record.exploded.push({ local: e.local, owner: e.ownerId, p: at(e.position) }));
    game.events.on('died', (e) => record.died.push({ victim: e.victimId, killer: e.killerId, weapon: e.weaponId }));
  });
const record = (player) => inGame(player, () => window.__nade);
const hold = (player, on) => inGame(player, (game, value) => (game.weapons.debugInput.grenade = value), on);
/** Where the grenade being aimed will go off. */
const predict = (player) =>
  player.page.evaluate(async () => {
    const game = window.__ironvale.game;
    const math = await import('/src/weapons/grenade-math.ts');
    const hand = game.weapons.grenade;
    if (!hand.aiming) return null;
    const points = new Float32Array(math.GRENADE.maxArcPoints * 3);
    const count = math.predictArc(hand.origin, hand.velocity, game.world, points);
    return [points[(count - 1) * 3], points[(count - 1) * 3 + 1], points[(count - 1) * 3 + 2]];
  });
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

async function connect() {
  const host = await openPlayer(browser, 'host', { rooms: false });
  const guest = await openPlayer(browser, 'guest', { rooms: false });
  everyone.push(host, guest);
  await connectByPastedCodes(host, guest);
  return [host, guest];
}

async function leave(players) {
  for (const player of players) await player.context.close();
}

// Open ground on the test range, clear of the shed and the cover blocks along the line of the throw.
const THROWER = [40, 0.05, 48];
const LOOK = [40, 1.69, 20];

if (only !== 'coop') {
  section('duel: the host throws at the guest');
  const [host, guest] = await connect();
  await startMatch(host, guest, { mode: 'Duel', target: 3 });
  await hook(host);
  await hook(guest);
  const counts = await Promise.all([host, guest].map((p) => inGame(p, (game) => game.weapons.grenade.count)));
  check('each player starts with one grenade', counts[0] === 1 && counts[1] === 1, counts.join(' and '));

  await place(host, THROWER, LOOK);
  await wait(300);
  await hold(host, true);
  await wait(500);
  const end = await predict(host);
  check('the host is aiming', end !== null);
  // The guest stands 1.5 m from where it will stop.
  await place(guest, [end[0] + 1.5, 0.05, end[2]], THROWER);
  await wait(800);
  const guestSees = await inGame(guest, (game) => game.weapons.grenade.aiming);
  check('aiming is local: the guest is not shown as aiming', guestSees === false);
  await hold(host, false);

  const boom = await until(guest, () => window.__nade.exploded.length > 0 && window.__nade, 8000);
  await wait(500);
  const h = await record(host);
  const g = boom ?? (await record(guest));
  check('the guest sees the throw', g.thrown.length === 1 && g.thrown[0].local === false, JSON.stringify(g.thrown));
  check('the guest hears it bounce', g.bounces >= 1, `${g.bounces} on the guest, ${h.bounces} on the host`);
  check('the guest sees the blast, as the host\'s', g.exploded.length === 1 && g.exploded[0].local === false);
  const apart = h.exploded[0] && g.exploded[0] ? distance(h.exploded[0].p, g.exploded[0].p) : Infinity;
  check('both machines put the blast in the same place', apart < 0.05, `${apart.toFixed(3)} m apart`);
  check('it went off where the host\'s arc said', h.exploded[0] && distance(h.exploded[0].p, end) < 0.05);

  const guestState = await until(guest, (game) => !game.player.alive && { deaths: game.deaths, id: game.player.id, remote: game.net.sync.remote.id }, 3000);
  check('the guest, 1.5 m away, is killed', Boolean(guestState));
  check(
    'the guest\'s machine puts the death down to the host\'s grenade',
    guestState && g.died.concat((await record(guest)).died).some((d) => d.victim === guestState.id && d.killer === guestState.remote && d.weapon === 'grenade'),
  );
  const hostState = await until(host, (game) => game.kills === 1 && { kills: game.kills, health: game.player.health, count: game.weapons.grenade.count, feed: window.__nade.died }, 3000);
  check('the host is credited with the kill', Boolean(hostState), JSON.stringify(hostState));
  check('the host has no grenade left and is unhurt', hostState && hostState.count === 0 && hostState.health === 100);
  const peer = await inGame(guest, (game) => game.net.snapshot().peerKills);
  check('the guest\'s score line shows the host\'s kill', peer === 1, `${peer}`);

  section('duel: one grenade each is enforced on the receiving side');
  await until(guest, (game) => game.player.alive, 8000);
  await inGame(host, (game, at) => game.net.sync.link.sendEvent({ t: 'nade', p: [at[0], 1.5, at[2]], v: [0, 3, -15] }), THROWER);
  await wait(600);
  const again = await record(guest);
  check('a second throw from the same player is ignored', again.thrown.length === 1, `${again.thrown.length} throws seen`);
  const shown = await inGame(guest, (game) => game.grenades.flights.filter((flight) => flight.active).length);
  check('no grenade is in flight on the guest', shown === 0);
  await leave([host, guest]);
}

if (only !== 'duel') {
  section('co-op: the guest throws at one of the host\'s enemies');
  const [host, guest] = await connect();
  await startMatch(host, guest, { mode: 'Co-op', rules: 'Skirmish', difficulty: 'Recruit', enemies: 2 });
  // The host's enemies stand still for the test.
  await inGame(host, (game) => (game.bots.update = () => {}));
  await hook(host);
  await hook(guest);
  await place(guest, THROWER, LOOK);
  await wait(300);
  await hold(guest, true);
  await wait(500);
  const end = await predict(guest);
  check('the guest is aiming', end !== null);
  // One enemy 1.5 m from where it will stop, the other well away; the host stands 2 m from it on the other side.
  const placed = await inGame(
    host,
    (game, target) => {
      const bots = game.combat.all().filter((c) => c.kind === 'bot' && c.alive);
      bots[0].position.set(target[0] + 1.5, 0.05, target[2]);
      bots[1]?.position.set(target[0] - 40, 0.05, target[2] - 40);
      return { near: bots[0].id, count: bots.length };
    },
    end,
  );
  await place(host, [end[0] - 2, 0.05, end[2]], [end[0], 0.5, end[2]]);
  await wait(1200);
  await hold(guest, false);

  const seen = await until(host, () => window.__nade.exploded.length > 0 && window.__nade, 8000);
  await wait(600);
  const h = await record(host);
  const g = await record(guest);
  check('the host sees the guest\'s throw and blast', Boolean(seen) && h.thrown.length === 1 && h.thrown[0].local === false && h.exploded[0]?.local === false);
  const apart = h.exploded[0] && g.exploded[0] ? distance(h.exploded[0].p, g.exploded[0].p) : Infinity;
  check('both machines put the blast in the same place', apart < 0.05, `${apart.toFixed(3)} m apart`);
  const hostAfter = await inGame(
    host,
    (game, id) => ({
      botAlive: game.combat.get(id)?.alive ?? false,
      remote: game.net.sync.remote.id,
      partnerKills: game.net.partnerKills,
      health: game.player.health,
      kills: game.kills,
    }),
    placed.near,
  );
  check('the enemy 1.5 m from the blast dies on the host', hostAfter.botAlive === false);
  check(
    'the host puts the kill down to the guest\'s grenade',
    h.died.some((d) => d.victim === placed.near && d.killer === hostAfter.remote && d.weapon === 'grenade') && hostAfter.partnerKills === 1 && hostAfter.kills === 0,
    JSON.stringify(h.died),
  );
  check('the host, 2 m from a partner\'s blast, is unhurt', hostAfter.health === 100, `health ${hostAfter.health}`);
  const guestAfter = await until(guest, (game) => game.kills === 1 && { kills: game.kills, count: game.weapons.grenade.count }, 3000);
  check('the guest is credited with the kill and has no grenade left', guestAfter && guestAfter.count === 0, JSON.stringify(guestAfter));
  const hostCount = await inGame(host, (game) => game.weapons.grenade.count);
  check('the host still has their own grenade', hostCount === 1);
  await leave([host, guest]);
}

const code = finish(everyone);
await browser.close();
process.exit(code);
