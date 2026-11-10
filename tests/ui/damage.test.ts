import { describe, expect, it } from 'vitest';
import { damageAngle, healthEffects, unwrapAngle } from '../../src/ui/damage';

const HALF = Math.PI / 2;

describe('damageAngle', () => {
  // Yaw 0 looks down -Z; +X is to the right. The angle is clockwise from the top of the screen.
  it('points up for a source straight ahead', () => {
    expect(damageAngle(0, -1, 0)).toBeCloseTo(0);
  });

  it('points right for a source on the right', () => {
    expect(damageAngle(1, 0, 0)).toBeCloseTo(HALF);
  });

  it('points left for a source on the left', () => {
    expect(damageAngle(-1, 0, 0)).toBeCloseTo(-HALF);
  });

  it('points down for a source behind', () => {
    expect(Math.abs(damageAngle(0, 1, 0))).toBeCloseTo(Math.PI);
  });

  it('follows the view as the player turns', () => {
    // Positive yaw turns left, so a source at -Z moves to the right of the screen.
    expect(damageAngle(0, -1, HALF)).toBeCloseTo(HALF);
    // Facing +X (yaw -90 degrees), a source at +X is straight ahead.
    expect(damageAngle(1, 0, -HALF)).toBeCloseTo(0);
    // Facing +Z (yaw 180 degrees), a source at +X is on the left.
    expect(damageAngle(1, 0, Math.PI)).toBeCloseTo(-HALF);
  });

  it('ignores the length of the direction', () => {
    expect(damageAngle(5, -5, 0)).toBeCloseTo(Math.PI / 4);
  });

  it('points up when there is no horizontal direction', () => {
    expect(damageAngle(0, 0, 1.3)).toBe(0);
  });
});

describe('unwrapAngle', () => {
  it('takes the short way across the wrap', () => {
    const next = unwrapAngle(Math.PI - 0.1, -Math.PI + 0.1);
    expect(next).toBeCloseTo(Math.PI + 0.1);
  });

  it('leaves nearby angles alone', () => {
    expect(unwrapAngle(0.2, 0.5)).toBeCloseTo(0.5);
  });

  it('keeps going through several turns', () => {
    const next = unwrapAngle(4 * Math.PI + 0.1, 0.3);
    expect(next).toBeCloseTo(4 * Math.PI + 0.3);
  });
});

describe('healthEffects', () => {
  it('shows nothing at good health', () => {
    expect(healthEffects(100)).toEqual({ vignette: 0, saturation: 1 });
    expect(healthEffects(60)).toEqual({ vignette: 0, saturation: 1 });
  });

  it('grows as health drops', () => {
    const mid = healthEffects(40);
    const low = healthEffects(15);
    expect(mid.vignette).toBeGreaterThan(0);
    expect(low.vignette).toBeGreaterThan(mid.vignette);
    expect(low.saturation).toBeLessThan(mid.saturation);
  });

  it('stays within range at and below zero', () => {
    const dead = healthEffects(-5);
    expect(dead.vignette).toBe(1);
    expect(dead.saturation).toBeGreaterThanOrEqual(0);
    expect(dead.saturation).toBeLessThan(0.5);
  });
});
