import { describe, expect, it } from 'vitest';
import {
  airCutoff,
  BLOCKED,
  CLEAR,
  DELAY_FROM_METRES,
  distanceGain,
  finalCutoff,
  landingVolume,
  occlusionFor,
  OPEN_CUTOFF,
  PROFILES,
  propagationDelay,
  RaycastBudget,
  SPEED_OF_SOUND,
  stepLevel,
} from '../../src/audio/curves';

describe('distanceGain', () => {
  it('is full level inside the reference distance', () => {
    expect(distanceGain(0, PROFILES.gunshot)).toBe(1);
    expect(distanceGain(PROFILES.gunshot.ref, PROFILES.gunshot)).toBe(1);
  });

  it('follows inverse distance: about half at twice the reference for rolloff 1', () => {
    const profile = PROFILES.footstep;
    expect(distanceGain(profile.ref * 2, profile)).toBeCloseTo(0.5, 5);
    expect(distanceGain(profile.ref * 4, profile)).toBeCloseTo(0.25, 5);
  });

  it('never rises with distance and reaches zero at the maximum', () => {
    for (const profile of Object.values(PROFILES)) {
      let previous = Infinity;
      for (let d = 0; d <= profile.max + 10; d += profile.max / 200) {
        const gain = distanceGain(d, profile);
        expect(gain).toBeLessThanOrEqual(previous);
        expect(gain).toBeGreaterThanOrEqual(0);
        previous = gain;
      }
      expect(distanceGain(profile.max, profile)).toBe(0);
      expect(distanceGain(profile.max * 2, profile)).toBe(0);
    }
  });

  it('lets gunshots carry much further than footsteps', () => {
    expect(distanceGain(100, PROFILES.gunshot)).toBeGreaterThan(0.08);
    expect(distanceGain(100, PROFILES.footstep)).toBe(0);
  });
});

describe('airCutoff', () => {
  it('is fully open up close', () => {
    expect(airCutoff(0, PROFILES.gunshot)).toBe(OPEN_CUTOFF);
    expect(airCutoff(PROFILES.gunshot.ref, PROFILES.gunshot)).toBe(OPEN_CUTOFF);
  });

  it('halves over each absorption distance', () => {
    const profile = PROFILES.gunshot;
    expect(airCutoff(profile.ref + profile.airHalf, profile)).toBeCloseTo(OPEN_CUTOFF / 2, 3);
    expect(airCutoff(profile.ref + 2 * profile.airHalf, profile)).toBeCloseTo(OPEN_CUTOFF / 4, 3);
  });

  it('closes steadily and stops at the floor', () => {
    const profile = PROFILES.gunshot;
    let previous = Infinity;
    for (let d = 0; d < 2000; d += 10) {
      const cutoff = airCutoff(d, profile);
      expect(cutoff).toBeLessThanOrEqual(previous);
      previous = cutoff;
    }
    expect(airCutoff(5000, profile)).toBe(profile.minCutoff);
  });
});

describe('propagationDelay', () => {
  it('is distance over the speed of sound for far gunshots and impacts', () => {
    expect(propagationDelay(343, PROFILES.gunshot)).toBeCloseTo(1, 6);
    expect(propagationDelay(120, PROFILES.impact)).toBeCloseTo(120 / SPEED_OF_SOUND, 6);
  });

  it('is skipped up close, where it could only blur the shot against its flash', () => {
    expect(propagationDelay(DELAY_FROM_METRES - 1, PROFILES.gunshot)).toBe(0);
    expect(propagationDelay(DELAY_FROM_METRES, PROFILES.gunshot)).toBeGreaterThan(0.08);
  });

  it('never delays footsteps or handling sounds', () => {
    expect(propagationDelay(35, PROFILES.footstep)).toBe(0);
    expect(propagationDelay(25, PROFILES.foley)).toBe(0);
  });
});

describe('occlusion', () => {
  it('leaves a clear path untouched', () => {
    expect(occlusionFor(false)).toBe(CLEAR);
    expect(finalCutoff(0, PROFILES.gunshot, CLEAR)).toBe(OPEN_CUTOFF);
  });

  it('makes a blocked sound quieter and duller but not silent', () => {
    const blocked = occlusionFor(true);
    expect(blocked).toBe(BLOCKED);
    expect(blocked.gain).toBeGreaterThan(0.2);
    expect(blocked.gain).toBeLessThan(0.7);
    expect(finalCutoff(20, PROFILES.gunshot, blocked)).toBeLessThan(finalCutoff(20, PROFILES.gunshot, CLEAR) * 0.3);
    expect(finalCutoff(5000, PROFILES.gunshot, blocked)).toBeGreaterThanOrEqual(400);
  });
});

describe('RaycastBudget', () => {
  it('hands out a fixed number of tests per frame', () => {
    const budget = new RaycastBudget(3);
    expect([budget.take(), budget.take(), budget.take(), budget.take()]).toEqual([true, true, true, false]);
    budget.reset();
    expect(budget.take()).toBe(true);
  });
});

describe('footsteps and landings', () => {
  it('makes running louder and higher than walking, and crouching quietest', () => {
    const walk = stepLevel(false, false);
    const run = stepLevel(true, false);
    const crouch = stepLevel(false, true);
    expect(run.volume).toBeGreaterThan(walk.volume);
    expect(run.pitch).toBeGreaterThan(walk.pitch);
    expect(crouch.volume).toBeLessThan(walk.volume);
    expect(stepLevel(true, true).volume).toBe(crouch.volume);
  });

  it('scales the landing with fall speed inside fixed bounds', () => {
    expect(landingVolume(0)).toBeCloseTo(0.22);
    expect(landingVolume(6)).toBeGreaterThan(landingVolume(3));
    expect(landingVolume(40)).toBe(1);
  });
});
