// Gunshots (close, tail, distant), dry fire and handling sounds for the seven weapons.
import * as d from './dsp.mjs';
import { add, addSet, from, matched, oneShot, part, src, takeStart } from './kit.mjs';


/** Close shot before levelling: the crack and body, with the recording's own decay shortened so tails can be layered. */
function close(clip, { length = 0.55, tau = 0.14, hp = 45 } = {}) {
  return d.fade(d.decay(d.highpass(d.cut(clip, 0, length), hp), 0.09, tau), 0.0003, 0.08);
}

/** Level a close shot: peaks rounded off so every take of a gun hits equally hard. */
const pressShot = (clip) => d.press(clip, -10, -2.5, 0.05, 30);

/** Takes of one gun from different recordists, tilted to a common tone and then levelled. */
const shots = (makers) => matched(makers, pressShot, 10);

/** Outdoor tail: the mid-distance take without its direct sound. */
function tail(key, takeIndex, length = 2.6) {
  const start = takeStart(key, takeIndex);
  const clip = d.cut(d.trimStart(d.cut(src(key, 2), start - 0.01, start + length + 0.2), -26, 0), 0.07, length);
  return d.press(d.fade(d.lowpass(d.highpass(clip, 70), 9000), 0.05, 0.9, 1.5), -19, -5, 0.2, 30);
}

/** Distant shot: the whole mid-distance take, mono. */
function distant(key, takeIndex, length = 2.2, hp = 55) {
  const clip = from(key, takeStart(key, takeIndex), length);
  return d.press(d.fade(d.highpass4(clip, hp), 0.0005, 0.7, 1.5), -15, -3, 0.1, 30);
}

const near = (key, takeIndex, options) => () => close(from(key, takeStart(key, takeIndex), 0.7), options);
const handling = (clip, rmsDb = -15) => d.press(oneShot(d.highpass(clip, 90), 0.04), rmsDb, -3, 0.05, 18);
const cuts = { thresholdDb: -30, minGap: 0.12 };
const fine = { thresholdDb: -42, minGap: 0.1, minLength: 0.008 };

/** A short mechanical click cut from a handling sound, for the cycling layer under the shooter's own shots. */
const mech = (clip, length = 0.11) => d.press(d.fade(d.highpass(d.cut(d.trimStart(clip, -30), 0, length), 400), 0.001, 0.05), -18, -6, 0.03, 18);

// ---------------------------------------------------------------- M4A1
addSet('snd-m4a1-shot', [['m4a1-shot'], ['ffsl-ar15-near'], ['ar15-shot'], ['ffsl-ar15-near']], shots([
  near('m4a1-shot', 0),
  near('ffsl-ar15-near', 0),
  near('ar15-shot', 0, { hp: 60 }),
  near('ffsl-ar15-near', 1),
]));
add('snd-m4a1-tail', ['ffsl-ar15-mid'], () => tail('ffsl-ar15-mid', 0), { stereo: true });
addSet('snd-m4a1-dist', [['ffsl-ar15-mid'], ['ar15-shot-distant']], [
  () => distant('ffsl-ar15-mid', 1),
  () => distant('ar15-shot-distant', 0, 2.8),
]);
add('snd-m4a1-dry', ['rifle-dryfire'], () => handling(src('rifle-dryfire'), -17));
add('snd-m4a1-magOut', ['m4-reload-sequence'], () => handling(part('m4-reload-sequence', 0, cuts)));
add('snd-m4a1-magIn', ['m4-reload-sequence'], () => handling(part('m4-reload-sequence', 2, cuts)));
add('snd-m4a1-boltBack', ['ar15-various'], () => handling(part('ar15-various', 5, cuts)));
add('snd-m4a1-boltForward', ['m4-reload-sequence'], () => handling(part('m4-reload-sequence', 6, cuts), -13));
add('snd-m4a1-mech', ['ar15-various'], () => mech(part('ar15-various', 1, cuts)));

