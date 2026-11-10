import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { hitTestHumanoid } from '../../src/game/hitbox';

const feet = new Vector3(0, 0, 0);
const forward = new Vector3(0, 0, -1);

describe('hitTestHumanoid', () => {
  it('reports a head hit at head height', () => {
    const hit = hitTestHumanoid(feet, false, new Vector3(0, 1.64, 10), forward, 100);
    expect(hit?.zone).toBe('head');
    expect(hit?.distance).toBeCloseTo(10 - 0.125, 2);
  });

  it('reports torso and limb hits', () => {
    expect(hitTestHumanoid(feet, false, new Vector3(0, 1.2, 10), forward, 100)?.zone).toBe('torso');
    expect(hitTestHumanoid(feet, false, new Vector3(0, 0.5, 10), forward, 100)?.zone).toBe('limb');
  });

  it('misses beside, above and beyond range', () => {
    expect(hitTestHumanoid(feet, false, new Vector3(0.6, 1.2, 10), forward, 100)).toBeNull();
    expect(hitTestHumanoid(feet, false, new Vector3(0, 2.1, 10), forward, 100)).toBeNull();
    expect(hitTestHumanoid(feet, false, new Vector3(0, 1.2, 10), forward, 5)).toBeNull();
  });

  it('hits at once when the muzzle is already inside the body', () => {
    const hit = hitTestHumanoid(feet, false, new Vector3(0.05, 1.2, 0.1), forward, 100);
    expect(hit?.zone).toBe('torso');
    expect(hit?.distance).toBe(0);
  });

  it('ignores targets behind the shooter', () => {
    expect(hitTestHumanoid(feet, false, new Vector3(0, 1.2, -10), forward, 100)).toBeNull();
  });

  it('lowers the head when crouching', () => {
    expect(hitTestHumanoid(feet, true, new Vector3(0, 1.64, 10), forward, 100)).toBeNull();
    expect(hitTestHumanoid(feet, true, new Vector3(0, 1.08, 10), forward, 100)?.zone).toBe('head');
  });
});
