import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  CASING_TUNING,
  createCasingBody,
  reflectVelocity,
  stepCasing,
  type GroundProbe,
} from '../../src/fx/casing-physics';
import type { RayHit } from '../../src/world/types';

/** Infinite floor at y = 0 and a wall facing -X at x = 2. */
const probe: GroundProbe = (origin, direction, maxDistance) => {
  let best: RayHit | null = null;
  if (direction.y < 0 && origin.y >= 0) {
    const t = -origin.y / direction.y;
    if (t <= maxDistance) {
      best = {
        point: origin.clone().addScaledVector(direction, t),
        normal: new Vector3(0, 1, 0),
        distance: t,
        surface: 'concrete',
      };
    }
  }
  if (direction.x > 0 && origin.x <= 2) {
    const t = (2 - origin.x) / direction.x;
    if (t <= maxDistance && (!best || t < best.distance)) {
      best = {
        point: origin.clone().addScaledVector(direction, t),
        normal: new Vector3(-1, 0, 0),
        distance: t,
        surface: 'metal',
      };
    }
  }
  return best;
};

describe('reflectVelocity', () => {
  it('reverses and damps the normal part and rubs off some of the tangent part', () => {
    const out = reflectVelocity(new Vector3(1, -2, 0), new Vector3(0, 1, 0), 0.4, 0.3, new Vector3());
    expect(out.x).toBeCloseTo(0.7);
    expect(out.y).toBeCloseTo(0.8);
    expect(out.z).toBeCloseTo(0);
  });

  it('leaves a velocity that is already moving away from the surface alone', () => {
    const out = reflectVelocity(new Vector3(1, 2, 0), new Vector3(0, 1, 0), 0.4, 0.3, new Vector3());
    expect(out.toArray()).toEqual([1, 2, 0]);
  });
});

describe('stepCasing', () => {
  const radius = 0.005;

  it('falls, bounces once or twice with less height each time, then rests on the ground', () => {
    const body = createCasingBody();
    body.position.set(0, 1.2, 0);
    body.velocity.set(-1.5, 1, 0);
    const peaks: number[] = [];
    let peak = 0;
    let landings = 0;
    for (let i = 0; i < 600 && !body.resting; i++) {
      const result = stepCasing(body, 1 / 60, probe, radius, CASING_TUNING);
      peak = Math.max(peak, body.position.y);
      if (result === 'landed') landings++;
      if (result === 'landed' || result === 'bounced' || result === 'rested') {
        peaks.push(peak);
        peak = 0;
      }
    }
    expect(body.resting).toBe(true);
    expect(landings).toBe(1);
    expect(body.bounces).toBeGreaterThanOrEqual(1);
    expect(body.bounces).toBeLessThanOrEqual(3);
    expect(body.position.y).toBeCloseTo(radius, 3);
    expect(body.velocity.length()).toBe(0);
    for (let i = 2; i < peaks.length; i++) expect(peaks[i]!).toBeLessThan(peaks[i - 1]!);
    expect(body.surface).toBe('concrete');
  });

  it('never tunnels through the floor on a long frame', () => {
    const body = createCasingBody();
    body.position.set(0, 0.3, 0);
    body.velocity.set(0, -30, 0);
    stepCasing(body, 0.05, probe, radius, CASING_TUNING);
    expect(body.position.y).toBeGreaterThanOrEqual(radius - 1e-6);
  });

  it('bounces off a wall without counting it as landing', () => {
    const body = createCasingBody();
    body.position.set(1.9, 1.5, 0);
    body.velocity.set(4, 0.5, 0);
    let result = stepCasing(body, 1 / 60, probe, radius, CASING_TUNING);
    for (let i = 0; i < 5 && result === 'flying'; i++) result = stepCasing(body, 1 / 60, probe, radius, CASING_TUNING);
    expect(result).toBe('bounced');
    expect(body.landed).toBe(false);
    expect(body.velocity.x).toBeLessThan(0);
    expect(body.position.x).toBeLessThanOrEqual(2);
  });

  it('does nothing once resting', () => {
    const body = createCasingBody();
    body.resting = true;
    body.position.set(1, 1, 1);
    expect(stepCasing(body, 1 / 60, probe, radius, CASING_TUNING)).toBe('resting');
    expect(body.position.toArray()).toEqual([1, 1, 1]);
  });
});
