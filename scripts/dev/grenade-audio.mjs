// Checks the grenade sounds in the real page: emits the grenade events on the bus and measures what
// reaches the engine's master output through its analyser tap. The browser's output device is muted.
// Usage: node scripts/dev/grenade-audio.mjs [--port 5311]
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const port = arg('port', '5311');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
page.on('response', (response) => {
  if (response.status() >= 400) problems.push(`[http ${response.status()}] ${response.url()}`);
});
await page.routeWebSocket(/.*/, () => undefined);
await page.goto(`http://127.0.0.1:${port}/?autostart&map=range&bots=0&q=low`, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });

const result = await page.evaluate(async () => {
  const game = window.__ironvale.game;
  const audio = game.audio;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { WEAPON_DEFS } = await import('/src/weapons/defs.ts');
  const V = game.player.position.constructor;
  await audio.unlock();
  for (let i = 0; i < 300 && !audio.debug?.mapReady; i++) await sleep(50);
  const debug = audio.debug;
  if (!debug?.mapReady) return { fatal: 'audio never became ready' };
  audio.setPaused(false);
  await sleep(300);

  const e = game.engine.camera.matrixWorld.elements;
  const eye = new V(e[12], e[13], e[14]);
  const forward = new V(-e[8], -e[9], -e[10]).normalize();
  const up = new V(e[4], e[5], e[6]).normalize();
  const at = (u, f) => eye.clone().addScaledVector(up, u).addScaledVector(forward, f);

  const measure = (data) => {
    let peak = 0;
    for (const value of data) peak = Math.max(peak, Math.abs(value));
    let first = data.findIndex((value) => Math.abs(value) > Math.max(0.002, peak * 0.08));
    if (first < 0) first = 0;
    const end = Math.min(data.length, first + Math.floor(0.15 * debug.context.sampleRate));
    let sum = 0;
    let diff = 0;
    for (let i = first + 1; i < end; i++) {
      sum += data[i] * data[i];
      diff += (data[i] - data[i - 1]) ** 2;
    }
    return { peak, rms: Math.sqrt(sum / Math.max(1, end - first)), brightness: sum > 0 ? diff / sum : 0, first };
  };
  // The tap holds about 0.68 s, so the wait must stay under that for the onset to be in view.
  const listen = async (emit, waitMs = 660, settleMs = 4500) => {
    await sleep(settleMs);
    const startedAt = debug.context.currentTime;
    emit();
    await sleep(waitMs);
    const capture = debug.capture();
    const mono = capture.left.map((value, i) => (value + capture.right[i]) / 2);
    const m = measure(mono);
    return { peak: m.peak, rms: m.rms, brightness: m.brightness, onset: capture.endTime - (mono.length - m.first) / capture.sampleRate - startedAt };
  };

  const ids = ['snd-grenade-pin', 'snd-grenade-throw', 'snd-grenade-bounce-1', 'snd-grenade-bounce-2', 'snd-grenade-bounce-3', 'snd-grenade-explode', 'snd-grenade-explode-dist'];
  const out = { decoded: ids.filter((id) => debug.decoded.includes(id)), wanted: ids.length };
  const player = game.player.id;
  const near = at(4, 10);
  const far = at(85, 85);
  out.farDistance = eye.distanceTo(far);
  out.clear = [game.world.lineOfSight(eye, near), game.world.lineOfSight(eye, far)];
  out.silence = await listen(() => undefined, 300, 300);
  out.shot = await listen(() => game.events.emit('shotFired', { shooterId: player, weapon: WEAPON_DEFS.m4a1, muzzle: near, direction: forward.clone(), local: false }));
  out.thrown = await listen(() => game.events.emit('grenadeThrown', { ownerId: player, position: at(-0.1, 0.4), velocity: forward.clone().multiplyScalar(16), local: true }), 500, 2500);
  out.bounceHard = await listen(() => game.events.emit('grenadeBounced', { ownerId: player, position: at(0, 5), speed: 7, surface: 'concrete' }), 500, 2000);
  out.bounceSoft = await listen(() => game.events.emit('grenadeBounced', { ownerId: player, position: at(0, 5), speed: 1.2, surface: 'concrete' }), 500, 2000);
  out.blastNear = await listen(() => game.events.emit('grenadeExploded', { ownerId: player, position: near, local: true }));
  out.blastFar = await listen(() => game.events.emit('grenadeExploded', { ownerId: player, position: far, local: true }));
  return out;
});

const lines = [];
const check = (name, pass, detail = '') => {
  lines.push(pass);
  process.stdout.write(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}\n`);
};
if (result.fatal) {
  process.stdout.write(`${result.fatal}\n`);
} else {
  const f = (m) => `peak ${m.peak.toFixed(3)} rms ${m.rms.toFixed(4)} bright ${m.brightness.toFixed(3)} onset ${m.onset.toFixed(2)} s`;
  for (const key of ['silence', 'shot', 'thrown', 'bounceHard', 'bounceSoft', 'blastNear', 'blastFar']) process.stdout.write(`  ${key.padEnd(11)} ${f(result[key])}\n`);
  const quiet = result.silence.peak;
  check('all seven grenade sounds are decoded for the map', result.decoded.length === result.wanted, `${result.decoded.length}/${result.wanted}`);
  check('lines of sight used by the test are clear', result.clear.every(Boolean));
  check('pin and throw are heard', result.thrown.peak > quiet * 4 + 0.005);
  check('a hard bounce is heard and a soft one is quieter', result.bounceHard.peak > quiet * 4 + 0.005 && result.bounceSoft.rms < result.bounceHard.rms);
  check('the blast is louder than a rifle fired from the same spot, 10 m away', result.blastNear.rms > result.shot.rms, `${(20 * Math.log10(result.blastNear.rms / result.shot.rms)).toFixed(1)} dB`);
  check(`the blast ${result.farDistance.toFixed(0)} m away is heard, quieter and duller`, result.blastFar.peak > quiet * 3 + 0.003 && result.blastFar.rms < result.blastNear.rms && result.blastFar.brightness < result.blastNear.brightness);
  check('the far blast arrives late, at the speed of sound', Math.abs(result.blastFar.onset - result.farDistance / 343) < 0.15, `${result.blastFar.onset.toFixed(2)} s for ${(result.farDistance / 343).toFixed(2)} s`);
}
const mine = [...new Set(problems)];
check('no page errors, warnings or failed requests', mine.length === 0, `${mine.length}`);
for (const line of mine.slice(0, 15)) process.stdout.write(`  ${line.slice(0, 300)}\n`);
await browser.close();
process.exit(lines.every(Boolean) && !result.fatal ? 0 : 1);
