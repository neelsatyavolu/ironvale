// Loop building and synthesis for the sound build.
import { SR, decay, fade, map, pitch, samples } from './dsp-core.mjs';

// ---------------------------------------------------------------- loops

export const LOOP_ROLL = 0.3;

/**
 * Turn `body + overlap` seconds of material into a clip that is periodic with
 * period `body`: the tail is cross-faded into the head with equal-power curves.
 * `LOOP_ROLL` seconds of the neighbouring cycle are added on both sides, so any
 * window of length `body` loops cleanly whatever padding the decoder adds.
 */
export function makeLoop(clip, body, overlap) {
  const n = samples(body);
  const x = samples(overlap);
  if (clip[0].length < n + x) throw new Error('loop source is shorter than body + overlap');
  const roll = samples(LOOP_ROLL);
  return map(clip, (channel) => {
    const period = new Float32Array(n);
    for (let i = 0; i < n; i++) period[i] = channel[i + x];
    // The last `x` samples of the period fade out while the material before the head fades in.
    for (let i = 0; i < x; i++) {
      const t = i / x;
      const index = n - x + i;
      period[index] = period[index] * Math.cos((t * Math.PI) / 2) + channel[i] * Math.sin((t * Math.PI) / 2);
    }
    const out = new Float32Array(n + 2 * roll);
    for (let i = 0; i < out.length; i++) out[i] = period[(((i - roll) % n) + n) % n];
    return out;
  });
}

// ---------------------------------------------------------------- synthesis

/** Deterministic random in [0, 1) so every build gives the same files. */
export function seeded(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function noise(seconds, random, channels = 1) {
  return Array.from({ length: channels }, () => Float32Array.from({ length: samples(seconds) }, () => random() * 2 - 1));
}

/** Shape a clip with attack then exponential decay (seconds). */
export function shape(clip, attack, tau) {
  const a = samples(attack);
  return map(clip, (channel) => channel.map((value, i) => value * (i < a ? i / a : Math.exp(-(i - a) / (tau * SR)))));
}

/** Sum of decaying sine partials: [{ f, tau, amp, toF? }]. `toF` glides the pitch. */
export function partials(seconds, list) {
  const out = new Float32Array(samples(seconds));
  for (const partial of list) {
    let phase = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / SR;
      const f = partial.toF ? partial.f + (partial.toF - partial.f) * Math.min(1, t / seconds) : partial.f;
      phase += (2 * Math.PI * f) / SR;
      out[i] += Math.sin(phase) * partial.amp * Math.exp(-t / partial.tau);
    }
  }
  return [out];
}

/** Noise through a band-pass whose centre glides from `fromHz` to `toHz` (a passing whoosh). */
export function sweptNoise(seconds, random, fromHz, toHz, q = 4) {
  const n = samples(seconds);
  const out = new Float32Array(n);
  let low = 0;
  let band = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = fromHz * (toHz / fromHz) ** t;
    const k = 2 * Math.sin((Math.PI * Math.min(f, SR / 6)) / SR);
    const input = random() * 2 - 1;
    low += k * band;
    const high = input - low - band / q;
    band += k * high;
    out[i] = band;
  }
  return [out];
}
