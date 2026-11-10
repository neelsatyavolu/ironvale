/**
 * Procedural impulse responses for the convolution reverbs, generated once at
 * startup. Each preset is decaying noise whose tone darkens over time, plus
 * discrete early reflections that give the place its character.
 */
import type { ReverbPreset } from '../world/types';

export interface ImpulseSpec {
  /** Seconds for the tail to fall by 60 dB. */
  readonly rt60: number;
  readonly length: number;
  /** Low-pass at the start and end of the tail, in Hz: air and soft surfaces eat the top first. */
  readonly brightStart: number;
  readonly brightEnd: number;
  /** High-pass in Hz; a thin tail has little below this. */
  readonly lowCut: number;
  /** Seconds before the diffuse tail begins. */
  readonly preDelay: number;
  /** Level of the diffuse tail against the early reflections. */
  readonly tailLevel: number;
  /** Discrete echoes: [seconds, level]. */
  readonly taps: readonly (readonly [number, number])[];
  /** Random early reflections: how many, over how many seconds. */
  readonly scatter: number;
  readonly scatterSpan: number;
  /** Short feedback comb in seconds for a metallic ring; 0 for none. */
  readonly ring: number;
  /** Overall level of the finished response. */
  readonly level: number;
}

export const IMPULSE_SPECS: Readonly<Record<ReverbPreset, ImpulseSpec>> = {
  // Sparse echoes off distant tree lines and a long, thin wash.
  'open-field': {
    rt60: 2.1, length: 2.6, brightStart: 6000, brightEnd: 1200, lowCut: 320, preDelay: 0.09, tailLevel: 0.32,
    taps: [[0.12, 0.5], [0.21, 0.34], [0.37, 0.26], [0.58, 0.16]], scatter: 5, scatterSpan: 0.7, ring: 0, level: 0.75,
  },
  // Trunks scatter everything: diffuse from the start, dark, medium length.
  forest: {
    rt60: 1.15, length: 1.6, brightStart: 3600, brightEnd: 700, lowCut: 180, preDelay: 0.025, tailLevel: 0.8,
    taps: [], scatter: 46, scatterSpan: 0.28, ring: 0, level: 0.85,
  },
  // Slap between facing walls.
  street: {
    rt60: 0.95, length: 1.4, brightStart: 8000, brightEnd: 1800, lowCut: 200, preDelay: 0.02, tailLevel: 0.45,
    taps: [[0.055, 0.8], [0.11, 0.55], [0.165, 0.36], [0.22, 0.22], [0.275, 0.13]], scatter: 8, scatterSpan: 0.2, ring: 0, level: 0.85,
  },
  // Steel sheds and tanks: long and ringing.
  industrial: {
    rt60: 2.6, length: 3.0, brightStart: 9000, brightEnd: 2200, lowCut: 150, preDelay: 0.03, tailLevel: 0.7,
    taps: [[0.07, 0.45], [0.13, 0.3]], scatter: 16, scatterSpan: 0.4, ring: 0.0093, level: 0.8,
  },
  // Small room: dense at once and gone quickly.
  interior: {
    rt60: 0.5, length: 0.75, brightStart: 7000, brightEnd: 2500, lowCut: 120, preDelay: 0.004, tailLevel: 1,
    taps: [[0.009, 0.7], [0.017, 0.55], [0.026, 0.4]], scatter: 30, scatterSpan: 0.06, ring: 0, level: 1,
  },
};

/** Stereo impulse response as two Float32Arrays. `random` returns [0, 1). */
export function generateImpulse(preset: ReverbPreset, sampleRate: number, random: () => number): [Float32Array, Float32Array] {
  const spec = IMPULSE_SPECS[preset];
  const length = Math.floor(spec.length * sampleRate);
  const channels: [Float32Array, Float32Array] = [new Float32Array(length), new Float32Array(length)];
  const decayPerSample = Math.log(0.001) / (spec.rt60 * sampleRate);
  const preDelay = Math.floor(spec.preDelay * sampleRate);
  const highpass = Math.exp((-2 * Math.PI * spec.lowCut) / sampleRate);

  for (const data of channels) {
    // Diffuse tail: noise through a one-pole low-pass whose cutoff falls as the tail decays.
    let low = 0;
    let hpState = 0;
    let previous = 0;
    for (let i = preDelay; i < length; i++) {
      const t = (i - preDelay) / (length - preDelay);
      const cutoff = spec.brightStart * (spec.brightEnd / spec.brightStart) ** t;
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
      low += a * (random() * 2 - 1 - low);
      // One-pole high-pass keeps the tail from adding mud.
      hpState = highpass * (hpState + low - previous);
      previous = low;
      // Tail swells in over a few milliseconds instead of starting with a click.
      const swell = Math.min(1, (i - preDelay) / (0.006 * sampleRate));
      data[i] = hpState * Math.exp(decayPerSample * (i - preDelay)) * swell;
    }
    const tailPeak = peakOf(data) || 1;
    for (let i = 0; i < length; i++) data[i] = (data[i]! / tailPeak) * 0.5 * spec.tailLevel;

    // Early reflections: named taps are near-identical in both ears, scatter is not.
    for (const [time, level] of spec.taps) addTap(data, Math.floor((time + (random() - 0.5) * 0.0015) * sampleRate), level);
    for (let k = 0; k < spec.scatter; k++) {
      const time = spec.preDelay + random() ** 1.5 * spec.scatterSpan;
      addTap(data, Math.floor(time * sampleRate), (0.2 + 0.5 * random()) * Math.exp(decayPerSample * time * sampleRate) * (random() < 0.5 ? -1 : 1));
    }

    if (spec.ring > 0) {
      const delay = Math.floor(spec.ring * sampleRate * (0.97 + 0.06 * random()));
      for (let i = delay; i < length; i++) data[i] = data[i]! + data[i - delay]! * 0.55;
    }
  }

  // Same energy for every preset before its own level, so sends mean the same thing everywhere.
  const energy = Math.sqrt(energyOf(channels[0]) + energyOf(channels[1]));
  const scale = energy > 0 ? spec.level / energy : 0;
  for (const data of channels) for (let i = 0; i < length; i++) data[i] = data[i]! * scale;
  return channels;
}

function addTap(data: Float32Array, index: number, level: number): void {
  // Three samples wide so a tap is a soft click, not a single-sample spike.
  if (index < 1 || index + 1 >= data.length) return;
  data[index - 1] = data[index - 1]! + level * 0.4;
  data[index] = data[index]! + level;
  data[index + 1] = data[index + 1]! + level * 0.4;
}

function peakOf(data: Float32Array): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]!));
  return max;
}

export function energyOf(data: Float32Array, from = 0, to = data.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += data[i]! * data[i]!;
  return sum;
}

/** Seconds for the backward-integrated energy to fall from -5 dB to -25 dB, scaled to 60 dB (T20). */
export function measureRt60(data: Float32Array, sampleRate: number): number {
  const total = energyOf(data);
  if (total === 0) return 0;
  let remaining = total;
  let at5 = -1;
  let at25 = -1;
  for (let i = 0; i < data.length; i++) {
    remaining -= data[i]! * data[i]!;
    const level = 10 * Math.log10(Math.max(remaining, 1e-30) / total);
    if (at5 < 0 && level <= -5) at5 = i;
    if (level <= -25) {
      at25 = i;
      break;
    }
  }
  return at5 < 0 || at25 < 0 ? 0 : ((at25 - at5) / sampleRate) * 3;
}
