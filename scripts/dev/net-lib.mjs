// Shared by scripts/dev/net-duel.mjs and net-coop.mjs: two real Chrome pages on the dev server,
// connected to each other through the game's own "Play with a friend" screens.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
export const flag = (name) => process.argv.includes(`--${name}`);
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const port = arg('port', '5311');
const signal = arg('signal', 'ws://127.0.0.1:8799');
const [width, height] = arg('size', '1120x630').split('x').map(Number);

const results = [];
/** Record one assertion. The run fails at the end if any did. */
export function check(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass) });
  process.stdout.write(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  (${detail})`}\n`);
}
export const section = (title) => process.stdout.write(`\n-- ${title}\n`);

export async function launch() {
  await mkdir(join(root, 'shots'), { recursive: true });
  return chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-gpu',
      '--use-angle=metal',
      '--ignore-gpu-blocklist',
      '--hide-scrollbars',
      // Two pages share one headless window: neither may be treated as a background tab.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
}

/**
 * Open one player's page in its own browser context (own storage, own clipboard).
 * `rooms: false` leaves the signaling address out, as in a build with no VITE_SIGNAL_URL.
 */
export async function openPlayer(browser, label, { rooms = true, url = '' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${label} ${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`[${label} pageerror] ${error.message}\n${error.stack ?? ''}`));
  // Other people's edits make the dev server reload the page mid-run. Swallow the hot-reload
  // socket (the signaling socket goes to another port and is left alone).
  await page.routeWebSocket(new RegExp(`^wss?://(127\\.0\\.0\\.1|localhost):${port}/`), () => undefined);
  const query = `dev&q=low${rooms ? `&signal=${encodeURIComponent(signal)}` : ''}`;
  await page.goto(url || `http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
  return { label, context, page, problems };
}

const visible = (page, selector) => page.locator(selector).filter({ visible: true });
export const clickButton = (page, name) => page.getByRole('button', { name, exact: true }).filter({ visible: true }).first().click();

export async function enterFriendScreen(player, name) {
  const { page } = player;
  await clickButton(page, 'Play with a friend');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Your name').blur();
}

/** Host and guest connect with a six-character room code through the local signaling Worker. */
export async function connectByRoomCode(host, guest, names = ['Ada', 'Grace']) {
  await enterFriendScreen(host, names[0]);
  await enterFriendScreen(guest, names[1]);
  // Room codes are offered once the health check has answered.
  await visible(host.page, 'button:has-text("Use copy-and-paste codes instead")').waitFor({ timeout: 10000 });
  await clickButton(host.page, 'Host a game');
  const codeText = visible(host.page, '.iv-friend__room');
  await codeText.waitFor({ timeout: 10000 });
  const code = (await codeText.textContent()).replace('Code', '').trim();
  await visible(guest.page, 'button:has-text("Use copy-and-paste codes instead")').waitFor({ timeout: 10000 });
  await guest.page.getByLabel('Invite link or room code').fill(code.toLowerCase());
  await clickButton(guest.page, 'Join');
  await waitConnected(host, guest);
  return code;
}

/** Host and guest connect with no server: an invite code one way and a reply code back. */
export async function connectByPastedCodes(host, guest, names = ['Ada', 'Grace'], delayMs = 0) {
  await enterFriendScreen(host, names[0]);
  await enterFriendScreen(guest, names[1]);
  await clickButton(host.page, 'Host a game');
  const invite = await readCode(host.page);
  await guest.page.getByLabel('Invite code').fill(invite);
  await clickButton(guest.page, 'Join');
  const reply = await readCode(guest.page);
  // A person takes a while to send the reply back; the guest's side has to wait it out.
  if (delayMs > 0) await wait(delayMs);
  await host.page.getByLabel('Reply code').fill(reply);
  await clickButton(host.page, 'Connect');
  await waitConnected(host, guest);
  return { invite, reply };
}

async function readCode(page) {
  const box = page.getByLabel('Code to send');
  await box.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => window.__ironvale.game.net.state.code !== '', null, { timeout: 15000 });
  return box.inputValue();
}

export async function waitConnected(host, guest) {
  for (const player of [host, guest]) {
    await player.page.waitForFunction(() => window.__ironvale.game.net.state.step === 'connected', null, { timeout: 45000 });
  }
}

/** The host chooses a match in the lobby, the guest presses Ready, the host starts, both wait out the countdown. */
/** `bot` ('With me' or 'With friend') gives one duel player a bot teammate at `difficulty`. */
export async function startMatch(host, guest, { mode, rules = 'Skirmish', difficulty = 'Recruit', enemies = 4, target = 10, bot = '' }) {
  const lobby = host.page;
  // A range input cannot be typed into: set it and announce the change the way dragging does.
  const slide = (label, value) =>
    lobby
      .getByLabel(label)
      .filter({ visible: true })
      .evaluate((input, next) => {
        input.value = String(next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
  await lobby.getByRole('radio', { name: mode, exact: true }).filter({ visible: true }).click();
  await lobby.getByRole('radiogroup', { name: 'Map' }).filter({ visible: true }).getByRole('radio', { name: 'Test Range' }).click();
  if (mode === 'Co-op') {
    await lobby.getByRole('radio', { name: rules, exact: true }).filter({ visible: true }).click();
    await lobby.getByRole('radio', { name: difficulty, exact: true }).filter({ visible: true }).click();
    await slide('Enemies', enemies);
  } else {
    await slide('Kills to win', target);
    if (bot) {
      await lobby.getByRole('radio', { name: bot, exact: true }).filter({ visible: true }).click();
      await lobby.getByRole('radio', { name: difficulty, exact: true }).filter({ visible: true }).click();
    }
  }
  await clickButton(guest.page, 'Ready');
  await visible(lobby, 'button:has-text("Start match"):not([disabled])').waitFor({ timeout: 10000 });
  await clickButton(lobby, 'Start match');
  for (const player of [host, guest]) {
    await player.page.waitForFunction(
      () => {
        const game = window.__ironvale.game;
        const net = game.net.snapshot();
        return net !== null && game.map !== null && !game.net.frozen && net.countdown === 0 && net.notice !== 'waiting-peer';
      },
      null,
      { timeout: 120000 },
    );
    // No pointer lock in a headless page: let the script drive, and close the match menu.
    await player.page.evaluate(() => {
      const game = window.__ironvale.game;
      game.debugControl = true;
      game.resume();
    });
  }
}

/** Run `fn` in the page with the game as its first argument. */
export const inGame = (player, fn, value) => player.page.evaluate(`(${fn.toString()})(window.__ironvale.game, ${JSON.stringify(value ?? null)})`);

export const shot = (player, name) => player.page.screenshot({ path: join(root, 'shots', `${name}.png`) });

/** Put the player somewhere, looking at a point. `y` is feet height. */
export function place(player, position, lookAt) {
  return inGame(
    player,
    (game, { position, lookAt }) => {
      const eye = 1.64;
      const dx = lookAt[0] - position[0];
      const dy = lookAt[1] - (position[1] + eye);
      const dz = lookAt[2] - position[2];
      game.debugPose(position[0], position[1], position[2], Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    },
    { position, lookAt },
  );
}

/**
 * Stand next to one living target, aim at its chest and hold the trigger until it falls.
 * The target is the other player (`who: 'player'`) or an enemy soldier; on a co-op guest the
 * enemies are stand-ins for the host's bots and the hits travel to the host.
 * Resolves with the target's name, 'timeout' or 'none'.
 */
export const hunt = (player, { who = 'enemy', timeout = 25000 } = {}) =>
  inGame(
    player,
    (game, { who, timeout }) =>
      new Promise((resolve) => {
        const standIns = game.net.sync && !game.net.authority;
        const enemies = who === 'player' ? [game.net.sync.remote] : standIns ? [...game.net.sync.proxies.values()] : game.combat.all().filter((c) => c.kind === 'bot');
        const target = enemies.find((enemy) => enemy.alive);
        if (!target) return resolve('none');
        const me = game.player;
        const eye = me.position.clone();
        const chest = me.position.clone();
        const spot = me.position.clone();
        const started = performance.now();
        const input = { fire: true, aim: true };
        game.weapons.debugInput = input;
        const tick = () => {
          if (!target.alive || performance.now() - started > timeout) {
            game.weapons.debugInput = { fire: false };
            return resolve(target.alive ? 'timeout' : target.name);
          }
          const at = target.position;
          chest.set(at.x, at.y + 1.25, at.z);
          // Try the eight compass points three metres out and take the first with room and a clear line.
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
          if (game.weapons.current.magazine === 0) input.reload = true;
          requestAnimationFrame(tick);
        };
        tick();
      }),
    { who, timeout },
  );

/** Poll until `fn` (run in the page with the game) returns something truthy. */
export async function until(player, fn, ms = 10000, value) {
  const end = Date.now() + ms;
  for (;;) {
    const result = await inGame(player, fn, value).catch(() => null);
    if (result || Date.now() > end) return result;
    await wait(100);
  }
}

/** Print what went wrong in the pages and exit with the right code. */
export function finish(players) {
  const problems = [...new Set(players.flatMap((player) => player.problems))];
  process.stdout.write(`\n${problems.length} page problem${problems.length === 1 ? '' : 's'}\n`);
  for (const line of problems.slice(0, 30)) process.stdout.write(`${line.slice(0, 500)}\n`);
  const failed = results.filter((result) => !result.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  for (const result of failed) process.stdout.write(`  failed: ${result.name}\n`);
  return failed.length === 0 ? 0 : 1;
}
