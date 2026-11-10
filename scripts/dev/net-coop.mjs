// Two-player co-op, end to end, in two real Chrome pages on the running dev server.
// Needs the signaling Worker running locally: cd signaling && npm run dev
// Usage: node scripts/dev/net-coop.mjs [--paste] [--signal ws://127.0.0.1:8799]
// Plays a Skirmish (bots agree on both pages, the guest kills the host's bots, the match is won on
// both), returns to the lobby, plays a Survival (a fallen player rejoins at the next wave), then cuts
// the connection to check that both carry on alone. `--paste` connects with copy-and-paste codes
// instead of a room code. Writes shots/net-coop-*.png and exits 1 on any failure.
import { check, clickButton, connectByPastedCodes, connectByRoomCode, finish, flag, hunt, inGame, launch, openPlayer, place, section, shot, startMatch, until, wait } from './net-lib.mjs';

const paste = flag('paste');
const browser = await launch();
const host = await openPlayer(browser, 'host', { rooms: !paste });
const guest = await openPlayer(browser, 'guest', { rooms: !paste });
const players = [host, guest];

/** Keep the script's players on their feet while bots shoot at them. */
const immortal = (player, on) =>
  inGame(
    player,
    (game, enabled) => {
      clearInterval(window.__heal);
      if (enabled) window.__heal = setInterval(() => game.player.alive && (game.player.health = 100), 50);
    },
    on,
  );

const hostBots = () => inGame(host, (game) => game.combat.all().filter((c) => c.kind === 'bot').map((bot) => ({ id: bot.id, name: bot.name, alive: bot.alive, x: bot.position.x, z: bot.position.z })));
const guestBots = () => inGame(guest, (game) => [...game.net.sync.proxies.values()].map((bot) => ({ id: bot.wireId - 2, name: bot.name, alive: bot.alive, x: bot.position.x, z: bot.position.z, kind: bot.kind, team: bot.team })));
const counts = async () => ({
  host: await inGame(host, (game) => ({ alive: game.bots.alive, kills: game.kills, partnerKills: game.net.partnerKills })),
  guest: await inGame(guest, (game) => ({ alive: game.net.sync.proxiesAlive, shown: game.net.hostMatch?.enemies, kills: game.kills, partnerKills: game.net.partnerKills, real: game.bots.alive })),
});
const agreeOn = async (alive, ms = 4000) => {
  const end = Date.now() + ms;
  let last;
  do {
    last = await counts();
    if (last.host.alive === alive && last.guest.alive === alive && last.guest.shown === alive) return last;
    await wait(150);
  } while (Date.now() < end);
  return last;
};

section(paste ? 'connect with copy-and-paste codes' : 'connect with a room code');
if (paste) await connectByPastedCodes(host, guest);
else await connectByRoomCode(host, guest);
check('connected', true);

// ------------------------------------------------------------------ Skirmish
section('skirmish: the host runs the bots and the guest sees them');
await startMatch(host, guest, { mode: 'Co-op', rules: 'Skirmish', difficulty: 'Recruit', enemies: 4 });
for (const player of players) await immortal(player, true);
const start = await agreeOn(4);
check('four bots on the host, four stand-ins on the guest, and the HUD count agrees', start.host.alive === 4 && start.guest.alive === 4 && start.guest.shown === 4, JSON.stringify(start));
check('the guest runs no bots of its own', start.guest.real === 0);
const roles = await Promise.all([host, guest].map((p) => inGame(p, (game) => ({ authority: game.net.authority, mode: game.config.mode, team: game.net.sync.remote.team, kind: game.net.sync.remote.kind }))));
check('the host has authority and the guest does not', roles[0].authority === true && roles[1].authority === false);
check('the other player is a remote combatant on the same side', roles.every((role) => role.kind === 'remote' && role.team === 'alpha' && role.mode === 'coop'));
const [real, shown] = [await hostBots(), await guestBots()];
check('the stand-ins carry the names of the bots', real.map((bot) => bot.name).sort().join() === shown.map((bot) => bot.name).sort().join(), shown.map((bot) => bot.name).join(', '));
check('the stand-ins are remote combatants on the other side', shown.every((bot) => bot.kind === 'remote' && bot.team === 'bravo'));
await wait(1200);
const [realNow, shownNow] = [await hostBots(), await guestBots()];
const worst = Math.max(...realNow.map((bot) => {
  const twin = shownNow.find((other) => other.id === bot.id);
  return twin ? Math.hypot(twin.x - bot.x, twin.z - bot.z) : 99;
}));
check('each stand-in is where its bot is', worst < 2.5, `furthest ${worst.toFixed(2)} m apart`);
const spawns = await Promise.all(players.map((p) => inGame(p, (game) => [game.player.position.x, game.player.position.z])));
check('the two players do not start inside each other', Math.hypot(spawns[0][0] - spawns[1][0], spawns[0][1] - spawns[1][1]) > 1, spawns.map((s) => s.map((v) => v.toFixed(1)).join(',')).join(' and '));
const targeted = await inGame(host, (game) => game.combat.enemiesOf('bravo').some((c) => c.kind === 'remote'));
check('the bots on the host have the guest among their targets', targeted === true);

