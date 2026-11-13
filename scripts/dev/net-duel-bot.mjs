// A duel where one player has a bot teammate, end to end, in two real Chrome pages on the running dev server.
// Connects with copy-and-paste codes, so no signaling service is needed.
// Usage: node scripts/dev/net-duel-bot.mjs
// Round 1, the bot fights for the guest: both machines put it on the guest's side, neither player's
// own shots hurt their own bot, killing it scores nothing and it comes back, and its kill scores for the guest.
// Round 2, the bot fights for the host: the AI hunts the guest across the network.
// Exits 1 on any failure.
import { check, connectByPastedCodes, finish, hunt, inGame, launch, openPlayer, place, section, startMatch, until, wait } from './net-lib.mjs';

const browser = await launch();
const everyone = [];

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

/** The one bot on the host and its stand-in on the guest. */
const hostBot = (host) =>
  inGame(host, (game) => {
    const bot = game.combat.all().find((c) => c.kind === 'bot' && c.alive);
    return bot ? { id: bot.id, team: bot.team, name: bot.name, health: bot.health, alive: game.bots.alive } : null;
  });
const guestProxy = (guest) =>
  inGame(guest, (game) => {
    const proxy = [...game.net.sync.proxies.values()].find((p) => p.alive);
    return proxy ? { id: proxy.id, team: proxy.team, name: proxy.name, mine: game.player.team } : null;
  });
const scores = (player) => inGame(player, (game) => ({ kills: game.kills, deaths: game.deaths, peer: game.net.snapshot().peerKills }));

{
  section('round 1: the bot fights for the guest');
  const [host, guest] = await connect();
  await host.page.getByRole('radio', { name: 'Duel', exact: true }).filter({ visible: true }).click();
  await host.page.getByRole('radio', { name: 'With friend', exact: true }).filter({ visible: true }).click();
  const summary = await guest.page.locator('.iv-friend__facts').innerText();
  check('the guest\'s lobby says the bot is with them', /Bot teammate\s*With you/.test(summary), summary.replace(/\s+/g, ' '));
  await startMatch(host, guest, { mode: 'Duel', target: 5, bot: 'With friend', difficulty: 'Elite' });

  const config = await inGame(host, (game) => game.config);
  check('the host runs one bot at Elite', config.botCount === 1 && config.difficulty === 'elite', JSON.stringify(config));
  const bot = await until(host, (game) => game.bots.alive === 1 && game.combat.all().find((c) => c.kind === 'bot'), 5000);
  const hb = await hostBot(host);
  const remoteTeam = await inGame(host, (game) => game.net.sync.remote.team);
  check('on the host the bot is on the guest\'s side', Boolean(bot) && hb?.team === remoteTeam && hb?.team !== 'alpha', JSON.stringify({ hb, remoteTeam }));
  const proxy = await until(guest, (game) => [...game.net.sync.proxies.values()].some((p) => p.alive), 5000).then(() => guestProxy(guest));
  check('on the guest the stand-in is on the guest\'s own side', proxy?.team === proxy?.mine && proxy?.name === hb?.name, JSON.stringify(proxy));
  const guestCount = await inGame(guest, (game) => game.bots.alive);
  check('the guest runs no bot of its own', guestCount === 0);

  section('round 1: the guest cannot hurt their own bot');
  // Hold still on the host so the stand-in stops moving, then fire into its chest from three metres.
  const at = await inGame(guest, (game) => {
    const proxy = [...game.net.sync.proxies.values()].find((p) => p.alive);
    return [proxy.position.x, proxy.position.y, proxy.position.z];
  });
  await place(guest, [at[0] + 3, at[1] + 0.05, at[2]], [at[0], at[1] + 1.25, at[2]]);
  await inGame(guest, (game) => (game.weapons.debugInput = { fire: true }));
  await wait(1500);
  await inGame(guest, (game) => (game.weapons.debugInput = { fire: false }));
  const fired = await inGame(guest, (game) => game.weapons.current.magazine < game.weapons.current.def.magazineSize);
  await wait(500);
  const afterFriendly = await hostBot(host);
  check('the guest fires on their own bot and it is untouched on the host', fired && afterFriendly?.health === 100, `fired ${fired}, ${JSON.stringify(afterFriendly)}`);

  section('round 1: killing the bot scores nothing, and it comes back');
  const killed = await hunt(host, { timeout: 15000 });
  check('the host kills the guest\'s bot', killed === hb?.name, killed);
  const gone = await until(guest, (game) => [...game.net.sync.proxies.values()].every((p) => !p.alive) && true, 3000);
  check('the guest sees their bot fall', gone === true);
  const afterBot = await Promise.all([scores(host), scores(guest)]);
  check('no point for killing a bot', afterBot[0].kills === 0 && afterBot[1].peer === 0 && afterBot[1].kills === 0, JSON.stringify(afterBot));
  await inGame(host, (game) => (game.weapons.debugInput = { fire: false }));
  const back = await until(host, (game) => game.bots.alive === 1, 8000);
  check('the bot comes back after a few seconds', back === true);
  const backOnGuest = await until(guest, (game) => [...game.net.sync.proxies.values()].some((p) => p.alive), 5000);
  check('the guest sees it come back', backOnGuest === true);

  section('round 1: the bot\'s kill scores for the guest');
  await inGame(host, (game) => {
    const bot = game.combat.all().find((c) => c.kind === 'bot' && c.alive);
    const me = game.player;
    me.applyDamage({ amount: 500, zone: 'torso', attackerId: bot.id, weaponId: 'm4a1', point: me.position.clone(), direction: me.position.clone().set(0, 0, -1) });
  });
  const tally = await until(guest, (game) => game.kills === 1 && game.kills, 4000);
  const both = await Promise.all([scores(host), scores(guest)]);
  check('the guest scores a point for their bot\'s kill', tally === 1 && both[1].kills === 1, JSON.stringify(both));
  check('the host counts it against themselves and shows the guest on 1', both[0].deaths === 1 && both[0].peer === 1 && both[0].kills === 0, JSON.stringify(both[0]));
  await leave([host, guest]);
}

