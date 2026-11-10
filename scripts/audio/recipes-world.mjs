// Bullet fly-bys and impacts, casings, footsteps, landings, cloth, voice and interface sounds.
import * as d from './dsp.mjs';
import { add, addSet, matched, oneShot, part, pick, src } from './kit.mjs';

const level = (clip, rmsDb, ceilingDb, fadeOut = 0.04) => d.press(oneShot(clip, fadeOut), rmsDb, ceilingDb, 0.05, 16);
const wide = { thresholdDb: -30, minGap: 0.15 };

// ---------------------------------------------------------------- fly-bys (synthesised)
// Supersonic crack: a 1-2 ms broadband snap, band-limited to 2-6 kHz, with a few ms of air after it.
addSet('snd-bullet-crack', ['synth'], [11, 23, 37, 51].map((seed, i) => () => {
  const random = d.seeded(seed);
  const snap = d.shape(d.noise(0.05, random), 0.0002, 0.0012 + 0.0004 * i);
  const air = d.shape(d.noise(0.09, random), 0.001, 0.016);
  const clip = d.mix([
    { clip: d.biquad(d.highpass(snap, 1800), 'peaking', 3200 + 500 * i, 1.2, 6) },
    { clip: d.lowpass(d.highpass(air, 900), 5200 - 400 * i), db: -13, at: 0.001 },
  ]);
  return d.normalizePeak(d.fade(clip, 0.0001, 0.03), -3);
}), { note: 'synthesised: no usable CC0 supersonic crack recordings' });

// Whiz: band-passed noise whose centre falls as the round passes (Doppler), bell-shaped in level.
addSet('snd-bullet-whiz', ['synth'], [[5, 0.26, 4200, 1100], [9, 0.34, 3400, 800], [14, 0.22, 5200, 1500], [21, 0.4, 2800, 700]].map(
  ([seed, length, fromHz, toHz]) => () => {
    const clip = d.sweptNoise(length, d.seeded(seed), fromHz, toHz, 5);
    const n = clip[0].length;
    const bell = [clip[0].map((value, i) => value * Math.sin((Math.PI * i) / n) ** 2 * Math.exp((-2.2 * i) / n))];
    return d.normalizePeak(d.highpass(bell, 400), -8);
  }), { note: 'synthesised' });

addSet('snd-ricochet', [['ricochet-2'], ['ricochet-1'], ['synth']], [
  () => d.normalizePeak(d.fade(d.highpass(d.cut(src('ricochet-2'), 0.72, 2.3), 600), 0.06, 0.6), -8),
  () => d.normalizePeak(d.fade(d.highpass(d.cut(src('ricochet-1'), 0.5, 0.84), 600), 0.02, 0.15), -8),
  () => d.normalizePeak(d.fade(d.mix([
    { clip: d.partials(0.7, [{ f: 3600, toF: 1500, tau: 0.22, amp: 1 }, { f: 5400, toF: 2300, tau: 0.12, amp: 0.4 }]) },
    { clip: d.highpass(d.shape(d.noise(0.2, d.seeded(77)), 0.001, 0.03), 2500), db: -12 },
  ]), 0.004, 0.3), -9),
], { note: 'ricochet whine heard after hits on stone and metal' });

// ---------------------------------------------------------------- impacts
/** A short dull burst that reads as a round striking: adds the snap foley stand-ins lack. */
function strike(seed, lowHz, highHz, tau) {
  return d.lowpass(d.highpass(d.shape(d.noise(0.2, d.seeded(seed)), 0.0003, tau), lowHz), highHz);
}
const impact = (clip) => level(clip, -13, -2.5, 0.06);

addSet('snd-impact-concrete', [1, 2, 3, 4, 5].map((n) => [`rock-${n}`, 'concrete-debris']), [1, 2, 3, 4, 5].map((n) => () =>
  impact(d.mix([
    { clip: d.cut(d.trimStart(src(`rock-${n}`), -30), 0, 0.5) },
    { clip: strike(100 + n, 700, 6500, 0.012), db: -5 },
    // Chips falling away after the hit.
    { clip: d.fade(d.highpass(part('concrete-debris', 1 + (n % 3), wide, 0.1), 1200), 0.01, 0.2), db: -17, at: 0.03 },
  ]))), { note: 'metal on rock foley with a noise snap and falling chips; no real bullet-on-concrete recording is free' });

const metalHits = [3, 5, 10, 14, 17];
addSet('snd-impact-metal', ['impact-metal'], metalHits.map((index, n) => () =>
  impact(d.mix([
    { clip: d.decay(d.cut(part('impact-metal', index, wide, 0.1), 0, 0.8), 0.15, 0.22) },
    { clip: strike(200 + n, 1500, 9000, 0.006), db: -8 },
  ]))));
