// Drives the Mac app end to end and prints what it measured.
// Usage: node scripts/dev/app-check.mjs [--app path/to/Ironvale.app] [--port 5391] [--skip fullscreen,webgl,blur,sounds]
//        [--wait-idle 20] waits (up to --idle-max 180 seconds) until nobody has touched the Mac for that long
//        before it brings the app forward
//        [--front-max 600] keeps trying for that many seconds to bring the app forward (default: one try)
//        [--no-input] stays in the background: never comes forward, never touches the pointer or keyboard.
//        Checks the webview, sounds, fonts, policy and a silent railyard match (frames stepped by hand, since a
//        hidden window gets none) and then stops.
//        It cannot check the pointer grab, keys, audio after a click, or full screen.
// Needs a debug bundle (the dev bridge is compiled only into debug builds):
//   npx vite build && node scripts/dev/app-stage.mjs
//   CARGO_BUILD_JOBS=6 nice -n 15 npx tauri build --debug --bundles app -c '{"build":{"beforeBuildCommand":""}}'
// The terminal needs Accessibility (to post clicks and keys) and Screen Recording (for screenshots).
// It brings the app to the front and takes the keyboard and pointer for about a minute.
// Screenshots go to shots/app-*.png.
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const app = arg('app', join(root, 'src-tauri/target/debug/bundle/macos/Ironvale.app'));
const port = Number(arg('port', '5391'));
/** The dev bridge answers only requests that carry this. */
const token = randomUUID();
const skip = new Set(arg('skip', '').split(',').filter(Boolean));
const waitIdle = Number(arg('wait-idle', '0'));
const idleMax = Number(arg('idle-max', '180'));
const frontMax = Number(arg('front-max', '0'));
const noInput = process.argv.includes('--no-input');
const helper = join(root, 'src-tauri/target/app-input');
const shots = join(root, 'shots');
const BUNDLE_ID = 'co.xanom.ironvale';
const KEY = { w: 13, space: 49, tab: 48, escape: 53, digit1: 18, digit2: 19, digit3: 20, p: 35, f11: 103 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {};
const note = (key, value) => {
  report[key] = value;
  process.stdout.write(`${key}: ${JSON.stringify(value)}\n`);
};

async function bridge(path, body) {
  const headers = { 'x-devbridge-token': token };
  const response = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? { headers } : { method: 'POST', body, headers });
  return response.json();
}
/** Runs the body of an async function in the game's page. */
async function page(code) {
  const result = await bridge('/eval', code);
  if (!result.ok) throw new Error(`page: ${result.error}`);
  return result.value;
}
const windowState = () => bridge('/window');
async function until(what, check, timeout = 30000, step = 100) {
  const start = Date.now();
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return { value, ms: Date.now() - start };
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}
async function native(...args) {
  const { stdout } = await run(helper, args.map(String));
  return stdout.trim();
}
const cursor = async () => JSON.parse(await native('cursor'));

let pid = 0;
async function frontmost() {
  return Number(await native('frontmost')) === pid;
}
/**
 * Started from a background script, the app opens behind whatever is in use, and macOS (14 and
 * later) ignores its own and outside requests to come forward. Asking Finder to open it counts as
 * the user asking. Even then the app in front can take the front straight back (seen with a
 * full-screen browser in use), so this checks that the front is held, and with --front-max keeps
 * trying every half minute instead of fighting for it.
 */
