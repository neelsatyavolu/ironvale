import { describe, expect, it } from 'vitest';
import { CLIP_META } from '../../src/characters/clip-meta';
import {
  GAIT_CLIPS,
  advancePhase,
  clipTimeAtPhase,
  createGaitWeights,
  cycleLength,
  gaitWeights,
  resolveHeading,
} from '../../src/characters/locomotion';

const DEG = Math.PI / 180;
const weightsAt = (speed: number, crouch = 0) => gaitWeights(speed, crouch, createGaitWeights());
const total = (weights: Record<string, number>) => Object.values(weights).reduce((sum, value) => sum + value, 0);

describe('gaitWeights', () => {
  it('always sums to one', () => {
    for (const crouch of [0, 0.3, 1]) {
      for (let speed = 0; speed < 8; speed += 0.17) expect(total(weightsAt(speed, crouch))).toBeCloseTo(1, 6);
    }
  });

  it('idles when still', () => {
    expect(weightsAt(0).idle).toBe(1);
    expect(weightsAt(0, 1).crouchIdle).toBe(1);
  });

  it('uses one clean clip at the speeds the bots move at', () => {
    expect(weightsAt(1.7).walk).toBe(1);
    expect(weightsAt(3.4).jog).toBe(1);
    expect(weightsAt(5.6).run).toBe(1);
    expect(weightsAt(1.8, 1).crouchJog).toBe(1);
  });

  it('blends neighbouring gaits between bands and never three at once', () => {
    const mixed = weightsAt(2.35);
    expect(mixed.walk).toBeGreaterThan(0);
    expect(mixed.jog).toBeGreaterThan(0);
    for (let speed = 0; speed < 8; speed += 0.1) {
      const active = GAIT_CLIPS.filter((clip) => weightsAt(speed)[clip] > 0);
      expect(active.length).toBeLessThanOrEqual(2);
    }
  });

  it('cross-fades standing and crouched sets by the crouch amount', () => {
    const half = weightsAt(0, 0.5);
    expect(half.idle).toBeCloseTo(0.5);
    expect(half.crouchIdle).toBeCloseTo(0.5);
  });
});

describe('stride phase', () => {
  it('covers exactly one stride length of ground per cycle, so planted feet do not slide', () => {
    for (const speed of [1.7, 3.4, 5.2]) {
      const weights = weightsAt(speed);
      const length = cycleLength(weights);
      let phase = 0;
      let travelled = 0;
      let cycles = 0;
      const dt = 1 / 240;
      while (cycles < 3) {
        const next = advancePhase(phase, speed, weights, dt, false);
        if (next < phase) cycles++;
        phase = next;
        travelled += speed * dt;
      }
      expect(travelled / 3).toBeCloseTo(length, 1);
    }
  });

  it('matches each clip at its natural speed', () => {
    const weights = weightsAt(CLIP_META.jog.speed);
    expect(cycleLength(weights)).toBeCloseTo(CLIP_META.jog.speed * CLIP_META.jog.duration, 5);
  });

  it('does not advance when standing still', () => {
    expect(advancePhase(0.3, 0, weightsAt(0), 0.016, false)).toBe(0.3);
  });

  it('runs backwards when reversing and stays in [0, 1)', () => {
    const weights = weightsAt(1.7);
    const phase = advancePhase(0.001, 1.7, weights, 0.05, true);
    expect(phase).toBeGreaterThan(0.9);
    expect(phase).toBeLessThan(1);
  });

  it('caps the cadence so a very fast mover does not blur its legs', () => {
    const weights = weightsAt(1.7);
    const fast = advancePhase(0, 30, weights, 0.1, false);
    expect(fast).toBeLessThanOrEqual(0.3);
  });

  it('lines clips up on the left foot strike', () => {
    expect(clipTimeAtPhase('walk', 0)).toBeCloseTo(CLIP_META.walk.strike * CLIP_META.walk.duration, 5);
    const time = clipTimeAtPhase('jog', 0.5);
    expect(time).toBeGreaterThanOrEqual(0);
    expect(time).toBeLessThan(CLIP_META.jog.duration);
  });
});

describe('resolveHeading', () => {
  it('faces the legs along the movement when going forwards', () => {
    expect(resolveHeading(0, false)).toEqual({ hipYaw: 0, reverse: false });
    expect(resolveHeading(30 * DEG, false).hipYaw).toBeCloseTo(30 * DEG);
  });

  it('limits how far the hips twist when strafing', () => {
    const heading = resolveHeading(90 * DEG, false);
    expect(heading.reverse).toBe(false);
    expect(heading.hipYaw).toBeLessThan(61 * DEG);
  });

  it('backpedals when moving away from the facing', () => {
    const heading = resolveHeading(170 * DEG, false);
    expect(heading.reverse).toBe(true);
    expect(heading.hipYaw).toBeCloseTo(-10 * DEG);
  });

  it('keeps its choice near the sideways boundary', () => {
    expect(resolveHeading(100 * DEG, false).reverse).toBe(false);
    expect(resolveHeading(100 * DEG, true).reverse).toBe(true);
  });
});
