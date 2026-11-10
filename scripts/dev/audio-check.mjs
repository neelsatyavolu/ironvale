// Scripted check of the audio engine in the real page (headless Chrome, dev server on 5311).
// Starts a match on the range, unlocks audio, emits game events on the bus and
// measures the master output through the engine's analyser tap.
// Usage: node scripts/dev/audio-check.mjs [--port 5311] [--map range]
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const port = arg('port', '5311');
const map = arg('map', 'range');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()} ${message.location().url ?? ''}`);
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
page.on('response', (response) => {
  if (response.status() >= 400) problems.push(`[http ${response.status()}] ${response.url()}`);
});

// Other work on the repository triggers hot reloads; hold the dev server's socket open and silent so the page stays put.
await page.routeWebSocket(/.*/, () => undefined);
await page.goto(`http://127.0.0.1:${port}/?autostart&map=${map}&bots=0&q=low`, { waitUntil: 'load', timeout: 30000 });
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
  const context = debug.context;
  // Without pointer lock the game sits paused; the checks drive the audio system directly.
  audio.setPaused(false);
  await sleep(300);

  // Listener frame from the camera, the same way the engine reads it.
  const e = game.engine.camera.matrixWorld.elements;
  const eye = new V(e[12], e[13], e[14]);
  const forward = new V(-e[8], -e[9], -e[10]).normalize();
  const up = new V(e[4], e[5], e[6]).normalize();
  const right = new V().crossVectors(forward, up).normalize();
  const at = (r, u, f) => eye.clone().addScaledVector(right, r).addScaledVector(up, u).addScaledVector(forward, f);

  const stats = (data, from = 0, to = data.length) => {
    let sum = 0;
    let peak = 0;
    for (let i = from; i < to; i++) {
      sum += data[i] * data[i];
      peak = Math.max(peak, Math.abs(data[i]));
    }
    return { rms: Math.sqrt(sum / Math.max(1, to - from)), peak };
  };
  /**
   * Share of energy in sample-to-sample differences: 0 for a rumble, near 2 for hiss.
   * Rises with the amount of high-frequency content, with no FFT needed.
   */
  const brightness = (data, from, to) => {
    let diff = 0;
    let total = 0;
    for (let i = from + 1; i < to; i++) {
      diff += (data[i] - data[i - 1]) ** 2;
      total += data[i] * data[i];
    }
    return total > 0 ? diff / total : 0;
  };
  /** Play `emit`, wait, and describe what reached the output. */
  const listen = async (emit, waitMs = 660, settleMs = 3600) => {
    await sleep(settleMs); // let earlier tails and reverb die away
    const startedAt = context.currentTime;
    emit();
    await sleep(waitMs);
    const capture = debug.capture();
    const rate = capture.sampleRate;
    const mono = capture.left.map((value, i) => (value + capture.right[i]) / 2);
    const top = stats(mono).peak;
    let first = mono.findIndex((value) => Math.abs(value) > Math.max(0.002, top * 0.08));
    if (first < 0) first = 0;
    const windowEnd = Math.min(mono.length, first + Math.floor(0.15 * rate));
    return {
      peak: Math.max(stats(capture.left).peak, stats(capture.right).peak),
      left: stats(capture.left, first, windowEnd).rms,
      right: stats(capture.right, first, windowEnd).rms,
      rms: stats(mono, first, windowEnd).rms,
      brightness: brightness(mono, first, windowEnd),
      // When the sound began, in seconds after the event was emitted.
      onset: capture.endTime - (mono.length - first) / rate - startedAt,
    };
  };

  /** Average of several plays, so the random choice of take does not decide a comparison. */
  const listenTimes = async (count, emit) => {
    const runs = [];
    for (let i = 0; i < count; i++) runs.push(await listen(emit));
    const mean = (key) => runs.reduce((sum, run) => sum + run[key], 0) / runs.length;
    return { peak: Math.max(...runs.map((run) => run.peak)), left: mean('left'), right: mean('right'), rms: mean('rms'), brightness: mean('brightness'), onset: mean('onset') };
  };

  const m4 = WEAPON_DEFS.m4a1;
  const shot = (position, local, weapon = m4, shooterId = local ? game.player.id : 900) =>
    game.events.emit('shotFired', { shooterId, weapon, muzzle: position, direction: forward.clone(), local });
  const out = { sampleRate: context.sampleRate, contextState: context.state, decodedForMap: debug.decoded.length };

  out.silence = await listen(() => undefined, 300, 300);
  out.localShot = await listen(() => shot(at(0.2, -0.1, 0.5), true));
  out.leftShot = await listen(() => shot(at(-8, 0, 0.5), false));
  out.rightShot = await listen(() => shot(at(8, 0, 0.5), false));
  out.sideClear = [game.world.lineOfSight(eye, at(-8, 0, 0.5)), game.world.lineOfSight(eye, at(8, 0, 0.5))];
  out.leftStep = await listen(() =>
    game.events.emit('footstep', { ownerId: 901, position: at(-3, -1.2, 0), surface: 'concrete', running: true, local: false }), 400, 1500);

  // Near and far in the same direction (up and ahead, so nothing on the map is in the way).
  const near = at(0, 4, 3);
  const far = at(0, 120, 90);
  out.nearClear = game.world.lineOfSight(eye, near);
  out.farClear = game.world.lineOfSight(eye, far);
  out.farDistance = eye.distanceTo(far);
  out.nearShot = await listenTimes(3, () => shot(near, false));
  out.farShot = await listenTimes(3, () => shot(far, false));

  // Occlusion: the same shot from behind the nearest solid thing, if the map has one within 60 m.
  for (const [r, f] of [[0, 1], [1, 0], [-1, 0], [0, -1]]) {
    const direction = new V().addScaledVector(right, r).addScaledVector(forward, f).normalize();
    const hit = game.world.raycast(eye, direction, 60);
    if (!hit || hit.distance < 4) continue;
    const behind = eye.clone().addScaledVector(direction, hit.distance + 2.5);
    const inFront = eye.clone().addScaledVector(direction, hit.distance - 1);
    if (game.world.lineOfSight(eye, behind) || !game.world.lineOfSight(eye, inFront)) continue;
    out.openShot = await listenTimes(3, () => shot(inFront, false));
    out.occludedShot = await listenTimes(3, () => shot(behind, false));
    break;
  }

  // Automatic fire from the player's own machine gun: loud, overlapping, must not clip.
  await sleep(900);
  let burstPeak = 0;
  let burstVoices = 0;
  for (let i = 0; i < 16; i++) {
    shot(at(0.2, -0.1, 0.5), true, WEAPON_DEFS.m249);
    game.events.emit('casingLanded', { kind: 'rifle', position: at(0.8, -1.5, 0.3), surface: 'concrete' });
    await sleep(75);
    burstVoices = Math.max(burstVoices, debug.playing);
  }
  const burst = debug.capture();
  burstPeak = Math.max(stats(burst.left).peak, stats(burst.right).peak);
  out.burst = { peak: burstPeak, rms: stats(burst.left).rms, voices: burstVoices };

  // Many shooters at once: the pool cap and the HRTF cap must hold.
  await sleep(900);
  let crowdVoices = 0;
  let crowdHrtf = 0;
  for (let i = 0; i < 30; i++) {
    const angle = (i / 30) * Math.PI * 2;
    shot(at(Math.cos(angle) * (6 + i), 1, Math.sin(angle) * (6 + i)), false, i % 2 ? WEAPON_DEFS.m1garand : WEAPON_DEFS.mp5, 700 + i);
    crowdVoices = Math.max(crowdVoices, debug.playing);
    crowdHrtf = Math.max(crowdHrtf, debug.hrtf);
  }
  await sleep(200);
  const crowd = debug.capture();
  out.crowd = { voices: crowdVoices, hrtf: crowdHrtf, peak: Math.max(stats(crowd.left).peak, stats(crowd.right).peak) };

  // Every other event type once, to prove none throws.
  await sleep(700);
  const thrown = [];
  const safe = (label, run) => {
    try {
      run();
    } catch (error) {
      thrown.push(`${label}: ${error.message}`);
    }
  };
  const hit = { point: at(1, -1, -6), normal: new V(0, 1, 0), distance: 6, surface: 'concrete' };
  for (const surface of ['concrete', 'cobble', 'asphalt', 'gravel', 'dirt', 'grass', 'sand', 'wood', 'metal', 'plaster', 'glass', 'water', 'foliage', 'flesh']) {
    safe(`impact ${surface}`, () => game.events.emit('bulletImpact', { weapon: m4, hit: { ...hit, surface } }));
    safe(`step ${surface}`, () => game.events.emit('footstep', { ownerId: game.player.id, position: at(0, -1.6, 0), surface, running: false, local: true }));
    safe(`land ${surface}`, () => game.events.emit('landed', { ownerId: 902, position: at(2, -1.6, 2), surface, speed: 6, local: false }));
    safe(`casing ${surface}`, () => game.events.emit('casingLanded', { kind: 'pistol', position: at(1, -1.6, 1), surface }));
    await sleep(40);
  }
  const stages = ['magOut', 'magIn', 'boltBack', 'boltForward', 'boltLift', 'boltClose', 'pumpBack', 'pumpForward', 'shellInsert', 'clipInsert', 'clipPing', 'beltOpen', 'beltClose', 'slideRelease'];
  for (const weapon of Object.values(WEAPON_DEFS)) {
    for (const stage of stages) {
      safe(`${weapon.id} ${stage}`, () => game.events.emit('weaponAction', { shooterId: game.player.id, weapon, stage, position: at(0, 0, 0), local: true }));
    }
    safe(`${weapon.id} dry`, () => game.events.emit('dryFire', { shooterId: game.player.id, weapon, position: at(0, 0, 0) }));
    safe(`${weapon.id} switch`, () => game.events.emit('weaponSwitch', { shooterId: game.player.id, weapon, local: true }));
    await sleep(60);
  }
  safe('nearMiss', () => game.events.emit('nearMiss', { point: at(-0.6, 0, 0.5), weapon: m4 }));
  safe('aim', () => game.events.emit('aimChanged', { aiming: true, weapon: m4 }));
  safe('jump', () => game.events.emit('jumped', { ownerId: game.player.id, position: at(0, -1.6, 0), local: true }));
  safe('hurt', () => game.events.emit('playerHurt', { amount: 30, health: 20, direction: right.clone() }));
  safe('hit', () => game.events.emit('combatantHit', { weapon: m4, targetId: 903, attackerId: game.player.id, hit: { distance: 20, zone: 'torso', point: at(0, 0, 20) }, fatal: true }));
  safe('callout', () => game.events.emit('botCallout', { botId: 904, kind: 'hurt', position: at(3, -1.6, 8) }));
  safe('died', () => game.events.emit('died', { victimId: 905, killerId: game.player.id, weaponId: 'm4a1', headshot: false }));
  safe('playAt', () => audio.playAt('snd-impact-metal-1', at(2, 0, 2), { volume: 0.5, pitchJitter: 0.05 }).setVolume(0.3));
  safe('play missing', () => audio.play('snd-does-not-exist').stop());
  safe('ui', () => audio.play('snd-ui-click'));
  out.thrown = thrown;

  // Near miss on the left must sound on the left.
  out.nearMissLeft = await listen(() => game.events.emit('nearMiss', { point: at(-0.7, 0, 0.3), weapon: m4 }), 300);
  out.nearMissRight = await listen(() => game.events.emit('nearMiss', { point: at(0.7, 0, 0.3), weapon: m4 }), 300);

  // Pause mutes the world; the interface bus still plays.
  await sleep(600);
  audio.setPaused(true);
  shot(at(0.2, -0.1, 0.5), true);
  await sleep(400);
  const paused = debug.capture();
  out.pausedRms = stats(paused.left, paused.left.length - Math.floor(0.2 * paused.sampleRate)).rms;
  audio.play('snd-ui-confirm');
  await sleep(150);
  out.pausedUiPeak = stats(debug.capture().left).peak;
  audio.setPaused(false);
  out.resumed = await listen(() => shot(at(0.2, -0.1, 0.5), true), 400);

  // Ambience: enter a copy of the map with beds, a positional loop and rain.
  const real = game.map;
  audio.leaveMap();
  const withAmbience = {
    ...real,
    weather: 'rain',
    reverb: 'forest',
    ambience: [
      { sound: 'snd-amb-forest', volume: 0.8 },
      { sound: 'snd-loop-generator', volume: 0.9, position: at(-10, 0, 0), radius: 5 },
      { sound: 'snd-not-in-manifest', volume: 1 },
    ],
  };
  const required = audio.requiredSounds(withAmbience);
  await game.assets.preload(required);
  await audio.enterMap(withAmbience);
  await sleep(2600);
  const ambient = debug.capture();
  out.ambience = {
    required: required.length,
    hasRainRoof: required.includes('snd-amb-rain-roof'),
    skipsMissing: !required.includes('snd-not-in-manifest'),
    left: stats(ambient.left).rms,
    right: stats(ambient.right).rms,
    peak: Math.max(stats(ambient.left).peak, stats(ambient.right).peak),
    voices: debug.playing,
  };
  audio.leaveMap();
  await sleep(700);
  out.afterLeaveRms = stats(debug.capture().left, 32768 - 9600).rms;
  await audio.enterMap(real);

  // Chrome must decode every file in the manifest.
  const ids = game.assets.manifest.filter((entry) => entry.kind === 'sound').map((entry) => entry.id);
  await game.assets.preload(ids);
  const failures = [];
  let worstLead = 0;
  let seconds = 0;
  for (const id of ids) {
    try {
      const buffer = await context.decodeAudioData(game.assets.sound(id).slice(0));
      seconds += buffer.duration;
      const data = buffer.getChannelData(0);
      let first = 0;
      while (first < data.length && Math.abs(data[first]) < 0.004) first++;
      if (!id.includes('-amb-') && !id.includes('-loop-') && !id.includes('-tail')) worstLead = Math.max(worstLead, first / buffer.sampleRate);
    } catch (error) {
      failures.push(`${id}: ${error.message}`);
    }
  }
  out.decode = { files: ids.length, failures, seconds: Math.round(seconds), worstLeadMs: Math.round(worstLead * 1000) };
  return out;
});

