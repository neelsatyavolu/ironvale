// Captures every interface screen from the running dev server (npm run dev) with real GPU rendering.
// Usage: node scripts/dev/ui-shots.mjs [--only menu,keyboard,settings,controls,firstrun,loading,hud,scope,death,end,pause,flow]
//                                      [--size 1600x900] [--tag name] [--map range]
// Writes shots/ui-<screen>[-tag].png and prints console errors from the page.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const only = arg('only', '').split(',').filter(Boolean);
const [width, height] = arg('size', '1600x900').split('x').map(Number);
const tag = arg('tag', '');
const port = arg('port', '5311');
const map = arg('map', 'range');
const pose = arg('pose', '0,0,6,0,0');
const wants = (name) => only.length === 0 || only.includes(name);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
await mkdir(join(root, 'shots'), { recursive: true });
const problems = [];

async function openPage(query, storage = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await context.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
    // Other agents edit files while this runs. A socket that never opens keeps
    // Vite's hot reload from navigating the page in the middle of a capture.
    window.WebSocket = class {
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
    };
  }, storage);
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const from = message.text().startsWith('Failed to load resource') ? ` ${message.location().url}` : '';
    problems.push(`[${message.type()}] ${message.text()}${from}`);
  });
  page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
  await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load', timeout: 30000 });
  await ready(page);
  return { page, context };
}

/** Wait for the game and the web fonts. Other agents' edits can hot-reload the page mid-wait, so retry. */
async function ready(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
      await page.evaluate(() => document.fonts.ready);
      return;
    } catch (error) {
      if (!String(error.message).includes('context was destroyed') || attempt === 3) throw error;
      await page.waitForLoadState('load');
    }
  }
}

async function shot(page, name, settle = 350) {
  await page.waitForTimeout(settle);
  const file = join(root, 'shots', `ui-${name}${tag ? `-${tag}` : ''}.png`);
  await page.screenshot({ path: file });
  process.stdout.write(`${file}\n`);
}

/**
 * Stop the game's own 20 Hz snapshots so forced ones stay on screen, and keep
 * the real emitter so a forced snapshot can start from the true state.
 */
const freezeSnapshots = (page) =>
  page.evaluate(() => {
    const game = window.__ironvale.game;
    if (window.__realEmit) return;
    window.__realEmit = game.emitSnapshot.bind(game);
    game.emitSnapshot = () => {};
  });

/** Send a snapshot through the event bus with some fields forced. Call freezeSnapshots first. */
const forceSnapshot = (page, fields) =>
  page.evaluate((patch) => {
    const game = window.__ironvale.game;
    let real = null;
    // Read the true state without letting the interface see it.
    const handlers = game.events.handlers.get('matchState');
    const saved = [...handlers];
    handlers.clear();
    handlers.add((state) => {
      real = state;
    });
    window.__realEmit();
    handlers.clear();
    for (const handler of saved) handlers.add(handler);
    game.events.emit('matchState', { ...real, phase: 'playing', ...patch });
  }, fields);

// ---- Menu, settings, controls, first run
if (['menu', 'settings', 'controls', 'firstrun', 'keyboard'].some(wants)) {
  const { page, context } = await openPage('', { 'ironvale.firstRun.v1': '{"seen":true}' });
  if (wants('menu')) await shot(page, 'menu');
  if (wants('keyboard')) {
    // Arrow keys alone: up into the options, change difficulty, back to Play.
    for (const key of ['ArrowUp', 'ArrowUp', 'ArrowRight', 'Enter']) await page.keyboard.press(key);
    await shot(page, 'menu-keyboard');
    await page.reload();
    await ready(page);
  }
  if (wants('settings')) {
    await page.getByRole('button', { name: 'Settings' }).click();
    for (const tab of ['Graphics', 'Controls', 'Audio', 'Gameplay']) {
      await page.getByRole('tab', { name: tab }).click();
      if (tab === 'Graphics') {
        await shot(page, 'settings-graphics');
        // One switch off: the preset label must read Custom.
        await page.getByRole('switch', { name: 'Reflections' }).click();
        await shot(page, 'settings-graphics-custom');
        await page.getByRole('switch', { name: 'Reflections' }).click();
      } else await shot(page, `settings-${tab.toLowerCase()}`);
    }
    await page.keyboard.press('Escape');
  }
  if (wants('controls')) {
    await page.getByRole('button', { name: 'Controls', exact: true }).click();
    await shot(page, 'controls-trackpad');
    await page.getByRole('radio', { name: 'Mouse' }).click();
    await shot(page, 'controls-mouse');
    await page.getByRole('radio', { name: 'Trackpad' }).click();
    await page.keyboard.press('Escape');
  }
  await context.close();
  if (wants('firstrun')) {
    const first = await openPage('');
    await first.page.getByRole('button', { name: 'Play', exact: true }).click();
    await shot(first.page, 'firstrun');
    await first.context.close();
  }
}

