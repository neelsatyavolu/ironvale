import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../src/core/random';
import { jitter, VariationPicker } from '../../src/audio/variation';

describe('VariationPicker', () => {
  it('never plays the same take twice in a row', () => {
    for (const count of [2, 3, 4, 6]) {
      const picker = new VariationPicker(seededRandom(count));
      let previous = -1;
      for (let i = 0; i < 500; i++) {
        const index = picker.next('shot', count);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(count);
        expect(index).not.toBe(previous);
        previous = index;
      }
    }
  });

  it('uses every take', () => {
    const picker = new VariationPicker(seededRandom(7));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(picker.next('step', 5));
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('tracks groups separately', () => {
    const picker = new VariationPicker(() => 0);
    expect(picker.next('a', 3)).toBe(0);
    expect(picker.next('b', 3)).toBe(0);
    expect(picker.next('a', 3)).toBe(1);
  });

  it('returns 0 for a single take and stays in range when random returns its top value', () => {
    expect(new VariationPicker().next('one', 1)).toBe(0);
    const picker = new VariationPicker(() => 0.999999);
    expect(picker.next('edge', 4)).toBe(3);
    expect(picker.next('edge', 4)).toBe(2);
  });
});

describe('jitter', () => {
  it('stays within plus or minus the amount', () => {
    const random = seededRandom(3);
    for (let i = 0; i < 200; i++) {
      const value = jitter(random, 0.03);
      expect(value).toBeGreaterThanOrEqual(0.97);
      expect(value).toBeLessThanOrEqual(1.03);
    }
    expect(jitter(() => 0.5, 0.03)).toBe(1);
  });
});
