// Small offline DSP kit for the sound build. A clip is an array of Float32Array
// channels at SR. Every function returns a new clip; inputs are never changed.
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export const SR = 44100;
export const FFMPEG = process.env.FFMPEG ?? '/opt/homebrew/bin/ffmpeg';

export const db = (value) => 10 ** (value / 20);
export const toDb = (value) => (value > 0 ? 20 * Math.log10(value) : -120);
export const samples = (seconds) => Math.max(0, Math.round(seconds * SR));

// ---------------------------------------------------------------- io

export function decode(path, channels = 1) {
  const out = spawnSync(
    FFMPEG,
    ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', String(channels), '-ar', String(SR), 'pipe:1'],
    { maxBuffer: 1 << 30 },
  );
  if (out.status !== 0) throw new Error(`ffmpeg could not decode ${path}: ${out.stderr}`);
  const all = new Float32Array(out.stdout.buffer, out.stdout.byteOffset, Math.floor(out.stdout.byteLength / 4));
  const length = Math.floor(all.length / channels);
  const clip = Array.from({ length: channels }, () => new Float32Array(length));
  for (let i = 0; i < length; i++) for (let c = 0; c < channels; c++) clip[c][i] = all[i * channels + c];
  return clip;
}

export function writeWav(path, clip) {
  const channels = clip.length;
  const length = clip[0].length;
  const data = Buffer.alloc(44 + length * channels * 3);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + length * channels * 3, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * channels * 3, 28);
  data.writeUInt16LE(channels * 3, 32);
  data.writeUInt16LE(24, 34);
  data.write('data', 36);
  data.writeUInt32LE(length * channels * 3, 40);
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      const value = Math.max(-1, Math.min(1, clip[c][i]));
      data.writeIntLE(Math.round(value * 8388607), offset, 3);
      offset += 3;
    }
  }
  writeFileSync(path, data);
}

export function encodeMp3(wavPath, outPath, kbps) {
  execFileSync(FFMPEG, [
    '-v', 'error', '-y', '-i', wavPath, '-c:a', 'libmp3lame', '-b:a', `${kbps}k`,
    '-ar', String(SR), '-map_metadata', '-1', '-write_xing', '1', '-id3v2_version', '0', outPath,
  ]);
}

// ---------------------------------------------------------------- basics

export const duration = (clip) => clip[0].length / SR;
export const map = (clip, fn) => clip.map((channel, index) => fn(channel, index));
export const silence = (seconds, channels = 1) => Array.from({ length: channels }, () => new Float32Array(samples(seconds)));

export function toMono(clip) {
  if (clip.length === 1) return clip;
  const out = new Float32Array(clip[0].length);
  for (const channel of clip) for (let i = 0; i < out.length; i++) out[i] += channel[i] / clip.length;
  return [out];
}

export function toStereo(clip) {
  return clip.length === 2 ? clip : [clip[0], Float32Array.from(clip[0])];
}

export function cut(clip, from, to = Infinity) {
  const a = Math.min(clip[0].length, samples(from));
  const b = Math.min(clip[0].length, to === Infinity ? clip[0].length : samples(to));
  return map(clip, (channel) => channel.slice(a, Math.max(a, b)));
}

export function gain(clip, decibels) {
  const g = db(decibels);
  return map(clip, (channel) => channel.map((value) => value * g));
}

export function peak(clip) {
  let max = 0;
  for (const channel of clip) for (let i = 0; i < channel.length; i++) max = Math.max(max, Math.abs(channel[i]));
  return max;
}