{
  section('round 2: the bot fights for the host, and hunts the guest');
  const [host, guest] = await connect();
  await startMatch(host, guest, { mode: 'Duel', target: 3, bot: 'With me', difficulty: 'Elite' });
  const hb = await until(host, (game) => game.bots.alive === 1, 5000).then(() => hostBot(host));
  check('on the host the bot is on the host\'s side', hb?.team === 'alpha', JSON.stringify(hb));
  const proxy = await until(guest, (game) => [...game.net.sync.proxies.values()].some((p) => p.alive), 5000).then(() => guestProxy(guest));
  check('on the guest it is an enemy', proxy !== null && proxy.team !== proxy.mine, JSON.stringify(proxy));
  // The host stays out of it, far away; the guest waits in the open near the bot.
  const botAt = await inGame(host, (game) => {
    const bot = game.combat.all().find((c) => c.kind === 'bot' && c.alive);
    return [bot.position.x, bot.position.y, bot.position.z];
  });
  await place(guest, [botAt[0] + 6, botAt[1] + 0.05, botAt[2]], [botAt[0], botAt[1] + 1.2, botAt[2]]);
  const hurt = await until(guest, (game) => (game.player.health < 100 || game.deaths > 0) && { health: game.player.health, deaths: game.deaths }, 20000);
  check('the host\'s bot shoots the guest on the guest\'s machine', Boolean(hurt), JSON.stringify(hurt));
  const down = await until(guest, (game) => game.deaths > 0 && game.deaths, 25000);
  const after = await Promise.all([scores(host), scores(guest)]);
  check('the bot kills the guest and the host scores it', down >= 1 && after[0].kills >= 1 && after[1].peer >= 1, JSON.stringify(after));
  await leave([host, guest]);
}

const code = finish(everyone);
await browser.close();
process.exit(code);
