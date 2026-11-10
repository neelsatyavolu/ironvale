// Analysis for the sound build: envelopes, splitting on silence, trimming, spectral centroid, steady windows.
import { SR, biquad, cut, db, duration, gain, loudestRms, map, peak, samples, silence, toDb, toMono } from './dsp-core.mjs';

// ---------------------------------------------------------------- analysis

/** RMS envelope in linear units, one value per hop. */
export function envelope(clip, hopSeconds = 0.004) {
  const mono = toMono(clip)[0];
  const hop = samples(hopSeconds);
  const out = new Float32Array(Math.floor(mono.length / hop));
  for (let k = 0; k < out.length; k++) {
    let sum = 0;
    for (let i = k * hop; i < (k + 1) * hop; i++) sum += mono[i] * mono[i];
    out[k] = Math.sqrt(sum / hop);
  }
  return out;
}

/**
 * Split on silence. A segment is a run where the envelope stays above
 * `thresholdDb` below the clip's loudest hop, allowing gaps shorter than
 * `minGap`. Returns [{ start, end, peakDb, rmsDb }] in seconds.
 */
export function segments(clip, { thresholdDb = -32, minGap = 0.08, minLength = 0.03, pre = 0.004, post = 0.04 } = {}) {
  const hop = 0.004;
  const env = envelope(clip, hop);
  const top = env.reduce((max, value) => Math.max(max, value), 0);
  const limit = top * db(thresholdDb);
  const found = [];
  let start = -1;
  let last = -1;
  for (let k = 0; k <= env.length; k++) {
    const loud = k < env.length && env[k] > limit;
    if (loud) {
      if (start < 0) start = k;
      last = k;
    } else if (start >= 0 && (k === env.length || (k - last) * hop > minGap)) {
      if ((last - start + 1) * hop >= minLength) {
        const from = Math.max(0, start * hop - pre);
        const to = Math.min(duration(clip), (last + 1) * hop + post);
        const part = cut(clip, from, to);
        found.push({ start: from, end: to, peakDb: toDb(peak(part)), rmsDb: toDb(loudestRms(part, 0.05)) });
      }
      start = -1;
    }
  }
  return found;
}

/** Cut each segment out as its own clip. */
export function split(clip, options) {
  return segments(clip, options).map((segment) => ({ ...segment, clip: cut(clip, segment.start, segment.end) }));
}

/** Drop leading silence so the first sample above `thresholdDb` (re peak) sits `pre` seconds in. */
export function trimStart(clip, thresholdDb = -40, pre = 0.002) {
  const mono = toMono(clip)[0];
  const limit = peak(clip) * db(thresholdDb);
  let first = 0;
  while (first < mono.length && Math.abs(mono[first]) < limit) first++;
  return cut(clip, Math.max(0, first / SR - pre));
}

/** Drop the tail once it stays below `thresholdDb` (re peak). */
export function trimEnd(clip, thresholdDb = -50, post = 0.03) {
  const mono = toMono(clip)[0];
  const limit = peak(clip) * db(thresholdDb);
  let last = mono.length - 1;
  while (last > 0 && Math.abs(mono[last]) < limit) last--;
  return cut(clip, 0, Math.min(duration(clip), last / SR + post));
}

export const trim = (clip, startDb = -40, endDb = -50) => trimEnd(trimStart(clip, startDb), endDb);

/** Spectral centroid in Hz over the loudest part of the clip (plain DFT on a decimated window). */
export function centroid(clip) {
  const mono = toMono(clip)[0];
  const size = 4096;
  if (mono.length < 64) return 0;
  let weighted = 0;
  let total = 0;
  const frames = Math.max(1, Math.min(24, Math.floor(mono.length / size)));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let f = 0; f < frames; f++) {
    const offset = Math.floor((f * Math.max(0, mono.length - size)) / Math.max(1, frames - 1 || 1));
    for (let i = 0; i < size; i++) {
      const value = offset + i < mono.length ? mono[offset + i] : 0;
      re[i] = value * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < size / 2; k++) {
      const power = re[k] * re[k] + im[k] * im[k];
      weighted += power * ((k * SR) / size);
      total += power;
    }
  }
  return total > 0 ? weighted / total : 0;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const cos = Math.cos(angle * k);
        const sin = Math.sin(angle * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * cos - im[b] * sin;
        const ti = re[b] * sin + im[b] * cos;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/**
 * Start time of the `seconds`-long window whose loudness varies least, so a
 * loop cut from it has no event that gives the repeat away.
 */
export function steadiestWindow(clip, seconds, skip = 2) {
  const hop = 0.25;
  const env = envelope(clip, hop);
  const count = Math.floor(seconds / hop);
  let best = skip;
  let bestScore = Infinity;
  for (let start = Math.floor(skip / hop); start + count < env.length - Math.floor(skip / hop); start += 2) {
    let min = Infinity;
    let max = 0;
    for (let k = start; k < start + count; k++) {
      min = Math.min(min, env[k]);
      max = Math.max(max, env[k]);
    }
    const score = max / Math.max(min, 1e-6);
    if (score < bestScore) {
      bestScore = score;
      best = start * hop;
    }
  }
  return best;
}

/**
 * Tilt a clip with a high shelf until its spectral centroid reaches `target` Hz
 * (within +/- `range` dB of shelf gain). Takes from different microphones then
 * share one tone and read as one gun or one floor.
 */
export function matchCentroid(clip, target, range = 9, shelfHz = 1800) {
  let low = -range;
  let high = range;
  for (let i = 0; i < 10; i++) {
    const middle = (low + high) / 2;
    if (centroid(biquad(clip, 'highshelf', shelfHz, 0.7, middle)) < target) low = middle;
    else high = middle;
  }
  return biquad(clip, 'highshelf', shelfHz, 0.7, (low + high) / 2);
}

