import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../src/core/random';
import { energyOf, generateImpulse, IMPULSE_SPECS, measureRt60 } from '../../src/audio/impulse';
import type { ReverbPreset } from '../../src/world/types';

const RATE = 48000;
const PRESETS = Object.keys(IMPULSE_SPECS) as ReverbPreset[];
const make = (preset: ReverbPreset) => generateImpulse(preset, RATE, seededRandom(42));

describe('generateImpulse', () => {
  it('makes two channels of the specified length with finite samples', () => {
    for (const preset of PRESETS) {
      const [left, right] = make(preset);
      expect(left.length).toBe(Math.floor(IMPULSE_SPECS[preset].length * RATE));
      expect(right.length).toBe(left.length);
      expect(left.every(Number.isFinite)).toBe(true);
      expect(right.every(Number.isFinite)).toBe(true);
    }
  });

  it('decays: each quarter of the response holds less energy than the one before', () => {
    for (const preset of PRESETS) {
      const [left] = make(preset);
      const quarter = Math.floor(left.length / 4);
      const energies = [0, 1, 2, 3].map((k) => energyOf(left, k * quarter, (k + 1) * quarter));
      expect(energies[1]).toBeLessThan(energies[0]!);
      expect(energies[2]).toBeLessThan(energies[1]!);
      expect(energies[3]).toBeLessThan(energies[2]!);
      // The end is at least 40 dB below the start, so the buffer does not cut the tail off audibly.
      expect(energies[3]! / energies[0]!).toBeLessThan(1e-4);
    }
  });

  it('has a decay time near its specification', () => {
    for (const preset of ['forest', 'industrial', 'interior'] as const) {
      const [left] = make(preset);
      const measured = measureRt60(left, RATE);
      expect(measured).toBeGreaterThan(IMPULSE_SPECS[preset].rt60 * 0.6);
      expect(measured).toBeLessThan(IMPULSE_SPECS[preset].rt60 * 1.5);
    }
  });

  it('orders the rooms: interior shortest, industrial longest', () => {
    const rt = (preset: ReverbPreset) => measureRt60(make(preset)[0], RATE);
    expect(rt('interior')).toBeLessThan(rt('street'));
    expect(rt('interior')).toBeLessThan(rt('forest'));
    expect(rt('forest')).toBeLessThan(rt('industrial'));
  });

  it('normalises total energy to the preset level', () => {
    for (const preset of PRESETS) {
      const [left, right] = make(preset);
      expect(Math.sqrt(energyOf(left) + energyOf(right))).toBeCloseTo(IMPULSE_SPECS[preset].level, 4);
    }
  });

  it('is different in each ear but repeatable for one seed', () => {
    const [left, right] = make('forest');
    let same = 0;
    for (let i = 0; i < left.length; i++) if (left[i] === right[i]) same++;
    expect(same).toBeLessThan(left.length * 0.2);
    expect(make('forest')[0]).toEqual(left);
  });

  it('keeps the forest darker than the street', () => {
    // Share of energy in sample-to-sample differences rises with brightness.
    const brightness = (data: Float32Array) => {
      let diff = 0;
      for (let i = 1; i < data.length; i++) diff += (data[i]! - data[i - 1]!) ** 2;
      return diff / energyOf(data);
    };
    expect(brightness(make('forest')[0])).toBeLessThan(brightness(make('street')[0]));
  });
});