async function toFront() {
  const holdsFront = async () => {
    if (!(await frontmost())) return false;
    await sleep(800);
    return frontmost();
  };
  const start = Date.now();
  let tries = 0;
  for (;;) {
    if (await holdsFront()) return { tries, waitedSeconds: Math.round((Date.now() - start) / 1000) };
    const building = await run('pgrep', ['-x', 'rustc']).then(() => true, () => false);
    if (!building) {
      tries++;
      await run('osascript', ['-e', `tell application "Finder" to open POSIX file "${app}"`]);
      await sleep(300);
      if (await holdsFront()) return { tries, waitedSeconds: Math.round((Date.now() - start) / 1000) };
    }
    if (Date.now() - start > frontMax * 1000) {
      const other = await run('osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true']).then((r) => r.stdout.trim(), () => 'unknown');
      throw new Error(`Ironvale could not come to the front and stay there after ${tries} tries (${other} holds it). Run this script from a terminal you are using, with no full-screen app in front.`);
    }
    await sleep(30000);
  }
}
async function needFront(action) {
  if (await frontmost()) return;
  const other = await run('osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true']).then((r) => r.stdout.trim(), () => 'unknown');
  throw new Error(`Ironvale is not the frontmost app (${other} is, last input ${Number(await native('idle')).toFixed(1)} s ago); stopped before ${action} so nothing lands elsewhere`);
}
/** A real click on the middle of the first element the expression returns. */
async function click(expression, label) {
  const rect = await page(`const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];`);
  if (!rect) throw new Error(`nothing to click: ${label}`);
  const state = await windowState();
  await needFront(`clicking ${label}`);
  await native('click', pid, state.innerPosition[0] / state.scaleFactor + rect[0], state.innerPosition[1] / state.scaleFactor + rect[1]);
}
async function key(code, hold = 60) {
  await needFront('a key press');
  await native('key', pid, code, hold);
}
async function shot(name) {
  const { id } = JSON.parse(await native('window', pid));
  const file = join(shots, `${name}.png`);
  await run('screencapture', ['-x', '-o', '-l', String(id), file]);
  return file;
}
const game = (expression) => page(`const game = window.__ironvale.game; return ${expression};`);
const grabFacts = async () => {
  const [state, pointer, locked] = [await windowState(), await cursor(), await game('game.input.locked')];
  const centre = [
    state.innerPosition[0] / state.scaleFactor + state.innerSize[0] / state.scaleFactor / 2,
    state.innerPosition[1] / state.scaleFactor + state.innerSize[1] / state.scaleFactor / 2,
  ];
  return {
    pageLocked: locked,
    appHoldsGrab: state.grabHeld,
    cursorVisible: pointer.visible,
    cursorOffCentrePx: [Math.round(pointer.x - centre[0]), Math.round(pointer.y - centre[1])],
  };
};

/** Three seconds of frames in the match. */
const frames = async () =>
  page(`
    const game = window.__ironvale.game; const samples = []; let frames = 0;
    const start = performance.now(); let last = start; let worst = 0;
    await new Promise((done) => { const tick = (now) => { frames++; worst = Math.max(worst, now - last); last = now; if (now - start < 3000) requestAnimationFrame(tick); else done(); }; requestAnimationFrame(tick); });
    const elapsed = performance.now() - start;
    return { fps: +(frames / (elapsed / 1000)).toFixed(1), meanFrameMs: +(elapsed / frames).toFixed(2), worstFrameMs: +worst.toFixed(1), engineFrameMs: +game.engine.frameTimeMs.toFixed(2), renderScale: +game.engine.renderScale.toFixed(2), webgpu: game.engine.isWebGPU, tier: game.settings.value.graphics.tier ?? null, canvas: [document.getElementById('view').width, document.getElementById('view').height] };`);