// ---------------------------------------------------------------- M1 Garand
addSet('snd-m1garand-shot', [['garand-shot'], ['ffsl-1917-near'], ['garand-shot-indoor', 'ffsl-1917-near']], shots([
  near('garand-shot', 0, { length: 0.65, tau: 0.17 }),
  near('ffsl-1917-near', 0, { length: 0.65, tau: 0.17 }),
  // Indoor-range Garand for the crack only, over the body of the second .30-06 take.
  () =>
    close(
      d.mix([
        { clip: d.fade(d.highpass(d.cut(from('garand-shot-indoor', takeStart('garand-shot-indoor', 0), 0.2), 0, 0.09), 500), 0.0003, 0.05) },
        { clip: from('ffsl-1917-near', takeStart('ffsl-1917-near', 1), 0.7), db: 2 },
      ]),
      { length: 0.65, tau: 0.17 },
    ),
]));
add('snd-m1garand-tail', ['ffsl-1917-mid'], () => tail('ffsl-1917-mid', 1, 2.9), { stereo: true });
add('snd-m1garand-dist-1', ['ffsl-1917-mid'], () => distant('ffsl-1917-mid', 0, 2.4));
add('snd-m1garand-dry', ['garand-dryfire'], () => handling(part('garand-dryfire', 0, fine), -17));
add('snd-m1garand-clipInsert', ['garand-reload'], () =>
  handling(d.cut(src('garand-reload'), 0.55, 1.75), -17), { note: 'clip pressed into the receiver (the quiet part before the bolt runs home)' });
add('snd-m1garand-boltForward', ['garand-reload'], () => handling(part('garand-reload', 2, fine, 0.12), -13));
add('snd-m1garand-boltBack', ['garand-clip-eject'], () => handling(part('garand-clip-eject', 1, cuts)));
add('snd-m1garand-clipPing', ['garand-ping'], () => d.press(d.fade(d.trim(src('garand-ping'), -34, -56), 0.001, 0.25), -13, -3, 0.05, 12));
add('snd-m1garand-mech', ['garand-handling'], () => mech(part('garand-handling', 17, { thresholdDb: -26, minGap: 0.1 })));

// ---------------------------------------------------------------- MP5
addSet('snd-mp5-shot', [['ffsl-m45-near'], ['ffsl-m45-near'], ['ffsl-ppq-near', 'ffsl-m45-near']], shots([
  near('ffsl-m45-near', 0, { length: 0.45, tau: 0.11 }),
  near('ffsl-m45-near', 1, { length: 0.45, tau: 0.11 }),
  // 9 mm pistol crack over the SMG body, for a third colour of the same cartridge.
  () =>
    close(
      d.mix([
        { clip: from('ffsl-ppq-near', takeStart('ffsl-ppq-near', 0), 0.5) },
        { clip: d.lowpass(from('ffsl-m45-near', takeStart('ffsl-m45-near', 1), 0.5), 900), db: -3 },
      ]),
      { length: 0.45, tau: 0.11 },
    ),
]), { note: 'Carl Gustav M45 (9 mm SMG) stands in: no live-fire MP5 recording exists under CC0' });
add('snd-mp5-tail', ['ffsl-m45-mid'], () => tail('ffsl-m45-mid', 0, 2.0), { stereo: true });
add('snd-mp5-dist-1', ['ffsl-m45-mid'], () => distant('ffsl-m45-mid', 1, 1.8));
add('snd-mp5-dry', ['rifle-dryfire'], () => handling(d.pitch(src('rifle-dryfire'), 1.09), -18));
add('snd-mp5-magOut', ['mp5-mag-out'], () => handling(d.pitch(part('mp5-mag-out', 0, fine), 0.89), -16),
  { note: 'airsoft replica magazine, pitched down two semitones for a loaded steel magazine' });
add('snd-mp5-magIn', ['mp5-mag-in'], () => handling(d.pitch(part('mp5-mag-in', 5, cuts), 0.89), -15));
add('snd-mp5-boltBack', ['ar15-various'], () => handling(d.pitch(part('ar15-various', 3, cuts), 0.94)));
add('snd-mp5-boltForward', ['ar15-various'], () => handling(d.pitch(part('ar15-various', 2, cuts), 0.94), -12),
  { note: 'the HK slap: an AR-15 bolt slam, pitched down' });
add('snd-mp5-mech', ['ar15-various'], () => mech(d.pitch(part('ar15-various', 6, cuts), 1.06), 0.09));

