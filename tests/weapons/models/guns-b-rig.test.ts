/** Tests for the helpers the guns-b rifles share (src/weapons/models/lib/guns-b-rig.ts). */
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { alignSights, directionFrame, gripFrame } from '../../../src/weapons/models/lib/guns-b-rig';

describe('alignSights', () => {
  it('leaves a sight line that already runs down -Z untouched', () => {
    const solution = alignSights(new THREE.Vector3(0, 0.1, -0.1), new THREE.Vector3(0, 0.1, -0.8), 0.3);
    expect(solution.tilt.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 9);
    expect(solution.eye.toArray()).toEqual([0, 0.1, expect.closeTo(0.2, 9)]);
  });

  it('tilts the gun so a rising, skewed sight line ends up parallel to -Z', () => {
    const rear = new THREE.Vector3(0.001, 0.09, -0.12);
    const front = new THREE.Vector3(-0.002, 0.1, -0.83);
    const { tilt, eye } = alignSights(rear, front, 0.25);
    const rearOut = rear.clone().applyQuaternion(tilt);
    const frontOut = front.clone().applyQuaternion(tilt);
    expect(frontOut.x).toBeCloseTo(rearOut.x, 9);
    expect(frontOut.y).toBeCloseTo(rearOut.y, 9);
    expect(frontOut.z).toBeLessThan(rearOut.z);
    expect(eye.x).toBeCloseTo(rearOut.x, 9);
    expect(eye.y).toBeCloseTo(rearOut.y, 9);
    expect(eye.z - rearOut.z).toBeCloseTo(0.25, 9);
  });

  it('rejects a sight line that points backwards or has no length', () => {
    const point = new THREE.Vector3(0, 0.1, -0.1);
    expect(() => alignSights(point, point.clone(), 0.3)).toThrow(/sight/i);
    expect(() => alignSights(point, new THREE.Vector3(0, 0.1, 0.5), 0.3)).toThrow(/sight/i);
  });
});

describe('directionFrame', () => {
  it('returns a rotation whose +X is the given direction', () => {
    const direction = new THREE.Vector3(0.7, 0.6, -0.2);
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(directionFrame(direction));
    expect(axis.distanceTo(direction.clone().normalize())).toBeCloseTo(0, 9);
  });
});

describe('gripFrame', () => {
  it('points -Z along the fingers and +Y toward the thumb, squared up', () => {
    const frame = gripFrame([1, 0.5, 0], [0, 0.2, -1]);
    const fingers = new THREE.Vector3(0, 0, -1).applyQuaternion(frame);
    const thumb = new THREE.Vector3(0, 1, 0).applyQuaternion(frame);
    expect(fingers.distanceTo(new THREE.Vector3(1, 0.5, 0).normalize())).toBeCloseTo(0, 9);
    expect(thumb.dot(fingers)).toBeCloseTo(0, 9);
    expect(thumb.z).toBeLessThan(-0.9);
    expect(thumb.length()).toBeCloseTo(1, 9);
  });

  it('rejects a thumb that runs along the fingers', () => {
    expect(() => gripFrame([0, 0, -1], [0, 0, -2])).toThrow(/thumb/i);
  });
});
