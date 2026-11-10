import { Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { basisQuaternion, clampReach, solveElbow, twistAbout } from '../../../src/weapons/models/lib/guns-c-ik';

const UPPER = 0.21;
const FORE = 0.24;

describe('solveElbow', () => {
  it('keeps both bone lengths when the wrist is in reach', () => {
    const shoulder = new Vector3(0.2, -0.4, 0);
    const wrist = new Vector3(0.15, -0.2, -0.3);
    const elbow = solveElbow(shoulder, wrist, UPPER, FORE, new Vector3(0.6, -0.8, 0), new Vector3());
    expect(elbow.distanceTo(shoulder)).toBeCloseTo(UPPER, 6);
    expect(elbow.distanceTo(wrist)).toBeCloseTo(FORE, 6);
  });

  it('bends toward the pole direction', () => {
    const shoulder = new Vector3(0, 0, 0);
    const wrist = new Vector3(0, 0, -0.3);
    const down = solveElbow(shoulder, wrist, UPPER, FORE, new Vector3(0, -1, 0), new Vector3());
    const out = solveElbow(shoulder, wrist, UPPER, FORE, new Vector3(1, 0, 0), new Vector3());
    expect(down.y).toBeLessThan(-0.05);
    expect(Math.abs(down.x)).toBeLessThan(1e-9);
    expect(out.x).toBeGreaterThan(0.05);
  });

  it('straightens along the line to the wrist when the wrist is out of reach', () => {
    const shoulder = new Vector3(0, 0, 0);
    const wrist = new Vector3(0, 0, -2);
    const elbow = solveElbow(shoulder, wrist, UPPER, FORE, new Vector3(0, -1, 0), new Vector3());
    expect(elbow.x).toBeCloseTo(0, 6);
    expect(elbow.y).toBeCloseTo(0, 6);
    expect(elbow.z).toBeCloseTo(-UPPER, 6);
  });

  it('still returns a finite elbow when the pole is parallel to the arm or the wrist is on the shoulder', () => {
    const parallel = solveElbow(new Vector3(), new Vector3(0, -0.3, 0), UPPER, FORE, new Vector3(0, -1, 0), new Vector3());
    const collapsed = solveElbow(new Vector3(), new Vector3(), UPPER, FORE, new Vector3(0, -1, 0), new Vector3());
    for (const elbow of [parallel, collapsed]) {
      expect(Number.isFinite(elbow.x + elbow.y + elbow.z)).toBe(true);
      expect(elbow.length()).toBeCloseTo(UPPER, 6);
    }
  });
});

describe('clampReach', () => {
  it('leaves the shoulder alone when the wrist is in reach', () => {
    const shoulder = new Vector3(0, 0, 0);
    clampReach(shoulder, new Vector3(0, 0, -0.3), 0.1, 0.44);
    expect(shoulder.toArray()).toEqual([0, 0, 0]);
  });

  it('slides the shoulder toward a wrist that is too far, so the arm never stretches', () => {
    const shoulder = new Vector3(0, 0, 0);
    const wrist = new Vector3(0, 0, -1);
    clampReach(shoulder, wrist, 0.1, 0.44);
    expect(shoulder.distanceTo(wrist)).toBeCloseTo(0.44, 9);
    expect(shoulder.z).toBeCloseTo(-0.56, 9);
  });

  it('pushes the shoulder back from a wrist that is too close', () => {
    const shoulder = new Vector3(0, 0, 0);
    const wrist = new Vector3(0, 0, -0.02);
    clampReach(shoulder, wrist, 0.1, 0.44);
    expect(shoulder.distanceTo(wrist)).toBeCloseTo(0.1, 9);
    expect(shoulder.z).toBeGreaterThan(0);
  });
});

describe('basisQuaternion', () => {
  it('turns local -Z onto the direction and local +X toward the hint', () => {
    const direction = new Vector3(0.3, -0.5, -0.8).normalize();
    const hint = new Vector3(1, 0.2, 0);
    const q = basisQuaternion(direction, hint, new Quaternion());
    const forward = new Vector3(0, 0, -1).applyQuaternion(q);
    const side = new Vector3(1, 0, 0).applyQuaternion(q);
    expect(forward.distanceTo(direction)).toBeLessThan(1e-6);
    expect(side.dot(direction)).toBeCloseTo(0, 6);
    expect(side.dot(hint)).toBeGreaterThan(0.9);
    expect(q.length()).toBeCloseTo(1, 6);
  });

  it('copes with a hint parallel to the direction', () => {
    const q = basisQuaternion(new Vector3(0, 0, -1), new Vector3(0, 0, -3), new Quaternion());
    expect(Number.isFinite(q.x + q.y + q.z + q.w)).toBe(true);
    expect(new Vector3(0, 0, -1).applyQuaternion(q).z).toBeCloseTo(-1, 6);
  });
});

describe('twistAbout', () => {
  it('extracts the rotation about the axis and drops the swing', () => {
    const axis = new Vector3(0, 0, -1);
    const twist = new Quaternion().setFromAxisAngle(axis, 0.7);
    const swing = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4);
    const combined = swing.clone().multiply(twist);
    const out = twistAbout(combined, axis, 1, new Quaternion());
    expect(out.angleTo(twist)).toBeLessThan(1e-6);
  });

  it('scales the twist by the given share', () => {
    const axis = new Vector3(0, 0, -1);
    const twist = new Quaternion().setFromAxisAngle(axis, 1.0);
    const half = twistAbout(twist, axis, 0.5, new Quaternion());
    expect(half.angleTo(new Quaternion().setFromAxisAngle(axis, 0.5))).toBeLessThan(1e-6);
  });

  it('takes the short way round for a quaternion with negative w', () => {
    const axis = new Vector3(0, 0, -1);
    const twist = new Quaternion().setFromAxisAngle(axis, 0.6);
    const flipped = new Quaternion(-twist.x, -twist.y, -twist.z, -twist.w);
    const out = twistAbout(flipped, axis, 1, new Quaternion());
    expect(out.angleTo(twist)).toBeLessThan(1e-6);
    expect(out.w).toBeGreaterThan(0);
  });

  it('returns identity for a pure swing', () => {
    const swing = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.9);
    const out = twistAbout(swing, new Vector3(0, 0, -1), 1, new Quaternion());
    expect(out.angleTo(new Quaternion())).toBeLessThan(1e-6);
  });
});