// ---------------------------------------------------------------- Remington 870
addSet('snd-r870-shot', [['r870-shot'], ['ffsl-nova-near'], ['ffsl-model12-near']], shots([
  near('r870-shot', 0, { length: 0.7, tau: 0.2, hp: 40 }),
  near('ffsl-nova-near', 0, { length: 0.7, tau: 0.2, hp: 40 }),
  near('ffsl-model12-near', 0, { length: 0.7, tau: 0.2, hp: 40 }),
]));
add('snd-r870-tail', ['ffsl-nova-mid'], () => tail('ffsl-nova-mid', 0, 2.8), { stereo: true });
addSet('snd-r870-dist', [['ffsl-model12-mid'], ['shotgun-echo']], [
  () => distant('ffsl-model12-mid', 0, 2.2),
  () => distant('shotgun-echo', 0, 2.6),
]);
add('snd-r870-dry', ['r870-dryfire'], () => handling(part('r870-dryfire', 1, cuts), -17));
/** One rack is "back" then "forward" about 0.2 s apart; split at the quietest point between them. */
function pumpHalf(rack, second) {
  const clip = part('r870-pump', rack, { thresholdDb: -26, minGap: 0.1 }, 0.06);
  const env = d.envelope(clip, 0.004);
  let dip = Math.floor(env.length * 0.3);
  for (let k = dip; k < env.length * 0.7; k++) if (env[k] < env[dip]) dip = k;
  const at = dip * 0.004;
  return handling(second ? d.cut(clip, at) : d.cut(clip, 0, at + 0.01), -13);
}
addSet('snd-r870-pumpBack', ['r870-pump'], [0, 4, 9].map((rack) => () => pumpHalf(rack, false)));
addSet('snd-r870-pumpForward', ['r870-pump'], [0, 4, 9].map((rack) => () => pumpHalf(rack, true)));
addSet('snd-r870-shellInsert', [['shell-insert'], ['shell-insert'], ['shell-insert-2']], [
  () => handling(part('shell-insert', 0, cuts), -16),
  () => handling(part('shell-insert', 3, cuts), -16),
  () => handling(src('shell-insert-2'), -16),
]);

// ---------------------------------------------------------------- M24
addSet('snd-m24-shot', [['sniper-shot'], ['ffsl-tikka-near'], ['ffsl-mosin-near']], shots([
  near('sniper-shot', 0, { length: 0.75, tau: 0.2 }),
  near('ffsl-tikka-near', 0, { length: 0.75, tau: 0.2 }),
  near('ffsl-mosin-near', 0, { length: 0.75, tau: 0.2 }),
]));
add('snd-m24-tail', ['ffsl-tikka-mid'], () => tail('ffsl-tikka-mid', 0, 3.0), { stereo: true });
add('snd-m24-dist-1', ['ffsl-tikka-mid'], () => distant('ffsl-tikka-mid', 1, 2.5));
add('snd-m24-dry', ['garand-dryfire'], () => handling(d.pitch(part('garand-dryfire', 1, fine), 1.05), -18));
// The Mosin take holds seven bolt cycles of four movements each: lift, pull, push, lock.
const mosin = { thresholdDb: -26, minGap: 0.1 };
add('snd-m24-boltLift', ['mosin-bolt'], () => handling(part('mosin-bolt', 4, mosin), -15));
add('snd-m24-boltBack', ['mosin-bolt'], () => handling(part('mosin-bolt', 5, mosin), -14));
add('snd-m24-boltForward', ['mosin-bolt'], () => handling(part('mosin-bolt', 6, mosin), -14));
add('snd-m24-boltClose', ['mosin-bolt'], () => handling(part('mosin-bolt', 7, mosin), -14));
add('snd-m24-shellInsert-1', ['bolt-rifle-reload'], () => handling(part('bolt-rifle-reload', 1, mosin), -17));
add('snd-m24-shellInsert-2', ['bolt-rifle-reload'], () => handling(part('bolt-rifle-reload', 4, mosin), -17));

