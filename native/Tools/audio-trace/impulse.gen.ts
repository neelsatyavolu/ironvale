/**
 * M8b impulse fixtures (PLAN.md section 7). Runs the web's src/audio/impulse.ts, unchanged, with the
 * seed graph.ts uses (`seededRandom(hashString(preset))`) for every reverb preset at the output rates
 * a Mac runs at, and records each channel's SHA-256 over its float32 little-endian bytes. The native
 * ImpulseGenerator must reproduce those bytes exactly.
 *
 *   npx vitest run --config native/Tools/audio-trace/vitest.config.ts
 *
 * Outputs (committed; native/ci/check-m8b.sh regenerates them and fails on drift):
 *   native/Tools/audio-trace/fixtures/impulses.json
 *   native/Tools/audio-trace/fixtures/jsmath-vectors.bin  Math.pow and Math.log as V8 computes them
 *     (float64 LE triples: x, y, result; 4096 pow then 4096 log with y = 0), over the ranges the
 *     impulse generator uses, so a libm mismatch shows up apart from the impulse hashes.
 *
 * Besides the hashes, every PROBE_STRIDE-th sample is kept as its float32 bit pattern, so a native
 * mismatch can be located without the full buffers.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { hashString, seededRandom } from '../../../src/core/random';
import { energyOf, generateImpulse, IMPULSE_SPECS, measureRt60 } from '../../../src/audio/impulse';
import type { ReverbPreset } from '../../../src/world/types';

const FIXTURE = fileURLToPath(new URL('./fixtures/impulses.json', import.meta.url));
const VECTORS = fileURLToPath(new URL('./fixtures/jsmath-vectors.bin', import.meta.url));
const VECTOR_COUNT = 4096;
const RATES = [44100, 48000, 96000];
const PROBE_STRIDE = 997;

const bits = (data: Float32Array): number[] => {
  const words = new Uint32Array(data.buffer, data.byteOffset, data.length);
  const probes: number[] = [];
  for (let i = 0; i < words.length; i += PROBE_STRIDE) probes.push(words[i]!);
  return probes;
};

const channel = (data: Float32Array) => {
  let peak = 0;
  let firstNonZero = -1;
  for (let i = 0; i < data.length; i++) {
    peak = Math.max(peak, Math.abs(data[i]!));
    if (firstNonZero < 0 && data[i] !== 0) firstNonZero = i;
  }
  return {
    sha256: createHash('sha256').update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).digest('hex'),
    peak,
    energy: energyOf(data),
    firstNonZero,
    probes: bits(data),
  };
};

it('writes the M8b impulse fixtures', () => {
  const presets = Object.keys(IMPULSE_SPECS) as ReverbPreset[];
  const impulses = [];
  for (const sampleRate of RATES) {
    for (const preset of presets) {
      const seed = hashString(preset);
      const [left, right] = generateImpulse(preset, sampleRate, seededRandom(seed));
      impulses.push({
        preset,
        sampleRate,
        seed,
        length: left.length,
        rt60: measureRt60(left, sampleRate),
        left: channel(left),
        right: channel(right),
      });
      expect(right.length).toBe(left.length);
    }
  }
  writeFileSync(FIXTURE, `${JSON.stringify({ probeStride: PROBE_STRIDE, impulses }, null, 1)}\n`);
  expect(impulses.length).toBe(RATES.length * presets.length);
});

it('writes the Math.pow / Math.log vectors', () => {
  const random = seededRandom(0x5eed);
  const out = new Float64Array(VECTOR_COUNT * 2 * 3);
  for (let i = 0; i < VECTOR_COUNT; i++) {
    // Half like the tail cutoff (ratio ** t), half like the scatter times (random ** 1.5).
    const x = i % 2 === 0 ? 0.1 + random() * 0.4 : random();
    const y = i % 2 === 0 ? random() : 1.5;
    out.set([x, y, x ** y], i * 3);
  }
  for (let i = 0; i < VECTOR_COUNT; i++) {
    const x = i === 0 ? 0.001 : random() * 10 ** (random() * 8 - 4);
    out.set([x, 0, Math.log(x)], (VECTOR_COUNT + i) * 3);
  }
  writeFileSync(VECTORS, new Uint8Array(out.buffer));
  expect(out.length).toBe(VECTOR_COUNT * 6);
});
