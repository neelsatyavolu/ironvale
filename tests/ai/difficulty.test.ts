import { describe, expect, it } from 'vitest';
import { DIFFICULTY, DIFFICULTY_ORDER, DIFFICULTY_TREND, scaledWeapon } from '../../src/ai/difficulty';
import { WEAPON_DEFS } from '../../src/weapons/defs';

describe('difficulty table', () => {
  it('lists the four settings from easiest to hardest', () => {
    expect(DIFFICULTY_ORDER).toEqual(['recruit', 'regular', 'veteran', 'elite']);
    for (const level of DIFFICULTY_ORDER) expect(DIFFICULTY[level]).toBeDefined();
  });

  it('moves every parameter in one direction as difficulty rises', () => {
    const keys = Object.keys(DIFFICULTY.recruit) as (keyof typeof DIFFICULTY.recruit)[];
    expect(keys.length).toBeGreaterThanOrEqual(10);
    for (const key of keys) {
      const trend = DIFFICULTY_TREND[key];
      for (let i = 1; i < DIFFICULTY_ORDER.length; i++) {
        const easier = DIFFICULTY[DIFFICULTY_ORDER[i - 1]!][key];
        const harder = DIFFICULTY[DIFFICULTY_ORDER[i]!][key];
        if (trend === 'rises') expect(harder, key).toBeGreaterThanOrEqual(easier);
        else expect(harder, key).toBeLessThanOrEqual(easier);
      }
      // No parameter is flat across the whole table.
      expect(DIFFICULTY.elite[key], key).not.toBe(DIFFICULTY.recruit[key]);
    }
  });

  it('keeps recruit forgiving and elite sharp', () => {
    expect(DIFFICULTY.recruit.reactionTime).toBeGreaterThanOrEqual(0.8);
    expect(DIFFICULTY.recruit.damageMultiplier).toBeLessThanOrEqual(0.5);
    expect(DIFFICULTY.recruit.aimErrorAt20m).toBeGreaterThanOrEqual(1);
    expect(DIFFICULTY.elite.reactionTime).toBeLessThanOrEqual(0.3);
    expect(DIFFICULTY.elite.damageMultiplier).toBe(1);
    expect(DIFFICULTY.elite.aimErrorAt20m).toBeLessThanOrEqual(0.5);
    expect(DIFFICULTY.recruit.attackers).toBeLessThanOrEqual(2);
    for (const level of DIFFICULTY_ORDER) expect(DIFFICULTY[level].health).toBeLessThanOrEqual(100);
  });

  it('clones a weapon with scaled damage and leaves the original alone', () => {
    const recruit = scaledWeapon(WEAPON_DEFS.m4a1, 'recruit');
    expect(recruit).not.toBe(WEAPON_DEFS.m4a1);
    expect(recruit.damage).toBeCloseTo(WEAPON_DEFS.m4a1.damage * DIFFICULTY.recruit.damageMultiplier, 6);
    expect(recruit.roundsPerMinute).toBe(WEAPON_DEFS.m4a1.roundsPerMinute);
    expect(WEAPON_DEFS.m4a1.damage).toBe(27);
    expect(scaledWeapon(WEAPON_DEFS.m4a1, 'recruit')).toBe(recruit);
    expect(scaledWeapon(WEAPON_DEFS.m4a1, 'elite').damage).toBe(27);
  });
});