// ---------------------------------------------------------------- M249
const lmgShot = (start) => () => close(from('lmg-556', start, 0.7), { length: 0.5, tau: 0.13 });
addSet('snd-m249-shot', ['lmg-556'], shots([lmgShot(11.72), lmgShot(13.24), lmgShot(19.18)]),
  { note: 'KAC LAMG, a 5.56 belt-fed gun; isolated single shots from a long take' });
add('snd-m249-tail', ['lmg-556'], () => {
  const clip = d.cut(d.trimStart(d.cut(src('lmg-556', 2), 20.8, 22.4), -26, 0), 0.07, 1.55);
  return d.press(d.fade(d.lowpass(d.highpass(clip, 70), 9000), 0.05, 0.7, 1.5), -19, -5, 0.2, 30);
}, { stereo: true });
addSet('snd-m249-dist', ['m249-single'], [
  () => distant('m249-single', 0, 2.2, 160),
  () => distant('m249-single', 1, 0.75, 160),
], { note: 'real M249 on a range, recorded from a distance' });
add('snd-m249-dry', ['rifle-dryfire'], () => handling(d.pitch(src('rifle-dryfire'), 0.9), -16));
add('snd-m249-beltOpen', ['garand-clip-eject'], () => handling(d.pitch(part('garand-clip-eject', 0, cuts), 0.84), -14),
  { note: 'feed cover latch: a Garand clip latch pitched down. No M249 handling recording exists under CC0' });
add('snd-m249-beltClose', ['mg-reload', 'garand-handling'], () =>
  handling(d.mix([
    { clip: part('mg-reload', 2, cuts) },
    { clip: d.pitch(part('garand-handling', 4, { thresholdDb: -26, minGap: 0.1 }), 0.8), db: -4, at: 0.01 },
  ]), -13));
add('snd-m249-magOut', ['mg-reload'], () => handling(part('mg-reload', 0, cuts), -16));
add('snd-m249-magIn', ['mg-reload', 'casing-tile'], () =>
  handling(d.mix([
    { clip: part('mg-reload', 1, cuts) },
    // A light rattle of links as the belt is laid in the tray.
    { clip: d.lowpass(part('casing-tile', 2, { thresholdDb: -30, minGap: 0.15 }), 5000), db: -14, at: 0.12 },
  ]), -14));
add('snd-m249-boltBack', ['ar15-various'], () => handling(d.pitch(part('ar15-various', 5, cuts), 0.86), -14));
add('snd-m249-boltForward', ['m4-reload-sequence'], () => handling(d.pitch(part('m4-reload-sequence', 6, cuts), 0.88), -12));
add('snd-m249-mech', ['ar15-various'], () => mech(d.pitch(part('ar15-various', 1, cuts), 0.85), 0.12));

// ---------------------------------------------------------------- M1911
addSet('snd-m1911-shot', [['m1911-shot'], ['ffsl-1911-near'], ['ffsl-1911-near']], shots([
  near('m1911-shot', 0, { length: 0.5, tau: 0.12 }),
  near('ffsl-1911-near', 0, { length: 0.5, tau: 0.12 }),
  near('ffsl-1911-near', 1, { length: 0.5, tau: 0.12 }),
]));
add('snd-m1911-tail', ['ffsl-1911-mid'], () => tail('ffsl-1911-mid', 0, 2.3), { stereo: true });
add('snd-m1911-dist-1', ['ffsl-1911-mid'], () => distant('ffsl-1911-mid', 1, 1.9));
add('snd-m1911-dry', ['m1911-dryfire'], () => handling(src('m1911-dryfire'), -18));
add('snd-m1911-magOut', ['m1911-mag-out'], () => handling(src('m1911-mag-out'), -16));
add('snd-m1911-magIn', ['pistol-mag-insert'], () => handling(part('pistol-mag-insert', 0, cuts), -15));
add('snd-m1911-boltBack', ['m1911-slide-pull'], () => handling(src('m1911-slide-pull'), -16));
add('snd-m1911-slideRelease', ['m1911-slide-release'], () => handling(src('m1911-slide-release'), -13));
add('snd-m1911-boltForward', ['m1911-slide-release'], () => handling(d.pitch(src('m1911-slide-release'), 1.03), -13));
add('snd-m1911-mech', ['m1911-slide-release'], () => mech(src('m1911-slide-release'), 0.09));
