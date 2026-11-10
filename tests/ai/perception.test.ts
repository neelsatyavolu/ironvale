import { describe, expect, it } from 'vitest';
import { Awareness, effectiveVisionRange, hearingRadius, inVisionCone, VISION } from '../../src/ai/perception';

const DEG = Math.PI / 180;

describe('vision cone', () => {
  const half = VISION.halfAngleCalm;

  it('is about 110 degrees wide when calm and wider when alert', () => {
    expect(half * 2).toBeCloseTo(110 * DEG, 5);
    expect(VISION.halfAngleAlert).toBeGreaterThan(half);
  });

  it('sees a target straight ahead (yaw 0 looks down -Z)', () => {
    expect(inVisionCone(0, 1.6, 0, 0, 0, 1.2, -20, half, 60)).toBe(true);
    expect(inVisionCone(0, 1.6, 0, Math.PI / 2, -20, 1.2, 0, half, 60)).toBe(true);
  });

  it('does not see behind or far to the side', () => {
    expect(inVisionCone(0, 1.6, 0, 0, 0, 1.2, 20, half, 60)).toBe(false);
    const at = (degrees: number) =>
      inVisionCone(0, 1.6, 0, 0, -Math.sin(degrees * DEG) * 20, 1.6, -Math.cos(degrees * DEG) * 20, half, 60);
    expect(at(50)).toBe(true);
    expect(at(-50)).toBe(true);
    expect(at(60)).toBe(false);
    expect(at(-60)).toBe(false);
  });

  it('does not see past its range', () => {
    expect(inVisionCone(0, 1.6, 0, 0, 0, 1.2, -59, half, 60)).toBe(true);
    expect(inVisionCone(0, 1.6, 0, 0, 0, 1.2, -61, half, 60)).toBe(false);
  });

  it('does not see far above or below the cone', () => {
    expect(inVisionCone(0, 1.6, 0, 0, 0, 30, -5, half, 60)).toBe(false);
  });
});

describe('vision range', () => {
  it('is cut by fog', () => {
    expect(effectiveVisionRange(80, 0.004, false, 4)).toBeCloseTo(80, 5);
    const misty = effectiveVisionRange(80, 0.03, false, 4);
    expect(misty).toBeLessThan(65);
    expect(misty).toBeGreaterThan(25);
    expect(effectiveVisionRange(80, 0.06, false, 4)).toBeLessThan(misty);
  });

  it('does not see further through thick mist than a player can', () => {
    // Pinewood: on screen a soldier fades out between 45 and 55 m, whatever the difficulty.
    for (const base of [45, 60, 75, 90]) {
      const range = effectiveVisionRange(base, 0.0215, false, 4);
      expect(range).toBeGreaterThan(35);
      expect(range).toBeLessThan(45);
    }
    // Harbor's clear evening air leaves every difficulty its full range.
    expect(effectiveVisionRange(90, 0.0026, false, 4)).toBe(90);
  });

  it('is shorter against a crouching or motionless target and longer against a sprinting one', () => {
    const walking = effectiveVisionRange(80, 0.004, false, 4);
    expect(effectiveVisionRange(80, 0.004, true, 4)).toBeLessThan(walking);
    expect(effectiveVisionRange(80, 0.004, false, 0)).toBeLessThan(walking);
    expect(effectiveVisionRange(80, 0.004, true, 0)).toBeLessThan(effectiveVisionRange(80, 0.004, true, 4));
    expect(effectiveVisionRange(80, 0.004, false, 6.4)).toBeGreaterThan(walking);
  });
});

describe('hearing', () => {
  it('carries gunshots by loudness, and running further than nothing', () => {
    expect(hearingRadius('shot', 1, 1)).toBeGreaterThan(hearingRadius('shot', 0.7, 1));
    expect(hearingRadius('shot', 0.7, 1)).toBeGreaterThan(hearingRadius('footstep', 1, 1));
    expect(hearingRadius('footstep', 1, 1)).toBeGreaterThan(hearingRadius('impact', 1, 1));
    expect(hearingRadius('shot', 1, 0.7)).toBeLessThan(hearingRadius('shot', 1, 1));
  });
});

describe('Awareness (reaction timer and memory)', () => {
  const step = 1 / 7;

  it('needs the target in view for the whole reaction time before engaging', () => {
    const awareness = new Awareness();
    let elapsed = 0;
    while (!awareness.alerted && elapsed < 5) {
      awareness.update(step, true, 0.6, 10);
      elapsed += step;
    }
    expect(elapsed).toBeGreaterThanOrEqual(0.6);
    expect(elapsed).toBeLessThan(0.6 + step * 1.01);
    expect(awareness.canEngage).toBe(true);
  });

  it('does not react to a glimpse shorter than the reaction time', () => {
    const awareness = new Awareness();
    awareness.update(step, true, 0.6, 10);
    awareness.update(step, true, 0.6, 10);
    for (let i = 0; i < 20; i++) awareness.update(step, false, 0.6, 10);
    expect(awareness.alerted).toBe(false);
    expect(awareness.visibleTime).toBe(0);
  });

  it('keeps part of a glimpse, so repeated peeks add up', () => {
    const awareness = new Awareness();
    for (let i = 0; i < 3; i++) awareness.update(step, true, 0.6, 10);
    awareness.update(step, false, 0.6, 10);
    expect(awareness.visibleTime).toBeGreaterThan(0);
    for (let i = 0; i < 2; i++) awareness.update(step, true, 0.6, 10);
    expect(awareness.alerted).toBe(true);
  });

  it('reacquires a target it already knows about faster than a new one', () => {
    const awareness = new Awareness();
    for (let i = 0; i < 6; i++) awareness.update(step, true, 0.6, 10);
    expect(awareness.alerted).toBe(true);
    for (let i = 0; i < 14; i++) awareness.update(step, false, 0.6, 10);
    expect(awareness.alerted).toBe(true);
    expect(awareness.canEngage).toBe(false);
    awareness.update(step, true, 0.6, 10);
    expect(awareness.canEngage).toBe(false);
    awareness.update(step, true, 0.6, 10);
    expect(awareness.canEngage).toBe(true);
  });

  it('forgets after the memory time with nothing seen', () => {
    const awareness = new Awareness();
    for (let i = 0; i < 6; i++) awareness.update(step, true, 0.6, 3);
    for (let t = 0; t < 2.8; t += step) awareness.update(step, false, 0.6, 3);
    expect(awareness.alerted).toBe(true);
    for (let t = 0; t < 0.5; t += step) awareness.update(step, false, 0.6, 3);
    expect(awareness.alerted).toBe(false);
    expect(awareness.canEngage).toBe(false);
  });

  it('can be alerted from outside (shot at, told by the squad) and then reacts faster', () => {
    const awareness = new Awareness();
    awareness.alert();
    expect(awareness.alerted).toBe(true);
    expect(awareness.canEngage).toBe(false);
    awareness.update(step, true, 0.6, 10);
    awareness.update(step, true, 0.6, 10);
    expect(awareness.canEngage).toBe(true);
  });
});