await browser.close();

const checks = [];
const check = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail });
if (result.fatal) {
  check('audio starts', false, result.fatal);
} else {
  const r = result;
  const db = (value) => (value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dB` : '-inf dB');
  check('context is running', r.contextState === 'running', `${r.contextState}, ${r.sampleRate} Hz, ${r.decodedForMap} buffers decoded for the map`);
  check('silent when nothing plays', r.silence.rms < 0.001, db(r.silence.rms));
  check('energy reaches the master bus (own shot)', r.localShot.rms > 0.05, `rms ${db(r.localShot.rms)}, peak ${db(r.localShot.peak)}`);
  check('own shot starts at once', r.localShot.onset < 0.03, `${(r.localShot.onset * 1000).toFixed(0)} ms after the event`);
  check('own shot is centred', Math.abs(Math.log2(r.localShot.left / r.localShot.right)) < 0.35, `L ${db(r.localShot.left)} R ${db(r.localShot.right)}`);
  check('source on the left is louder in the left channel', r.leftShot.left > r.leftShot.right * 1.25, `L ${db(r.leftShot.left)} R ${db(r.leftShot.right)}`);
  check('source on the right is louder in the right channel', r.rightShot.right > r.rightShot.left * 1.25, `L ${db(r.rightShot.left)} R ${db(r.rightShot.right)}`);
  check('footstep on the left is louder in the left channel', r.leftStep.left > r.leftStep.right * 1.25, `L ${db(r.leftStep.left)} R ${db(r.leftStep.right)}`);
  check('paths to the side test points are clear', r.sideClear[0] && r.sideClear[1], `left ${r.sideClear[0]}, right ${r.sideClear[1]}`);
  check('own gun is louder than a neighbour 8 m away', r.localShot.rms > r.leftShot.rms, `${db(r.localShot.rms)} against ${db(r.leftShot.rms)}`);
  check('paths to near and far test points are clear', r.nearClear && r.farClear, `far point at ${r.farDistance.toFixed(0)} m`);
  check('distant shot is quieter', r.farShot.rms < r.nearShot.rms * 0.5, `near ${db(r.nearShot.rms)}, far ${db(r.farShot.rms)}`);
  check('distant shot is darker', r.farShot.brightness < r.nearShot.brightness * 0.6, `high-frequency share: near ${r.nearShot.brightness.toFixed(4)}, far ${r.farShot.brightness.toFixed(4)}`);
  const expected = r.farDistance / 343;
  check('distant shot arrives later, by distance / 343', Math.abs(r.farShot.onset - expected) < 0.05 && r.nearShot.onset < 0.03,
    `near ${(r.nearShot.onset * 1000).toFixed(0)} ms, far ${(r.farShot.onset * 1000).toFixed(0)} ms, expected ${(expected * 1000).toFixed(0)} ms`);
  if (r.occludedShot) {
    check('shot behind a wall is quieter and duller', r.occludedShot.rms < r.openShot.rms * 0.75 && r.occludedShot.brightness < r.openShot.brightness * 0.6,
      `open ${db(r.openShot.rms)}, high-frequency share ${r.openShot.brightness.toFixed(4)}; behind ${db(r.occludedShot.rms)}, ${r.occludedShot.brightness.toFixed(4)}`);
  } else {
    check('shot behind a wall is quieter and duller', true, 'skipped: no wall within 60 m of the spawn');
  }
  check('automatic fire does not clip', r.burst.peak < 0.99, `peak ${db(r.burst.peak)}, rms ${db(r.burst.rms)}, ${r.burst.voices} voices at most`);
  check('voice cap holds under 30 simultaneous shooters', r.crowd.voices <= 32, `${r.crowd.voices} voices`);
  check('HRTF cap holds', r.crowd.hrtf <= 8 && r.crowd.hrtf > 0, `${r.crowd.hrtf} HRTF panners`);
  check('crowd does not clip', r.crowd.peak < 0.99, `peak ${db(r.crowd.peak)}`);
  check('no event handler throws', r.thrown.length === 0, r.thrown.join('; ') || 'every surface, weapon and stage emitted');
  check('near miss on the left sounds on the left', r.nearMissLeft.left > r.nearMissLeft.right * 1.25, `L ${db(r.nearMissLeft.left)} R ${db(r.nearMissLeft.right)}`);
  check('near miss on the right sounds on the right', r.nearMissRight.right > r.nearMissRight.left * 1.25, `L ${db(r.nearMissRight.left)} R ${db(r.nearMissRight.right)}`);
  check('pause silences the world', r.pausedRms < 0.001, db(r.pausedRms));
  check('interface still plays while paused', r.pausedUiPeak > 0.005, `peak ${db(r.pausedUiPeak)}`);
  check('sound returns after resume', r.resumed.rms > 0.05, db(r.resumed.rms));
  check('ambience plays in both channels', r.ambience.left > 0.003 && r.ambience.right > 0.003, `L ${db(r.ambience.left)} R ${db(r.ambience.right)}, peak ${db(r.ambience.peak)}, ${r.ambience.voices} pool voices`);
  check('requiredSounds adds the rain beds and skips unknown ids', r.ambience.hasRainRoof && r.ambience.skipsMissing, `${r.ambience.required} ids`);
  check('ambience stops on leaveMap', r.afterLeaveRms < 0.001, db(r.afterLeaveRms));
  check('Chrome decodes every file', r.decode.failures.length === 0, `${r.decode.files} files, ${r.decode.seconds} s of audio, worst leading silence ${r.decode.worstLeadMs} ms${r.decode.failures.length ? `; ${r.decode.failures.slice(0, 5).join('; ')}` : ''}`);
}

for (const { label, pass, detail } of checks) process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${label}: ${detail}\n`);
const unique = [...new Set(problems)];
if (unique.length) process.stdout.write(`\npage problems (${unique.length}):\n${unique.slice(0, 20).map((line) => `  ${line.slice(0, 300)}`).join('\n')}\n`);
const failed = checks.filter((item) => !item.pass).length;
process.stdout.write(`\n${checks.length - failed} of ${checks.length} checks passed\n`);
process.exit(failed ? 1 : 0);
