import { Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { calibrateArm, createArmSolution, quatFromBasis, solveArm, type ArmRest } from '../../src/characters/ik';

/** A right arm in a T-pose along +X with deliberately odd bone-local frames, as rigs have. */
function restArm(): ArmRest {
  const odd = (x: number, y: number, z: number) => new Quaternion().setFromAxisAngle(new Vector3(x, y, z).normalize(), 0.9);
  return {
    side: 'right',
    upper: { q: odd(1, 2, 0.3), p: new Vector3(0.2, 1.45, 0) },
    lower: { q: odd(0.2, -1, 0.5), p: new Vector3(0.45, 1.45, 0) },
    hand: { q: odd(-0.4, 0.3, 1), p: new Vector3(0.73, 1.45, 0) },
    fingers: new Vector3(0.82, 1.45, 0),
    thumb: new Vector3(0.77, 1.45, -0.04),
  };
}

const rest = restArm();
const setup = calibrateArm(rest);
const shoulder = new Vector3(0.18, 1.4, 0.05);
const pole = new Vector3(0.5, -0.8, 0.3).normalize();

function solve(gripPosition: Vector3, gripRotation = new Quaternion()) {
  const out = createArmSolution();
  solveArm(setup, shoulder, gripPosition, gripRotation, pole, out);
  return out;
}

/** Where a rest-pose offset ends up once its bone has the solved rotation. */
function carried(restFrom: { q: Quaternion; p: Vector3 }, restTo: Vector3, solved: Quaternion): Vector3 {
  const local = restTo.clone().sub(restFrom.p).applyQuaternion(restFrom.q.clone().invert());
  return local.applyQuaternion(solved);
}

describe('calibrateArm', () => {
  it('measures the bone lengths', () => {
    expect(setup.upperLength).toBeCloseTo(0.25);
    expect(setup.lowerLength).toBeCloseTo(0.28);
  });

  it('reproduces the rest pose when asked for the rest grip', () => {
    // Grip frame of the resting hand: -Z along the fingers, +Y toward the thumb.
    const grip = quatFromBasis(new Vector3(0, 1, 0), new Vector3(0, 0, -1), new Quaternion());
    const hand = grip.clone().multiply(setup.handOffset);
    expect(hand.angleTo(rest.hand.q)).toBeLessThan(1e-4);
  });
});

describe('solveArm', () => {
  const grip = new Vector3(0.12, 1.3, -0.3);

  it('keeps both bone lengths', () => {
    const out = solve(grip);
    expect(out.elbow.distanceTo(shoulder)).toBeCloseTo(setup.upperLength, 5);
    expect(out.wrist.distanceTo(out.elbow)).toBeCloseTo(setup.lowerLength, 5);
  });

  it('puts the palm on the grip', () => {
    const out = solve(grip);
    const palm = out.wrist.clone().add(setup.palmLocal.clone().applyQuaternion(out.hand));
    expect(palm.distanceTo(grip)).toBeLessThan(1e-4);
  });

  it('gives bone rotations that carry the rest offsets onto the solved joints', () => {
    const out = solve(grip);
    const toElbow = carried(rest.upper, rest.lower.p, out.upper);
    expect(shoulder.clone().add(toElbow).distanceTo(out.elbow)).toBeLessThan(1e-4);
    const toWrist = carried(rest.lower, rest.hand.p, out.lower);
    expect(out.elbow.clone().add(toWrist).distanceTo(out.wrist)).toBeLessThan(1e-4);
  });

  it('bends the elbow toward the pole', () => {
    const out = solve(grip);
    const mid = shoulder.clone().add(out.wrist).multiplyScalar(0.5);
    expect(out.elbow.clone().sub(mid).dot(pole)).toBeGreaterThan(0);
  });

  it('stops just short of full extension when the grip is out of reach', () => {
    const out = solve(new Vector3(0.2, 1.4, -3));
    const reach = out.wrist.distanceTo(shoulder);
    expect(reach).toBeLessThan(setup.upperLength + setup.lowerLength);
    expect(reach).toBeGreaterThan((setup.upperLength + setup.lowerLength) * 0.98);
    expect(Number.isFinite(out.upper.x)).toBe(true);
  });

  it('shares a wrist roll between forearm and hand instead of twisting it all at the wrist', () => {
    const flat = solve(grip, new Quaternion());
    const rolled = solve(grip, new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1.2));
    const forearmTurn = flat.lower.angleTo(rolled.lower);
    const handTurn = flat.hand.angleTo(rolled.hand);
    expect(forearmTurn).toBeGreaterThan(0.2);
    expect(forearmTurn).toBeLessThan(handTurn);
  });
});