section('skirmish: screenshots');
await place(host, [0, 0.05, 5], [0, 1.3, -4]);
await place(guest, [0, 0.05, -4], [0, 1.3, 5]);
await wait(700);
await shot(host, 'net-coop-host');
await shot(guest, 'net-coop-guest');
const sees = await Promise.all(players.map((p) => inGame(p, (game) => game.net.sync.remote.alive && game.net.sync.remote.visual.root.visible)));
check('each sees the other', sees[0] && sees[1]);

section('skirmish: a notice when the other player switches away');
await inGame(guest, () => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
});
const away = await until(host, (game) => game.net.snapshot().notice === 'peer-away', 3000);
await wait(200);
const awayText = await host.page.locator('.iv-net__notice').textContent();
check('the host is told the guest switched away', away === true && awayText === 'Grace has switched away from the game', awayText ?? '');
await inGame(guest, () => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  document.dispatchEvent(new Event('visibilitychange'));
});
check('and that they came back', (await until(host, (game) => game.net.snapshot().notice === null, 3000)) === true);

section('skirmish: a shot from a bot reaches the guest');
await immortal(guest, false);
await inGame(guest, (game) => (game.player.health = 100));
await inGame(host, (game) => {
  const bot = game.combat.all().find((c) => c.kind === 'bot' && c.alive);
  const remote = game.net.sync.remote;
  // Fire the bot's own weapon through the shared ballistics from two metres in front of the guest's chest.
  const muzzle = remote.position.clone();
  muzzle.y += 1.25;
  muzzle.z += 2;
  const direction = remote.position.clone().set(0, 0, -1);
  game.ballistics.fire(bot, bot.weaponDef, muzzle, direction, 0);
});
const wounded = await until(guest, (game) => (game.player.health < 100 ? { health: game.player.health } : null), 3000);
check('the guest lost health on their own page', wounded !== null, `health ${wounded?.health}`);
await immortal(guest, true);

section('skirmish: the guest kills a bot the host is running');
const firstKill = await hunt(guest);
check('the guest brought a stand-in down', typeof firstKill === 'string' && firstKill !== 'timeout' && firstKill !== 'none', firstKill);
const afterOne = await agreeOn(3);
check('three bots left on both pages', afterOne.host.alive === 3 && afterOne.guest.alive === 3 && afterOne.guest.shown === 3, JSON.stringify(afterOne));
check('the kill belongs to the guest on both pages', afterOne.guest.kills === 1 && afterOne.host.partnerKills === 1 && afterOne.host.kills === 0, JSON.stringify(afterOne));
const feed = await inGame(host, (game) => game.killFeed.map((entry) => `${entry.killer} > ${entry.victim}`));
check('the kill feed on the host credits the guest', feed.includes(`Grace > ${firstKill}`), feed.join(', '));

section('skirmish: the host kills one, the guest sees it');
const hostKill = await hunt(host);
check('the host brought a bot down', hostKill !== 'timeout' && hostKill !== 'none', hostKill);
const afterTwo = await agreeOn(2);
check('two bots left on both pages', afterTwo.host.alive === 2 && afterTwo.guest.alive === 2 && afterTwo.guest.shown === 2, JSON.stringify(afterTwo));
check('the guest counts the kill by the host', afterTwo.guest.partnerKills === 1 && afterTwo.host.kills === 1, JSON.stringify(afterTwo));

section('skirmish: clearing the map wins on both pages');
await hunt(guest);
await hunt(guest);
const won = await Promise.all(players.map((p) => until(p, (game) => game.phase === 'won', 6000)));
check('both pages show the match won', won[0] === true && won[1] === true);
const titles = await Promise.all(players.map((p) => p.page.locator('.iv-end .iv-title').textContent()));
check('both end screens say the map is clear', titles.every((title) => title === 'Test Range is clear'), titles.join(' / '));
const finalKills = await Promise.all(players.map((p) => p.page.locator('.iv-end .iv-stat:not([hidden])').allTextContents()));
check('the end screens split the kills three to one', finalKills[0].join(' | ').startsWith('Kills1 | Deaths0 | Kills, Grace3') && finalKills[1].join(' | ').startsWith('Kills3 | Deaths0 | Kills, Ada1'), finalKills.map((row) => row.join(' | ')).join(' / '));
await shot(guest, 'net-coop-won-guest');

section('back to the lobby, still connected');
for (const player of players) await clickButton(player.page, 'Back to lobby');
const lobby = await Promise.all(players.map((p) => until(p, (game) => game.phase === 'menu' && game.net.state.step === 'connected' && !game.net.state.inMatch, 4000)));
check('both are back in the lobby with the connection up', lobby[0] === true && lobby[1] === true);

