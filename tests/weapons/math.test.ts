import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../src/core/random';
import { WEAPON_DEFS } from '../../src/weapons/defs';
import {
  closestPointOnSegment,
  damageAt,
  damageFalloff,
  sampleCone,
  shotInterval,
  zoneMultiplier,
} from '../../src/weapons/math';

const DEG = Math.PI / 180;

describe('damageFalloff', () => {
  const def = WEAPON_DEFS.m4a1; // full to 35 m, 0.65 at 110 m

  it('is full damage up to the falloff start', () => {
    expect(damageFalloff(def, 0)).toBe(1);
    expect(damageFalloff(def, 35)).toBe(1);
  });

  it('scales linearly between start and end', () => {
    expect(damageFalloff(def, (35 + 110) / 2)).toBeCloseTo((1 + 0.65) / 2, 6);
    expect(damageFalloff(def, 110)).toBeCloseTo(0.65, 6);
  });

  it('stays at the minimum beyond the end', () => {
    expect(damageFalloff(def, 400)).toBeCloseTo(0.65, 6);
  });

  it('never rises with distance', () => {
    let previous = Infinity;
    for (let d = 0; d <= 300; d += 5) {
      const value = damageFalloff(def, d);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('copes with a zero-width falloff band', () => {
    const flat = { falloffStart: 10, falloffEnd: 10, falloffMin: 0.5 };
    expect(damageFalloff(flat, 9)).toBe(1);
    expect(damageFalloff(flat, 11)).toBe(0.5);
  });
});

describe('zone multipliers and damage', () => {
  const def = WEAPON_DEFS.m24;

  it('uses the head and limb multipliers', () => {
    expect(zoneMultiplier(def, 'head')).toBe(def.headshotMultiplier);
    expect(zoneMultiplier(def, 'limb')).toBe(def.limbMultiplier);
    expect(zoneMultiplier(def, 'torso')).toBe(1);
  });

  it('combines base damage, falloff and zone', () => {
    expect(damageAt(def, 10, 'torso')).toBeCloseTo(def.damage, 6);
    expect(damageAt(def, 10, 'head')).toBeCloseTo(def.damage * def.headshotMultiplier, 6);
    expect(damageAt(def, 900, 'limb')).toBeCloseTo(def.damage * def.falloffMin * def.limbMultiplier, 6);
  });
});

describe('shotInterval', () => {
  it('converts rounds per minute to seconds', () => {
    expect(shotInterval(WEAPON_DEFS.m4a1)).toBeCloseTo(0.075, 6);
    expect(shotInterval(WEAPON_DEFS.m1garand)).toBeCloseTo(0.1875, 6);
  });
});

describe('sampleCone', () => {
  const axis = new Vector3(0.3, 0.2, -0.9).normalize();

  it('returns the axis for zero spread', () => {
    const out = sampleCone(axis, 0, seededRandom(1), new Vector3());
    expect(out.distanceTo(axis)).toBeLessThan(1e-9);
  });

  it('keeps every sample unit length and inside the cone', () => {
    const random = seededRandom(42);
    const out = new Vector3();
    for (let i = 0; i < 2000; i++) {
      sampleCone(axis, 3, random, out);
      expect(out.length()).toBeCloseTo(1, 6);
      expect(out.angleTo(axis)).toBeLessThanOrEqual(3 * DEG + 1e-6);
    }
  });

  it('is centred on the axis and fills the disc evenly', () => {
    const random = seededRandom(7);
    const out = new Vector3();
    const mean = new Vector3();
    const half = 4;
    const count = 8000;
    let sumAngle = 0;
    let inner = 0;
    for (let i = 0; i < count; i++) {
      sampleCone(axis, half, random, out);
      mean.add(out);
      const angle = out.angleTo(axis) / DEG;
      sumAngle += angle;
      if (angle < half / 2) inner++;
    }
    mean.normalize();
    expect(mean.angleTo(axis) / DEG).toBeLessThan(0.1);
    // Uniform over a disc: mean radius is 2/3 of the edge, a quarter of the area lies inside half the radius.
    expect(sumAngle / count).toBeCloseTo((2 / 3) * half, 1);
    expect(inner / count).toBeCloseTo(0.25, 1);
  });

  it('is repeatable with the same seed', () => {
    const a = sampleCone(axis, 5, seededRandom(99), new Vector3());
    const b = sampleCone(axis, 5, seededRandom(99), new Vector3());
    expect(a.equals(b)).toBe(true);
  });

  it('works when the axis is straight up', () => {
    const up = new Vector3(0, 1, 0);
    const out = sampleCone(up, 2, seededRandom(3), new Vector3());
    expect(out.angleTo(up)).toBeLessThanOrEqual(2 * DEG + 1e-6);
    expect(Number.isFinite(out.x + out.y + out.z)).toBe(true);
  });
});

describe('closestPointOnSegment', () => {
  const a = new Vector3(0, 0, 0);
  const b = new Vector3(10, 0, 0);

  it('projects onto the segment', () => {
    const p = closestPointOnSegment(a, b, new Vector3(4, 3, 0), new Vector3());
    expect(p.toArray()).toEqual([4, 0, 0]);
  });

  it('clamps to the end points', () => {
    expect(closestPointOnSegment(a, b, new Vector3(-5, 1, 0), new Vector3()).x).toBe(0);
    expect(closestPointOnSegment(a, b, new Vector3(25, 1, 0), new Vector3()).x).toBe(10);
  });
});
