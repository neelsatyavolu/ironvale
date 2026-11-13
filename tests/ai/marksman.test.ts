import { describe, expect, it } from 'vitest';
import { DIFFICULTY } from '../../src/ai/difficulty';
import { botShotSpread, readyToFire, SCOPE_IN_SECONDS } from '../../src/ai/marksman';
import { ROLES } from '../../src/ai/roles';
import { WEAPON_DEFS } from '../../src/weapons/defs';

const sniper = WEAPON_DEFS.m24;
const rifle = WEAPON_DEFS.m4a1;
const veteran = DIFFICULTY.veteran.reactionTime;

describe('readyToFire', () => {
  it('holds a scoped rifle until the full reaction time and the scope-in time have passed', () => {
    expect(readyToFire(sniper, 0.13, veteran)).toBe(false);
    expect(readyToFire(sniper, veteran, veteran)).toBe(false);
    expect(readyToFire(sniper, veteran + SCOPE_IN_SECONDS, veteran)).toBe(true);
  });

  it('gives a player stepping out of cover at least half a second against a sniper on every difficulty', () => {
    for (const profile of Object.values(DIFFICULTY)) {
      expect(readyToFire(sniper, 0.5, profile.reactionTime)).toBe(false);
    }
  });

  it('leaves other weapons to fire as soon as the soldier has noticed', () => {
    expect(readyToFire(rifle, 0, veteran)).toBe(true);
  });
});

describe('botShotSpread', () => {
  const minRange = ROLES.marksman.minRange;

  it('fires a scoped rifle from the hip inside the marksman minimum range', () => {
    expect(botShotSpread(sniper, 0.5, 8, minRange)).toBe(sniper.spreadHip);
    expect(botShotSpread(sniper, 0.5, minRange + 1, minRange)).toBe(0.5);
  });

  it('keeps the aim spread when it is wider than the weapon', () => {
    expect(botShotSpread(sniper, 9, 8, minRange)).toBe(9);
    expect(botShotSpread(rifle, 0.01, 8, ROLES.rifleman.minRange)).toBe(rifle.spreadAim);
  });
});