// ------------------------------------------------------------------ Survival
section('survival: a fallen player rejoins at the next wave');
await startMatch(host, guest, { mode: 'Co-op', rules: 'Survival', difficulty: 'Recruit', enemies: 4 });
for (const player of players) await immortal(player, true);
const wave1 = await agreeOn(4);
check('wave one: four bots on both pages', wave1.host.alive === 4 && wave1.guest.alive === 4, JSON.stringify(wave1));
await immortal(guest, false);
await inGame(guest, (game) => {
  const point = game.player.position.clone();
  game.player.applyDamage({ amount: 500, zone: 'torso', attackerId: -1, weaponId: 'm4a1', point, direction: point.clone().set(0, 0, -1) });
});
const down = await until(host, (game) => game.net.partner && !game.net.partner.alive && game.net.partner.deaths === 1, 3000);
check('the host sees the guest fall', down === true);
await wait(3600);
const waiting = await Promise.all(players.map((p) => inGame(p, (game) => ({ phase: game.phase, alive: game.player.alive }))));
check('the match goes on with the guest down', waiting[0].phase !== 'lost' && waiting[1].phase !== 'lost' && waiting[1].alive === false, JSON.stringify(waiting));
const deathText = await guest.page.locator('.iv-death__next').textContent();
check('the guest is told when they come back', deathText === 'Back when the next wave starts', deathText ?? '');
for (let i = 0; i < 4; i++) await hunt(host);
const wave2 = await until(guest, (game) => game.net.hostMatch?.wave === 2 && game.player.alive, 12000);
check('wave two starts and the guest is back on their feet', wave2 === true);
await immortal(guest, true);
const second = await agreeOn(6);
check('wave two: six bots on both pages', second.host.alive === 6 && second.guest.alive === 6 && second.guest.shown === 6, JSON.stringify(second));
const waves = await Promise.all(players.map((p) => p.page.locator('.iv-hud__status .iv-fig:not([hidden])').allTextContents()));
check('both HUDs show wave 2 and six enemies', waves.every((row) => row.join(' | ').startsWith('Enemies6 | Wave2')), waves.map((row) => row.join(' | ')).join(' / '));

// ------------------------------------------------------------------ losing the connection
section('the connection drops: no state for five seconds');
// Cut the guest's outgoing traffic without telling anyone, as a dead network would.
await inGame(guest, (game) => {
  const link = game.net.link;
  link.sendState = () => undefined;
  link.sendEvent = () => false;
});
const cutAt = Date.now();
const alone = await until(host, (game) => !game.net.inMatch && game.net.snapshot()?.notice === 'peer-timeout', 9000);
const took = (Date.now() - cutAt) / 1000;
check('the host notices after about five seconds', alone === true && took > 4.5 && took < 7.5, `${took.toFixed(1)} s`);
await wait(300);
const hostAfter = await inGame(host, (game) => ({ phase: game.phase, bots: game.bots.alive, remote: game.combat.all().some((c) => c.kind === 'remote'), authority: game.net.authority, session: game.net.state.step, error: game.net.state.error }));
check('the host carries on alone with its bots', (hostAfter.phase === 'playing' || hostAfter.phase === 'paused') && hostAfter.bots === 6 && !hostAfter.remote && hostAfter.authority, JSON.stringify(hostAfter));
const hostNotice = await host.page.locator('.iv-net__notice').textContent();
check('the host is told in plain words', hostNotice === 'The connection to Grace was lost. You are carrying on alone.', hostNotice ?? '');
await shot(host, 'net-coop-alone-host');

const guestAfter = await until(guest, (game) => !game.net.inMatch && game.net.snapshot()?.notice === 'took-over' && { phase: game.phase, bots: game.bots.alive, proxies: game.net.sync?.proxiesAlive ?? 0, authority: game.net.authority }, 9000);
check('the guest takes the enemies over and carries on alone', guestAfter && (guestAfter.phase === 'playing' || guestAfter.phase === 'paused') && guestAfter.bots === 6 && guestAfter.proxies === 0 && guestAfter.authority, JSON.stringify(guestAfter));
const guestNotice = await guest.page.locator('.iv-net__notice').textContent();
check('the guest is told in plain words', guestNotice === 'Ada disconnected. The enemies have regrouped and you are carrying on alone.', guestNotice ?? '');
const soloKill = await hunt(guest);
const soloCount = await inGame(guest, (game) => ({ bots: game.bots.alive, kills: game.kills }));
check('the guest can fight the bots it now runs', soloKill !== 'timeout' && soloKill !== 'none' && soloCount.bots === 5, `${soloKill}, ${JSON.stringify(soloCount)}`);
await shot(guest, 'net-coop-alone-guest');

section('leaving');
await inGame(host, (game) => game.pause());
await clickButton(host.page, 'Quit to menu');
check('the host can quit to the menu', (await until(host, (game) => game.phase === 'menu', 3000)) === true);

await browser.close();
process.exit(finish(players));