addSet('snd-impact-metal-hollow', ['impact-metal-pipe'], [0, 2, 5, 7].map((index) => () =>
  impact(d.decay(d.cut(part('impact-metal-pipe', index, wide, 0.15), 0, 1.1), 0.25, 0.3))),
  { note: 'resonant hits for containers, tanks and sheet metal' });

addSet('snd-impact-wood', [1, 2, 3, 4].map((n) => [`wood-hit-${n}`, 'wood-crack']), [1, 2, 3, 4].map((n) => () =>
  impact(d.mix([
    { clip: d.cut(d.trimStart(src(`wood-hit-${n}`), -30), 0, 0.45) },
    { clip: strike(300 + n, 400, 4200, 0.01), db: -7 },
    { clip: d.fade(part('wood-crack', (n - 1) % 3, wide, 0.05), 0.002, 0.08), db: -13, at: 0.008 },
  ]))));

addSet('snd-impact-dirt', [['dirt-hit-1'], ['dirt-hit-2'], ['dirt-hit-1'], ['dirt-hit-2']], [
  ['dirt-hit-1', 1], ['dirt-hit-2', 1], ['dirt-hit-1', 0.88], ['dirt-hit-2', 1.1],
].map(([key, ratio], n) => () =>
  impact(d.mix([
    { clip: d.pitch(d.cut(d.trimStart(src(key), -30), 0, 0.6), ratio) },
    { clip: strike(400 + n, 120, 1400, 0.03), db: -6 },
  ]))));

const splashes = [['water-splashes', 1], ['water-splashes', 7], ['water-rocks', 0], ['water-rocks', 1], ['water-rocks', 3]];
addSet('snd-impact-water', splashes.map(([key]) => [key]), splashes.map(([key, index]) => () =>
  impact(d.decay(d.cut(part(key, index, wide, 0.1), 0, 0.9), 0.2, 0.25))));

addSet('snd-impact-glass', [1, 2, 3, 4].map((n) => [`glass-${n}`]), [1, 2, 3, 4].map((n) => () =>
  impact(d.decay(d.cut(d.trimStart(src(`glass-${n}`), -30), 0, 0.9), 0.25, 0.3))));

addSet('snd-impact-flesh', [1, 2, 3, 4].map((n) => [`flesh-${n}`]), [1, 2, 3, 4].map((n) => () =>
  impact(d.mix([{ clip: src(`flesh-${n}`) }, { clip: strike(500 + n, 90, 900, 0.02), db: -8 }]))));

// ---------------------------------------------------------------- casings
const hardCasing = (clip, ratio = 1) => level(d.pitch(d.highpass(d.trimStart(clip, -20), 500), ratio), -21, -6, 0.08);
/** Soft ground: no free recording, so the first bounce only, low-passed and 10 dB down. */
const softCasing = (clip, ratio = 1) =>
  d.gain(level(d.lowpass4(d.cut(d.trimStart(d.pitch(clip, ratio), -30), 0, 0.14), 2800), -21, -6, 0.08), -10);

const brass = { thresholdDb: -30, minGap: 0.15 };
const casingSources = {
  pistol: { key: 'casing-concrete', parts: [0, 7, 11], ratio: 1.12 },
  rifle: { key: 'casing-30cal', parts: [0, 2, 5], ratio: 1.04 },
  shotgun: { key: 'shell-drop', parts: [0, 0, 0], ratio: 1 },
};
for (const [kind, { key, parts, ratio }] of Object.entries(casingSources)) {
  const clips = parts.map((index, n) => () => {
    const clip = part(key, index, brass, 0.12);
    // The single shotgun hull take becomes three by small pitch steps.
    return kind === 'shotgun' ? d.pitch(clip, [1, 0.93, 1.07][n]) : clip;
  });
  addSet(`snd-casing-${kind}-hard`, [key], clips.map((clip) => () => hardCasing(clip(), ratio)));
  addSet(`snd-casing-${kind}-soft`, [key], clips.map((clip) => () => softCasing(clip(), ratio * 0.9)),
    { note: 'derived from the hard-ground take: first bounce, low-passed' });
}

// ---------------------------------------------------------------- footsteps
const step = (clip) => level(clip, -20, -5, 0.05);
/** Steps before levelling: rumble removed, and a little more edge for a running foot. */
const rawStep = (clip, bright) => {
  const clean = d.highpass(oneShot(clip, 0.05), 100);
  return bright ? d.biquad(clean, 'highshelf', 3000, 0.7, bright) : clean;
};
const singles = (keys) => keys.map((key) => () => src(key));
const picks = (key, count, options) => Array.from({ length: count }, (_, i) => () => pick(key, count, options)[i]);

