import { describe, expect, it } from 'vitest';
import { Flinch, Recoil, flinchEnvelope } from '../../src/characters/reactions';

describe('flinchEnvelope', () => {
  it('is zero at the hit, peaks within a tenth of a second and has faded by half a second', () => {
    expect(flinchEnvelope(0)).toBe(0);
    let peak = 0;
    let peakTime = 0;
    for (let time = 0; time < 1; time += 0.005) {
      const value = flinchEnvelope(time);
      if (value > peak) {
        peak = value;
        peakTime = time;
      }
    }
    expect(peak).toBeCloseTo(1, 2);
    expect(peakTime).toBeLessThan(0.1);
    expect(flinchEnvelope(0.5)).toBeLessThan(0.02);
  });

  it('ignores times before the hit', () => {
    expect(flinchEnvelope(-1)).toBe(0);
    expect(flinchEnvelope(Infinity)).toBe(0);
  });
});

describe('Flinch', () => {
  const peak = (zone: 'head' | 'torso' | 'limb') => {
    const flinch = new Flinch();
    flinch.hit(zone);
    flinch.update(0.065);
    return flinch;
  };

  it('snaps the head back on a head hit', () => {
    const flinch = peak('head');
    expect(flinch.headPitch).toBeGreaterThan(0.3);
    expect(Math.abs(flinch.headYaw)).toBeGreaterThan(0.1);
  });

  it('twists the chest on a torso hit and buckles the hips on a limb hit', () => {
    expect(Math.abs(peak('torso').torsoYaw)).toBeGreaterThan(0.15);
    expect(peak('torso').hipsRoll).toBe(0);
    expect(Math.abs(peak('limb').hipsRoll)).toBeGreaterThan(0.05);
  });

  it('throws the aim off for a moment whatever was hit', () => {
    expect(peak('limb').gunDip).toBeGreaterThan(0.05);
  });

  it('alternates sides so repeated hits do not look identical', () => {
    const flinch = new Flinch();
    flinch.hit('torso');
    flinch.update(0.065);
    const first = flinch.torsoYaw;
    flinch.hit('torso');
    flinch.update(0.065);
    expect(Math.sign(flinch.torsoYaw)).toBe(-Math.sign(first));
  });

  it('returns exactly to rest', () => {
    const flinch = peak('head');
    for (let i = 0; i < 120; i++) flinch.update(1 / 60);
    expect(flinch.active).toBe(false);
    expect(flinch.headPitch).toBe(0);
    expect(flinch.gunDip).toBe(0);
  });
});

describe('Recoil', () => {
  it('kicks on the first frame of firing', () => {
    const recoil = new Recoil();
    recoil.update(1 / 60, true);
    expect(recoil.value).toBe(1);
  });

  it('repeats at the rate of fire while the trigger is held', () => {
    const recoil = new Recoil();
    let kicks = 0;
    let previous = 0;
    for (let i = 0; i < 60; i++) {
      recoil.update(1 / 60, true);
      if (recoil.value > previous) kicks++;
      previous = recoil.value;
    }
    expect(kicks).toBeGreaterThanOrEqual(9);
    expect(kicks).toBeLessThanOrEqual(12);
  });

  it('settles quickly once firing stops', () => {
    const recoil = new Recoil();
    recoil.update(1 / 60, true);
    for (let i = 0; i < 20; i++) recoil.update(1 / 60, false);
    expect(recoil.value).toBeLessThan(0.01);
  });

  it('survives a long frame without firing a burst of catch-up shots', () => {
    const recoil = new Recoil();
    recoil.update(2, true);
    expect(recoil.value).toBe(1);
    recoil.update(0.01, true);
    expect(recoil.value).toBeLessThan(1);
  });
});