async function main() {
  await mkdir(shots, { recursive: true });
  if (!noInput) await stat(helper).catch(() => execFileSync('swiftc', ['-O', join(root, 'scripts/dev/app-input.swift'), '-o', helper], { stdio: 'inherit' }));

  // 1. Launch. Started from a script, the app opens behind whatever is in use, which suits the first
  // checks: they need no window on screen.
  const launched = Date.now();
  await run('open', [noInput ? '-gn' : '-n', app, '--env', `IRONVALE_DEVBRIDGE_PORT=${port}`, '--env', `IRONVALE_DEVBRIDGE_TOKEN=${token}`]);
  const first = await until('the dev bridge', async () => ((await windowState()).ok ? await windowState() : null), 20000, 50);
  pid = first.value.pid;
  note('bridgeUpMs', Date.now() - launched);
  await until('the menu', () => page('return !!(window.__ironvale && (window.__ironvale.ready || window.__ironvale.error));'), 60000);
  note('menuReadyMs', Date.now() - launched);
  // Silent: whoever is using this Mac did not ask for gunfire. The saved settings are put back at the end.
  if (noInput) await page(`window.__savedSettings = localStorage.getItem('ironvale.settings.v1'); window.__ironvale.game.settings.update('audio', { master: 0 });`);

  let inView = true;
  if (noInput) {
    // A webview that is out of view (another Space, or covered) draws no frames, and some of what
    // follows then never answers. Wait for whoever is using the Mac to pass through its Space.
    const waited = await until('the window to be in view', () => page(`return document.visibilityState === 'visible';`), 600000, 500).then((r) => r.ms, () => null);
    inView = waited !== null;
    note('waitedForViewMs', waited ?? 'never in view: the match is skipped, because it cannot load without frames');
  }

  // 2. What the webview gives the page.
  note(
    'page',
    await page(`
      await document.fonts.ready;
      const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
      const game = window.__ironvale.game;
      return {
        error: window.__ironvale.error,
        origin: location.origin,
        userAgent: navigator.userAgent,
        tauri: '__TAURI_INTERNALS__' in window,
        shell: document.documentElement.dataset.platform ?? null,
        navigatorGpu: 'gpu' in navigator,
        adapter: adapter ? { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture } : null,
        gameUsesWebGPU: game.engine.isWebGPU,
        backendLabel: [...document.querySelectorAll('.iv-label')].map((e) => e.textContent).filter((t) => /WebG/.test(t))[0] ?? null,
        devicePixelRatio,
        viewport: [innerWidth, innerHeight],
        canvas: [document.getElementById('view').width, document.getElementById('view').height],
        fontsLoaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', '') + ' ' + f.weight),
        fontChecks: ['15px Geist', '15px "Geist Mono"', '24px Newsreader'].map((f) => document.fonts.check(f)),
        titleFont: getComputedStyle(document.querySelector('.iv-display')).fontFamily.split(',')[0],
        pointerLockApi: typeof document.getElementById('view').requestPointerLock,
      };`),
  );
  // 3. Every bundled sound decodes in this webview.
  if (!skip.has('sounds')) {
    const names = (await readdir(join(root, 'public/assets/local/sounds'))).filter((name) => !name.startsWith('.'));
    note(
      'sounds',
      await page(`
        const names = ${JSON.stringify(names)};
        const context = new AudioContext();
        const failed = []; let seconds = 0; let bytes = 0;
        for (const name of names) {
          try {
            const response = await fetch('./assets/local/sounds/' + name);
            if (!response.ok || !/audio|octet/.test(response.headers.get('content-type') ?? '')) throw new Error('HTTP ' + response.status + ' ' + response.headers.get('content-type'));
            const data = await response.arrayBuffer(); bytes += data.byteLength;
            const buffer = await context.decodeAudioData(data);
            if (!(buffer.duration > 0)) throw new Error('empty');
            seconds += buffer.duration;
          } catch (error) { failed.push(name + ': ' + (error?.message ?? error)); }
        }
        return { files: names.length, decoded: names.length - failed.length, failed, totalSeconds: +seconds.toFixed(1), megabytes: +(bytes / 1e6).toFixed(1), contextState: context.state };`),
    );
  }

  note('bootLog', await page('return [...new Set(window.__devlog)].slice(0, 40);'));
  if (noInput && !inView) {
    note('pageLog', await page('return [...new Set(window.__devlog)].slice(0, 40);'));
    await page(`const saved = window.__savedSettings; if (saved === null) localStorage.removeItem('ironvale.settings.v1'); else localStorage.setItem('ironvale.settings.v1', saved);`);
    await run('kill', [String(pid)]);
    process.exitCode = 1;
    return;
  }
  if (noInput) {
    note('background', await page(`
      const game = window.__ironvale.game;
      // A window on another Space or behind other windows gets no requestAnimationFrame, and the
      // match needs frames to load. Step them by message instead, each after the GPU has finished
      // the one before, so the time per frame is the work per frame with no display to wait for.
      const device = game.engine.renderer.backend.device;
      const channel = new MessageChannel();
      const waiting = new Map();
      let next = 1; let frames = 0; let stepping = true;
      channel.port1.onmessage = (e) => { const cb = waiting.get(e.data); waiting.delete(e.data); if (cb) cb(performance.now()); };
      const real = [window.requestAnimationFrame, window.cancelAnimationFrame];
      window.requestAnimationFrame = (cb) => {
        const id = next++; waiting.set(id, cb); frames++;
        if (stepping) device.queue.onSubmittedWorkDone().then(() => channel.port2.postMessage(id));
        return id;
      };
      window.cancelAnimationFrame = (id) => waiting.delete(id);
      game.engine.stop(); game.engine.start();
      const turn = () => new Promise((done) => { const c = new MessageChannel(); c.port1.onmessage = done; c.port2.postMessage(0); });
      // A hidden window can stall even stepped frames, so the numbers only count if it stayed visible.
      let hiddenSeen = document.visibilityState !== 'visible';
      document.addEventListener('visibilitychange', () => { hiddenSeen = true; });
      const marks = [];
      const progress = game.progress.bind(game);
      try {
        const started = performance.now();
        game.progress = (fraction, label) => { marks.push([Math.round(performance.now() - started), label]); return progress(fraction, label); };
        await game.startMatch({ mapId: 'railyard', mode: 'skirmish', difficulty: game.settings.value.gameplay.difficulty, botCount: 8 });
        const matchLoadMs = Math.round(performance.now() - started);
        game.player.health = 1e6;
        await new Promise((done) => setTimeout(done, 1500));
        const samples = []; const from = performance.now(); const first = frames;
        let last = from; let seen = frames;
        while (performance.now() - from < 4000) {
          await turn();
          if (frames === seen) continue;
          const now = performance.now(); samples.push((now - last) / (frames - seen)); last = now; seen = frames;
        }
        const elapsed = performance.now() - from;
        samples.sort((a, b) => a - b);
        return {
          windowStayedVisible: !hiddenSeen, loadSteps: marks.filter((mark, i) => mark[1] !== marks[i - 1]?.[1]),
          matchLoadMs, phase: game.phase, map: game.config.mapId, botsAlive: game.bots.alive, webgpu: game.engine.isWebGPU,
          steppedFrames: frames - first, meanFrameMs: frames > first ? +(elapsed / (frames - first)).toFixed(2) : null,
          p95FrameMs: samples.length ? +samples[Math.floor(samples.length * 0.95)].toFixed(2) : null, worstFrameMs: samples.length ? +samples[samples.length - 1].toFixed(1) : null,
          engineFrameMs: +game.engine.frameTimeMs.toFixed(2), renderScale: +game.engine.renderScale.toFixed(2),
          tier: game.settings.value.graphics.tier ?? null, canvas: [document.getElementById('view').width, document.getElementById('view').height],
          documentVisibility: document.visibilityState, pageLocked: game.input.locked,
          audio: game.audio.debug ? { state: game.audio.debug.context.state, decoded: game.audio.debug.decoded.length, mapReady: game.audio.debug.mapReady } : null,
        };
      } finally {
        stepping = false;
        [window.requestAnimationFrame, window.cancelAnimationFrame] = real;
        game.progress = progress;
        game.engine.stop(); game.engine.start();
      }`));
    // With the window in view the display drives the frames again: the figures a player would see.
    if ((await page('return document.visibilityState;')) === 'visible') note('framesOnDisplay', await frames());
    const state = await windowState();
    note('windowAfter', { focused: state.focused, visible: state.visible, appHoldsGrab: state.grabHeld });
    note('pageLog', await page('return [...new Set(window.__devlog)].slice(0, 40);'));
    await page(`const saved = window.__savedSettings; if (saved === null) localStorage.removeItem('ironvale.settings.v1'); else localStorage.setItem('ironvale.settings.v1', saved);`);
    await run('kill', [String(pid)]);
    return;
  }
  await page(`localStorage.setItem('ironvale.menu.v1', JSON.stringify({ mapId: 'harbor', mode: 'skirmish', botCount: 4 })); setTimeout(() => location.reload(), 50);`);
  await sleep(600);
  await until('the menu after reload', () => page('return !!(window.__ironvale && window.__ironvale.ready);'), 60000);

  // 4. Everything from here needs the app in front. Someone may be working on this Mac: say what is
  // about to happen, and wait for a pause if asked to.
  if (waitIdle > 0) {
    const waited = await until(`${waitIdle} s without input`, async () => Number(await native('idle')) >= waitIdle, idleMax * 1000, 1000).then((r) => r.ms, () => null);
    note('waitedForIdleMs', waited ?? `gave up after ${idleMax} s and went ahead`);
  }
  await run('osascript', ['-e', 'display notification "Bringing Ironvale to the front and taking the pointer for about a minute." with title "Ironvale app check"']).catch(() => null);
  const foreground = Date.now();
  note('cameForward', await toFront());
  await until('a window on screen', async () => native('window', pid), 10000, 50);
  await until('the window to have focus', async () => (await windowState()).focused, 5000);
  note('window', await windowState());
  await sleep(700);
  note('menuShot', await shot('app-menu'));
  const menus = await run('osascript', [
    '-e',
    `tell application "System Events" to tell (first process whose unix id is ${pid}) to get {name, name of menu items of menu 1} of menu bar items 2 thru -1 of menu bar 1`,
  ]).then((r) => r.stdout.trim(), (error) => `could not read the menu bar: ${error.message.split('\n')[0]}`);
  note('menuBar', menus);

  // 5. Start a match on railyard with real clicks: the first click must unlock audio and take the pointer.
  note('audioBeforeGesture', await game(`game.audio.debug ? game.audio.debug.context.state : 'no context yet'`));
  await click(`[...document.querySelectorAll('[role=radio]')].find((e) => /railyard/i.test(e.textContent))`, 'the Railyard card');
  await sleep(150);
  note('railyardChosen', await page(`return [...document.querySelectorAll('[role=radio][aria-checked=true]')].map((e) => e.querySelector('.iv-map__name')?.textContent);`));
  const visiblePlay = `[...document.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Play' && e.offsetParent !== null && !e.closest('[hidden]'))`;
  const started = Date.now();
  await click(visiblePlay, 'Play');
  await sleep(300);
  if ((await game('game.phase')) === 'menu') {
    note('firstRunScreen', true);
    await click(visiblePlay, 'Play on the first-run screen');
  }
  await until('the match', () => game(`game.phase === 'playing' || game.phase === 'paused'`), 120000, 200);
  note('matchLoadMs', Date.now() - started);
  await game(`(game.player.health = 1e6, game.phase)`); // the check should not end because a bot shot the tester
  await sleep(1500);
  note('afterStart', { phase: await game('game.phase'), map: await game('game.config.mapId'), ...(await grabFacts()) });
  note('audioAfterGesture', await game(`game.audio.debug ? { state: game.audio.debug.context.state, sampleRate: game.audio.debug.context.sampleRate, decoded: game.audio.debug.decoded.length, mapReady: game.audio.debug.mapReady } : null`));

  // 6. Mouse look: relative movement must reach the page while the cursor is frozen.
  await page(`
    const m = (window.__look = { events: 0, sumX: 0, sumY: 0, zero: 0, maxAbs: 0 });
    document.addEventListener('mousemove', (e) => {
      m.events++; m.sumX += e.movementX; m.sumY += e.movementY;
      if (e.movementX === 0 && e.movementY === 0) m.zero++;
      m.maxAbs = Math.max(m.maxAbs, Math.abs(e.movementX), Math.abs(e.movementY));
    });`);
  const look = async (label, dx, dy, count, ...rest) => {
    await page(`Object.assign(window.__look, { events: 0, sumX: 0, sumY: 0, zero: 0, maxAbs: 0 });`);
    const before = await game(`[game.player.yaw, game.player.pitch]`);
    const cursorBefore = await cursor();
    await needFront('mouse movement');
    await native('move', pid, dx, dy, count, 8, ...rest);
    await sleep(400);
    const after = await game(`[game.player.yaw, game.player.pitch]`);
    const cursorAfter = await cursor();
    note(label, {
      sent: { dx: dx * count, dy: dy * count, events: count },
      received: await page('return window.__look;'),
      yawDeg: +(((after[0] - before[0]) * 180) / Math.PI).toFixed(3),
      pitchDeg: +(((after[1] - before[1]) * 180) / Math.PI).toFixed(3),
      cursorMovedPx: [Math.round(cursorAfter.x - cursorBefore.x), Math.round(cursorAfter.y - cursorBefore.y)],
    });
  };
  note('sensitivity', await game(`({ preset: game.settings.value.controls.preset, sensitivity: game.settings.value.controls.sensitivity, smoothing: game.settings.value.controls.lookSmoothing })`));
  await look('lookRightToProcess', 4, 0, 50);
  await look('lookRightSystemStream', 4, 0, 50, 'hid');
  await look('lookUpSystemStream', 0, -3, 40, 'hid');

  // 7. Keys reach the page, and the page claims them (an unclaimed key makes WKWebView beep).
  await page(`window.__keys = []; window.addEventListener('keydown', (e) => window.__keys.push(e.code + (e.defaultPrevented ? ':claimed' : ':UNCLAIMED')));`);
  const position = await game(`game.player.position.toArray()`);
  await key(KEY.w, 700);
  await sleep(200);
  const moved = await game(`game.player.position.toArray()`);
  const weapon = await game(`game.weapons.current.def.name`);
  for (const code of [KEY.digit2, KEY.digit1, KEY.digit3, KEY.tab, KEY.space]) {
    await key(code, 120);
    await sleep(350);
  }
  note('keys', {
    walkedMetres: +Math.hypot(moved[0] - position[0], moved[2] - position[2]).toFixed(2),
    weaponBefore: weapon,
    weaponAfter: await game(`game.weapons.current.def.name`),
    shotsFired: await game(`game.shotsFired`),
    seenByPage: await page('return window.__keys;'),
  });

  // 8. Frame time in the match.
  note('framesWindowed', await frames());
  note('matchShot', await shot('app-railyard'));

  // 9. Escape: nothing but the page can release the grab.
  await key(KEY.escape);
  await sleep(500);
  note('afterEscape', { phase: await game('game.phase'), ...(await grabFacts()) });
  note('pauseShot', await shot('app-paused'));
  await click(`[...document.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Resume' && e.offsetParent !== null)`, 'Resume');
  await sleep(600);
  note('afterResume', { phase: await game('game.phase'), ...(await grabFacts()) });

  // 10. Full screen: in by the menu item, out by F11. The grab must survive and stay centred.
  if (!skip.has('fullscreen')) {
    const toggle = async (label, how) => {
      await needFront(label);
      await how();
      await sleep(2500);
      const state = await windowState();
      note(label, { fullscreen: state.fullscreen, innerSize: state.innerSize, ...(await grabFacts()) });
    };
    const menuItem = () =>
      run('osascript', ['-e', `tell application "System Events" to tell (first process whose unix id is ${pid}) to click (first menu item of menu 1 of menu bar item "View" of menu bar 1 whose name contains "Full Screen")`]);
    await toggle('fullscreenByMenu', menuItem);
    note('framesFullscreen', await frames());
    note('fullscreenShot', await shot('app-fullscreen'));
    await toggle('windowedByF11', () => key(KEY.f11));
  }

  // 11. WebGL 2 fallback, as older systems get.
  if (!skip.has('webgl')) {
    note('matchLog', await page('return [...new Set(window.__devlog)].slice(0, 40);'));
    await page(`setTimeout(() => (location.href = location.origin + '/?webgl&autostart&map=railyard&bots=0'), 50);`);
    await sleep(600);
    await until('the WebGL 2 match', () => page('return !!(window.__ironvale && (window.__ironvale.ready || window.__ironvale.error));'), 120000, 200);
    await sleep(2500);
    note('webgl2', { error: await page('return window.__ironvale.error;'), ...(await frames()) });
    note('webgl2Shot', await shot('app-webgl2'));
  }

  // 12. Losing focus releases the grab and pauses. The app hides itself, as Command-H would, which
  // also hands the screen back to whoever had it. Nothing after this needs the front.
  if (!skip.has('blur')) {
    await page(`const game = window.__ironvale.game; if (game.phase === 'paused') game.resume(); await game.input.requestLock();`);
    await sleep(300);
    note('beforeHide', { phase: await game('game.phase'), ...(await grabFacts()) });
    await bridge('/hide', '');
    await sleep(900);
    const state = await windowState();
    note('afterHide', { focused: state.focused, phase: await game('game.phase'), ...(await grabFacts()) });
  }

  // 13. What the page complained about. The content security policy blocks every request that
  // leaves the app, so a blocked request shows up here.
  note('pageLog', await page('return [...new Set(window.__devlog)].slice(0, 40);'));

  // 14. Leave no test state behind, then quit through the app's own Quit.
  await page('localStorage.clear();');
  note('foregroundSeconds', Math.round((Date.now() - foreground) / 1000));
  await run('osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`]);
  await until('the app to quit', async () => !(await windowState().then(() => true, () => false)), 10000);
  note('afterQuit', { cursorVisible: (await cursor()).visible });
}

main()
  .catch(async (error) => {
    note('FAILED', error.message);
    if (pid) await run('kill', [String(pid)]).catch(() => null);
    process.exitCode = 1;
  })
  .finally(() => process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`));