/** surface -> { walk: [sources, clip makers], run: [...] } */
const STEPS = {
  concrete: {
    walk: [['step-concrete-1', 'step-concrete-2', 'step-concrete-3', 'step-concrete-4', 'steps-concrete-walk'],
      [...singles(['step-concrete-1', 'step-concrete-2', 'step-concrete-3', 'step-concrete-4']), ...picks('steps-concrete-walk', 2, { within: 10 })]],
    run: [['steps-stone-boots', 'steps-concrete-walk'],
      [...picks('steps-stone-boots', 4, { within: 6 }), ...picks('steps-concrete-walk', 2, { within: 16, range: [0, 14] })]],
  },
  cobble: {
    walk: [['steps-cobblestone'], picks('steps-cobblestone', 6, { range: [0, 100], within: 9 })],
    run: [['steps-cobblestone'], picks('steps-cobblestone', 6, { range: [100, 207], within: 7 })],
  },
  asphalt: {
    walk: [['steps-asphalt-walk'], picks('steps-asphalt-walk', 6, { within: 10 })],
    run: [['steps-asphalt-walk-2'], picks('steps-asphalt-walk-2', 6, { within: 10 })],
  },
  gravel: {
    walk: [['step-gravel-l1', 'step-gravel-l2', 'step-gravel-l3', 'step-gravel-l4', 'step-gravel-r3', 'step-gravel-r4'],
      singles(['step-gravel-l1', 'step-gravel-r3', 'step-gravel-l2', 'step-gravel-r4', 'step-gravel-l3', 'step-gravel-l4'])],
    run: [['steps-gravel-run'], picks('steps-gravel-run', 6, { within: 6 })],
  },
  dirt: {
    walk: [['step-dirt-1', 'step-dirt-2', 'step-dirt-3', 'step-dirt-4', 'steps-forest-bark'],
      [...singles(['step-dirt-1', 'step-dirt-2', 'step-dirt-3', 'step-dirt-4']), ...picks('steps-forest-bark', 2, { within: 6 })]],
    run: [['steps-dirt-run'], picks('steps-dirt-run', 6, { within: 14 })],
  },
  grass: {
    walk: [['steps-forest-moss'], picks('steps-forest-moss', 6, { range: [0, 15], within: 10 })],
    run: [['steps-forest-moss'], picks('steps-forest-moss', 6, { range: [26, 36], within: 10 })],
  },
  sand: {
    walk: [['steps-sand-dry'], picks('steps-sand-dry', 6, { range: [0, 120], within: 8 })],
    run: [['steps-sand-dry'], picks('steps-sand-dry', 6, { range: [150, 298], within: 6 })],
  },
  wood: {
    walk: [['steps-wood-boots'], picks('steps-wood-boots', 5, { range: [0, 6], within: 14 })],
    run: [['steps-wood-boots'], picks('steps-wood-boots', 5, { range: [6, 11.5], within: 14 })],
  },
  metal: {
    walk: [['steps-metal-boots'], picks('steps-metal-boots', 6, { range: [0, 60], within: 12 })],
    run: [['steps-metal-grate-run', 'steps-metal-boots'],
      [...picks('steps-metal-grate-run', 3, { within: 14 }), ...picks('steps-metal-boots', 3, { range: [0, 20], within: 8 })]],
  },
  water: {
    walk: [['steps-water'], picks('steps-water', 5, { range: [0, 4.5], within: 14, maxLength: 1 })],
    run: [['steps-water'], picks('steps-water', 5, { range: [3.9, 8.9], within: 14, maxLength: 1 })],
  },
};
for (const [surface, gaits] of Object.entries(STEPS)) {
  for (const [gait, [sources, makers]] of Object.entries(gaits)) {
    // Steps cut from different recordings of one surface are tilted to a common tone.
    addSet(`snd-step-${surface}-${gait}`, sources, matched(makers.map((make) => () => rawStep(make(), gait === 'run' ? 2 : 0)), step, 8));
  }
}

// ---------------------------------------------------------------- jumps and landings
const thud = (clip, lp) => level(lp ? d.lowpass(clip, lp) : clip, -15, -4, 0.08);
addSet('snd-land-hard', [['land-1'], ['land-2']], [() => thud(src('land-1')), () => thud(src('land-2'))]);
addSet('snd-land-soft', [['land-3'], ['land-4']], [() => thud(src('land-3'), 2200), () => thud(src('land-4'), 2200)]);
add('snd-land-gravel-1', ['land-gravel'], () => thud(d.cut(src('land-gravel'), 0.2, 1.3)));
add('snd-land-wood-1', ['land-wood'], () => thud(src('land-wood')));
const gear = { thresholdDb: -22, minGap: 0.07, minLength: 0.04 };
addSet('snd-jump', ['gear-friction'], [4, 6].map((index) => () => level(part('gear-friction', index, gear, 0.05), -22, -8, 0.08)),
  { note: 'push-off: a rustle of webbing' });