// ---- Loading
if (wants('loading')) {
  const { page, context } = await openPage('', { 'ironvale.firstRun.v1': '{"seen":true}' });
  await page.evaluate(() => {
    const game = window.__ironvale.game;
    game.events.emit('matchState', {
      phase: 'loading',
      config: { mapId: 'railyard', mode: 'skirmish', difficulty: 'regular', botCount: 8 },
      loadingProgress: 0.42,
      loadingLabel: 'Loading textures and models',
      health: 100,
      weaponName: '',
      fireMode: null,
      magazine: 0,
      reserve: 0,
      reloading: false,
      scopedIn: false,
      kills: 0,
      deaths: 0,
      enemiesRemaining: 0,
      wave: 0,
      elapsed: 0,
      killFeed: [],
    });
    game.emitSnapshot = () => {};
  });
  await shot(page, 'loading');
  await context.close();
}

// ---- In a match
if (['hud', 'scope', 'death', 'end'].some(wants)) {
  const { page, context } = await openPage(`autostart&map=${map}&bots=0&pose=${pose}`);
  await page.waitForTimeout(2500);
  const feed = (elapsed) => [
    { killer: 'You', victim: 'Kessler', weapon: 'm4a1', headshot: true, time: elapsed - 1 },
    { killer: 'Varga', victim: 'Okafor', weapon: 'm249', headshot: false, time: elapsed - 3 },
  ];
  const elapsed = await page.evaluate(() => window.__ironvale.game.time);
  if (wants('hud')) {
    await page.evaluate(() => {
      const game = window.__ironvale.game;
      game.player.name = 'You';
    }).catch(() => {});
    await freezeSnapshots(page);
    await forceSnapshot(page, { enemiesRemaining: 6, kills: 2, killFeed: feed(elapsed), elapsed });
    await shot(page, 'hud');
    // Low health, reloading, a hit marker and damage from the right and behind.
    await forceSnapshot(page, { health: 22, reloading: true, magazine: 0, enemiesRemaining: 3, deaths: 1, elapsed, killFeed: [] });
    await page.evaluate(() => {
      const game = window.__ironvale.game;
      const direction = { x: 1, y: 0, z: 0.2 };
      game.events.emit('playerHurt', { amount: 20, health: 22, direction });
      game.events.emit('playerHurt', { amount: 20, health: 22, direction: { x: -0.3, y: 0, z: 1 } });
      game.events.emit('combatantHit', { weapon: {}, targetId: 999, attackerId: game.player.id, hit: {}, fatal: true });
    });
    await shot(page, 'hud-low', 60);
    // Survival wave with the performance readout on.
    await forceSnapshot(page, {
      config: { mapId: map, mode: 'survival', difficulty: 'veteran', botCount: 8 },
      wave: 3,
      enemiesRemaining: 11,
      elapsed,
    });
    await page.keyboard.press('Backquote');
    await shot(page, 'hud-survival');
    await page.keyboard.press('Backquote');
  }
  if (wants('scope')) {
    await freezeSnapshots(page);
    await forceSnapshot(page, { scopedIn: true, weaponName: 'M24', fireMode: 'bolt', magazine: 5, reserve: 25, elapsed });
    await shot(page, 'scope');
    await forceSnapshot(page, { scopedIn: false, elapsed });
  }
  if (wants('death')) {
    await freezeSnapshots(page);
    await forceSnapshot(page, { health: 0, deaths: 1, elapsed });
    await shot(page, 'death');
    await forceSnapshot(page, { health: 100, elapsed });
  }
  if (wants('end')) {
    await freezeSnapshots(page);
    await page.evaluate(() => {
      const game = window.__ironvale.game;
      const weapon = { id: 'm4a1', name: 'M4A1', pellets: 1 };
      for (let i = 0; i < 61; i++) game.events.emit('shotFired', { shooterId: game.player.id, weapon, local: true });
      for (let i = 0; i < 23; i++) game.events.emit('combatantHit', { weapon, targetId: 999, attackerId: game.player.id, hit: {}, fatal: false });
    });
    await forceSnapshot(page, { phase: 'won', kills: 8, deaths: 1, elapsed: 254 });
    await shot(page, 'end-won');
    await forceSnapshot(page, { phase: 'playing', elapsed: 254 });
    await forceSnapshot(page, {
      phase: 'lost',
      config: { mapId: map, mode: 'survival', difficulty: 'veteran', botCount: 8 },
      wave: 4,
      kills: 31,
      deaths: 1,
      elapsed: 412,
    });
    await shot(page, 'end-lost');
  }
  await context.close();
}

