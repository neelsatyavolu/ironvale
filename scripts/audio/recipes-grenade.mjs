// Hand grenade: pin, throw, bounce and the blast (close and distant takes).
import * as d from './dsp.mjs';
import { add, addSet, oneShot, part, src } from './kit.mjs';

const pinCuts = { thresholdDb: -36, minGap: 0.1, minLength: 0.03 };

// The longest handling event in the recording (0.56 s at about 3.35 s): the pin being worked out.
add('snd-grenade-pin', ['grenade-pin'], () =>
  d.press(oneShot(d.highpass(part('grenade-pin', 5, pinCuts, 0.06), 150), 0.04), -17, -4, 0.05, 18),
  { note: 'chosen by length and level, not by ear: segment 5 of the handling take' });

// Arm swing: low band-passed noise that rises quickly and trails off.
add('snd-grenade-throw', ['synth'], () => {
  const clip = d.sweptNoise(0.32, d.seeded(131), 420, 1300, 2.2);
  const n = clip[0].length;
  const bell = [clip[0].map((value, i) => value * Math.sin((Math.PI * i) / n) * Math.exp((-2 * i) / n))];
  return d.normalizePeak(d.highpass(bell, 180), -12);
}, { note: 'synthesised' });

// A steel body on hard ground: the metal-on-rock foley, pitched down and cut short.
addSet('snd-grenade-bounce', [['rock-2'], ['rock-3'], ['rock-4']], [['rock-2', 0.8], ['rock-3', 0.74], ['rock-4', 0.86]].map(
  ([key, ratio]) => () =>
    d.press(oneShot(d.pitch(d.cut(d.trimStart(src(key), -30), 0, 0.3), ratio), 0.06), -17, -4, 0.05, 16),
), { note: 'metal on rock foley pitched down' });

/** The recording peaks over full scale; bring it under before anything else. */
const blast = () => d.normalizePeak(d.trimStart(src('grenade-explosion'), -30, 0.001), -1);

add('snd-grenade-explode', ['grenade-explosion'], () =>
  d.press(d.fade(d.highpass(d.cut(blast(), 0, 3.4), 30), 0.0003, 1.1, 1.5), -8, -1.5, 0.05, 24),
  { note: 'pressed harder than the gunshots so it is the loudest thing in a match' });

// Heard from far off: the crack is gone and the low end rolls on.
add('snd-grenade-explode-dist', ['grenade-explosion'], () =>
  d.normalizePeak(d.fade(d.lowpass4(d.highpass(d.cut(blast(), 0, 4.2), 35), 700), 0.012, 1.6, 1.5), -3),
  { note: 'derived from the close take: low-passed at 700 Hz with a soft start' });