export function rms(clip) {
  let sum = 0;
  let count = 0;
  for (const channel of clip) {
    for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
    count += channel.length;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

/** RMS of the loudest window of `seconds`; the level a short sound is heard at. */
export function loudestRms(clip, seconds = 0.1) {
  const mono = toMono(clip)[0];
  const window = Math.min(mono.length, samples(seconds));
  let sum = 0;
  for (let i = 0; i < window; i++) sum += mono[i] * mono[i];
  let best = sum;
  for (let i = window; i < mono.length; i++) {
    sum += mono[i] * mono[i] - mono[i - window] * mono[i - window];
    if (sum > best) best = sum;
  }
  return Math.sqrt(best / Math.max(1, window));
}

export function normalizePeak(clip, decibels) {
  const max = peak(clip);
  return max === 0 ? clip : gain(clip, decibels - toDb(max));
}

/** Match the loudest-window RMS to `rmsDb`, then pull back if the peak would pass `ceilingDb`. */
export function normalizeLoudness(clip, rmsDb, ceilingDb = -1, window = 0.1) {
  const level = loudestRms(clip, window);
  if (level === 0) return clip;
  const matched = gain(clip, rmsDb - toDb(level));
  return peak(matched) > db(ceilingDb) ? normalizePeak(matched, ceilingDb) : matched;
}

/**
 * Reach a loudness that plain gain cannot without passing the ceiling: drive the
 * clip into a tanh curve until its loudest window sits at `rmsDb`. Peaky
 * recordings (a raw gunshot, a pebble on steel) get their transient rounded off
 * and their body lifted, so variations of one sound play at one loudness.
 */
export function press(clip, rmsDb, ceilingDb = -1.5, window = 0.05, maxDriveDb = 24) {
  const top = peak(clip);
  if (top === 0) return clip;
  const ceiling = db(ceilingDb);
  const target = db(rmsDb);
  const base = map(clip, (channel) => channel.map((value) => value / top));
  const linear = loudestRms(base, window) * ceiling;
  if (linear >= target) return gain(base, toDb(target / loudestRms(base, window)));
  const driven = (driveDb) => {
    const g = db(driveDb);
    const scale = ceiling / Math.tanh(g);
    return map(base, (channel) => channel.map((value) => Math.tanh(value * g) * scale));
  };
  let low = -20;
  let high = maxDriveDb;
  for (let i = 0; i < 18; i++) {
    const middle = (low + high) / 2;
    if (loudestRms(driven(middle), window) < target) low = middle;
    else high = middle;
  }
  return driven(high);
}

export function fade(clip, inSeconds = 0.002, outSeconds = 0.02, curve = 2) {
  const length = clip[0].length;
  const a = Math.min(length, samples(inSeconds));
  const b = Math.min(length, samples(outSeconds));
  return map(clip, (channel) => {
    const out = Float32Array.from(channel);
    for (let i = 0; i < a; i++) out[i] *= i / a;
    for (let i = 0; i < b; i++) out[length - 1 - i] *= (i / b) ** curve;
    return out;
  });
}

/** Multiply by exp decay starting at `from` seconds with time constant `tau`; shortens long tails. */
export function decay(clip, from, tau) {
  const start = samples(from);
  return map(clip, (channel) => channel.map((value, i) => (i < start ? value : value * Math.exp(-(i - start) / (tau * SR)))));
}

export function concat(...clips) {
  const channels = Math.max(...clips.map((clip) => clip.length));
  const total = clips.reduce((sum, clip) => sum + clip[0].length, 0);
  return Array.from({ length: channels }, (_, c) => {
    const out = new Float32Array(total);
    let offset = 0;
    for (const clip of clips) {
      out.set(clip[Math.min(c, clip.length - 1)], offset);
      offset += clip[0].length;
    }
    return out;
  });
}

/** Sum layers: [{ clip, db?, at? }]. Output is as long as the longest layer. */
export function mix(layers) {
  const channels = Math.max(...layers.map((layer) => layer.clip.length));
  const total = Math.max(...layers.map((layer) => samples(layer.at ?? 0) + layer.clip[0].length));
  return Array.from({ length: channels }, (_, c) => {
    const out = new Float32Array(total);
    for (const layer of layers) {
      const source = layer.clip[Math.min(c, layer.clip.length - 1)];
      const g = db(layer.db ?? 0);
      const offset = samples(layer.at ?? 0);
      for (let i = 0; i < source.length; i++) out[offset + i] += source[i] * g;
    }
    return out;
  });
}

/** Change speed and pitch together by `ratio` (1.06 is about a semitone up), cubic interpolation. */
export function pitch(clip, ratio) {
  return map(clip, (channel) => {
    const out = new Float32Array(Math.floor(channel.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const position = i * ratio;
      const k = Math.floor(position);
      const t = position - k;
      const p0 = channel[Math.max(0, k - 1)];
      const p1 = channel[k];
      const p2 = channel[Math.min(channel.length - 1, k + 1)];
      const p3 = channel[Math.min(channel.length - 1, k + 2)];
      out[i] = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
    }
    return out;
  });
}

// ---------------------------------------------------------------- filters

/** RBJ cookbook biquad. type: lowpass, highpass, bandpass, peaking, lowshelf, highshelf. */
export function biquad(clip, type, frequency, q = 0.707, gainDb = 0) {
  const w = (2 * Math.PI * Math.min(frequency, SR * 0.49)) / SR;
  const cos = Math.cos(w);
  const sin = Math.sin(w);
  const alpha = sin / (2 * q);
  const A = 10 ** (gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') [b0, b1, b2, a0, a1, a2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
  else if (type === 'highpass') [b0, b1, b2, a0, a1, a2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
  else if (type === 'bandpass') [b0, b1, b2, a0, a1, a2] = [alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha];
  else if (type === 'peaking') [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
  else {
    const beta = 2 * Math.sqrt(A) * alpha;
    const sign = type === 'lowshelf' ? 1 : -1;
    b0 = A * (A + 1 - sign * (A - 1) * cos + beta);
    b1 = sign * 2 * A * (A - 1 - sign * (A + 1) * cos);
    b2 = A * (A + 1 - sign * (A - 1) * cos - beta);
    a0 = A + 1 + sign * (A - 1) * cos + beta;
    a1 = -sign * 2 * (A - 1 + sign * (A + 1) * cos);
    a2 = A + 1 + sign * (A - 1) * cos - beta;
  }
  const [n0, n1, n2, d1, d2] = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  return map(clip, (channel) => {
    const out = new Float32Array(channel.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < channel.length; i++) {
      const x = channel[i];
      const y = n0 * x + n1 * x1 + n2 * x2 - d1 * y1 - d2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      out[i] = y;
    }
    return out;
  });
}

export const lowpass = (clip, frequency, q) => biquad(clip, 'lowpass', frequency, q);
export const highpass = (clip, frequency, q) => biquad(clip, 'highpass', frequency, q);
/** 24 dB/octave versions for firmer band limits. */
export const lowpass4 = (clip, frequency) => lowpass(lowpass(clip, frequency, 0.541), frequency, 1.307);
export const highpass4 = (clip, frequency) => highpass(highpass(clip, frequency, 0.541), frequency, 1.307);