// ---- Pause, with the real game state: resume refused, then granted
if (wants('pause')) {
  // One enemy keeps the match from ending on its first frame.
  const { page, context } = await openPage(`autostart&map=${map}&bots=1&pose=${pose}`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const game = window.__ironvale.game;
    game.events.on('matchState', (state) => {
      window.__phase = state.phase;
    });
    game.pause();
  });
  await shot(page, 'pause');
  await page.getByRole('button', { name: 'Settings' }).click();
  await shot(page, 'pause-settings');
  await page.keyboard.press('Escape');
  // Chrome refuses a lock for about 1.25 s after Escape; a rejecting request stands in for that.
  await page.evaluate(() => {
    const canvas = document.getElementById('view');
    canvas.requestPointerLock = () => Promise.reject(new Error('refused for the test'));
  });
  await page.getByRole('button', { name: 'Resume' }).click();
  await shot(page, 'pause-refused', 900);
  process.stdout.write(`after a refused lock: phase ${await page.evaluate(() => window.__phase)}\n`);
  await page.evaluate(() => {
    delete document.getElementById('view').requestPointerLock;
  });
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.waitForTimeout(700);
  const state = await page.evaluate(() => ({ phase: window.__phase, locked: window.__ironvale.game.input.locked }));
  process.stdout.write(`after a granted lock: phase ${state.phase}, locked ${state.locked}\n`);
  await shot(page, 'pause-resumed');
  await context.close();
}

// ---- The whole path by keyboard: menu, Enter on Play, loading, into the match
if (wants('flow')) {
  const { page, context } = await openPage('', { 'ironvale.firstRun.v1': '{"seen":true}' });
  await page.evaluate((mapId) => {
    const game = window.__ironvale.game;
    game.events.on('matchState', (state) => {
      window.__phase = state.phase;
    });
    // The menu only lists finished maps; send its choice to the test map instead.
    const start = game.startMatch.bind(game);
    game.startMatch = (config) => start({ ...config, mapId, botCount: 1 });
  }, map);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  await shot(page, 'flow-loading', 0);
  await page.waitForFunction(() => window.__phase === 'playing' || window.__phase === 'paused' || window.__phase === 'menu', null, {
    timeout: 90000,
  });
  await page.waitForTimeout(1200);
  const state = await page.evaluate(() => ({ phase: window.__phase, locked: window.__ironvale.game.input.locked }));
  process.stdout.write(`after Play: phase ${state.phase}, locked ${state.locked}\n`);
  await shot(page, 'flow-playing');
  await context.close();

  // A map that cannot load: the menu comes back with the reason.
  const failing = await openPage('', { 'ironvale.firstRun.v1': '{"seen":true}' });
  await failing.page.evaluate(() => {
    const game = window.__ironvale.game;
    const start = game.startMatch.bind(game);
    game.startMatch = (config) => start({ ...config, mapId: 'no-such-map' });
  });
  await failing.page.getByRole('button', { name: 'Play', exact: true }).click();
  await shot(failing.page, 'menu-error', 600);
  await failing.context.close();
}

await browser.close();
const unique = [...new Set(problems)];
process.stdout.write(`problems: ${unique.length}\n`);
for (const line of unique.slice(0, 25)) process.stdout.write(`${line.slice(0, 400)}\n`);
if (unique.length > 25) process.stdout.write(`... ${unique.length - 25} more\n`);
