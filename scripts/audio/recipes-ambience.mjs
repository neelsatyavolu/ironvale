// Looping beds, positional loops and the sparse one-shots that sit on top of them.
import * as d from './dsp.mjs';
import { add, addSet, oneShot, part, src } from './kit.mjs';

const OVERLAP = 2.5;

/** Filter a source, then take its steadiest `body + overlap` seconds and set them to an RMS level. */
function layer(key, body, { db = 0, hp = 60, lp = 16000, channels = 2, rmsDb = -27 } = {}) {
  const clip = d.lowpass(d.highpass(src(key, channels), hp), lp);
  const start = d.steadiestWindow(clip, body + OVERLAP);
  const window = d.cut(clip, start, start + body + OVERLAP + 0.05);
  return { clip: d.gain(window, rmsDb - d.toDb(d.rms(window)) + db) };
}

/**
 * Mix layers and loop the result. A bed whose peaks would pass -6 dB (drops on
 * a tin roof, a bird close to the microphone) is soft-limited instead of turned down.
 */
function bed(id, body, layers, options = {}) {
  const stereo = options.stereo !== false;
  add(id, layers.map(([key]) => key), () => {
    const mixed = d.mix(layers.map(([key, settings]) => layer(key, body, { channels: stereo ? 2 : 1, ...settings })));
    const level = d.toDb(d.rms(mixed));
    const safe = d.peak(mixed) > 0.5 ? d.press(mixed, level, -6, 3, 24) : mixed;
    return d.makeLoop(safe, body, OVERLAP);
  }, { stereo, kbps: options.kbps ?? (stereo ? 160 : 96), loop: { body }, note: options.note ?? '' });
}

bed('snd-amb-harbor', 56, [
  ['amb-harbor-dock', { hp: 50 }],
  ['amb-sea-ionian', { db: -5, hp: 250 }],
], { note: 'boats at a dock with lapping water, under gulls and gentle waves from a rocky shore' });
bed('snd-amb-forest', 56, [['amb-pine-wind-birds', { hp: 70 }]], { note: 'wind in pines with birds' });
bed('snd-amb-industrial', 50, [
  ['amb-factory-night', { hp: 40 }],
  ['amb-industrial-harbor', { db: -4, hp: 40, lp: 6000 }],
], { note: 'factory hum and steam from outside, with distant port and traffic rumble' });
bed('snd-amb-wind', 19, [['amb-wind-calm', { hp: 50 }]]);
bed('snd-amb-rain', 34, [['amb-rain-city', { hp: 80 }]], { note: 'steady rain on streets' });
bed('snd-amb-rain-roof', 30, [['amb-rain-tin-roof', { hp: 60 }]], { note: 'rain on a tin roof heard from inside a shed' });

bed('snd-loop-generator', 12, [['generator', { hp: 35, rmsDb: -20 }]], { stereo: false });
bed('snd-loop-water-lap', 16, [['water-lap', { hp: 120, rmsDb: -22 }]], { stereo: false });
bed('snd-loop-metal-creak', 24, [['metal-creak', { hp: 90, rmsDb: -22 }]], { stereo: false });
bed('snd-loop-birds', 30, [['amb-forest-morning', { hp: 1400, rmsDb: -30 }]], { stereo: false, note: 'birdsong only: the forest morning take high-passed at 1.4 kHz' });

// ---------------------------------------------------------------- sparse one-shots
const far = (clip, rmsDb = -18) => d.press(oneShot(clip, 0.15, -52), rmsDb, -5, 0.1, 16);
addSet('snd-oneshot-gull', ['gull'], [1, 0.92, 1.09].map((ratio) => () => far(d.pitch(src('gull'), ratio))));
const wide = { thresholdDb: -30, minGap: 0.15 };
addSet('snd-oneshot-clang', ['impact-metal-pipe'], [1, 6, 10].map((index) => () => far(d.lowpass(part('impact-metal-pipe', index, wide, 0.4), 4500))),
  { note: 'something heavy knocking on steel, far off' });
addSet('snd-oneshot-branch', [['twig-1'], ['twig-2'], ['twig-3']], ['twig-1', 'twig-2', 'twig-3'].map((key) => () => far(src(key))));
addSet('snd-oneshot-creak', ['metal-creak'], [0, 1].map((n) => () => {
  const clip = src('metal-creak');
  const found = d.segments(clip, { thresholdDb: -18, minGap: 0.3, minLength: 0.3 }).filter((s) => s.end - s.start < 4);
  const s = found[Math.floor(((n + 0.5) * found.length) / 2)];
  return far(d.cut(clip, s.start, s.end + 0.2));
}));
addSet('snd-oneshot-fence', ['fence-rattle'], [0, 1].map((index) => () => far(part('fence-rattle', index, { thresholdDb: -22, minGap: 0.07, minLength: 0.04 }, 0.2))));