// ---------------------------------------------------------------- cloth and gear
addSet('snd-cloth', [['cloth-rustle'], ['cloth-rustle'], ['gear-friction'], ['gear-friction']], [
  () => level(part('cloth-rustle', 0, gear, 0.05), -26, -10, 0.1),
  () => level(d.cut(part('cloth-rustle', 1, gear, 0.05), 0, 0.5), -26, -10, 0.15),
  () => level(part('gear-friction', 13, gear, 0.05), -26, -10, 0.1),
  () => level(part('gear-friction', 17, gear, 0.05), -26, -10, 0.1),
]);
addSet('snd-gear', ['gear-friction'], [0, 2, 5, 20, 22, 33].map((index) => () => level(part('gear-friction', index, gear, 0.04), -28, -12, 0.06)),
  { note: 'webbing and kit shifting on each stride' });
addSet('snd-equip', ['rifle-canvas'], [0, 1].map((n) => () => level(pick('rifle-canvas', 2, { within: 14, maxLength: 1.2 })[n], -20, -6, 0.1)),
  { note: 'weapon brought up from the sling' });

// ---------------------------------------------------------------- voice and body
addSet('snd-hurt', [1, 2, 3, 4, 5, 6].map((n) => [`grunt-${n}`]), [1, 2, 3, 4, 5, 6].map((n) => () => level(src(`grunt-${n}`), -16, -4, 0.05)));
add('snd-bodyfall', ['bodyfall'], () => level(src('bodyfall'), -15, -4, 0.15));
add('snd-breath', ['breath-fast'], () => level(d.cut(src('breath-fast'), 0, 1.25), -24, -8, 0.2), { note: 'one quick breath in and out' });

// One lub-dub cut from a real stethoscope recording; the engine retriggers it at the pulse it wants.
add('snd-heartbeat', ['heartbeat'], () => {
  const clip = d.lowpass(d.highpass(src('heartbeat'), 35), 420);
  const env = d.envelope(clip, 0.01);
  // Pulse period from the envelope's autocorrelation between 0.3 and 1.2 s.
  let period = 60;
  let best = -Infinity;
  for (let lag = 30; lag <= 120; lag++) {
    let sum = 0;
    for (let k = 0; k + lag < env.length; k++) sum += env[k] * env[k + lag];
    if (sum / (env.length - lag) > best) {
      best = sum / (env.length - lag);
      period = lag;
    }
  }
  // Start just before the loudest beat in the middle of the take.
  let top = 300;
  for (let k = 300; k < Math.min(env.length, 900); k++) if (env[k] > env[top]) top = k;
  const start = top * 0.01 - 0.07;
  return d.normalizePeak(d.fade(d.cut(clip, start, start + period * 0.01 * 0.92), 0.02, 0.08), -3);
});

// ---------------------------------------------------------------- interface (synthesised)
const blip = (f, length, tau, seed, noiseDb) => () =>
  d.normalizePeak(d.fade(d.mix([
    { clip: d.partials(length, [{ f, tau, amp: 1 }, { f: f * 2.01, tau: tau * 0.5, amp: 0.25 }]) },
    { clip: d.lowpass(d.highpass(d.shape(d.noise(length, d.seeded(seed)), 0.0005, 0.004), 1500), 7000), db: noiseDb },
  ]), 0.002, length * 0.5), -12);
add('snd-ui-hover', ['synth'], blip(1400, 0.035, 0.008, 1, -14), { note: 'synthesised' });
add('snd-ui-click', ['synth'], blip(980, 0.06, 0.014, 2, -8), { note: 'synthesised' });
add('snd-ui-confirm', ['synth'], () => d.normalizePeak(d.mix([{ clip: blip(880, 0.07, 0.02, 3, -16)() }, { clip: blip(1320, 0.09, 0.03, 4, -18)(), at: 0.055 }]), -12), { note: 'synthesised' });
add('snd-ui-back', ['synth'], blip(620, 0.07, 0.018, 5, -10), { note: 'synthesised' });
add('snd-ui-hit', ['synth'], blip(2100, 0.04, 0.007, 6, -6), { note: 'synthesised hit confirmation tick' });
add('snd-ui-kill', ['synth'], () => d.normalizePeak(d.mix([{ clip: blip(1500, 0.05, 0.012, 7, -6)() }, { clip: blip(1050, 0.1, 0.035, 8, -14)(), at: 0.035 }]), -12), { note: 'synthesised' });
