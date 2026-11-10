import { describe, expect, it } from 'vitest';
import {
  RETARGET_MAP,
  TARGET_PARENT,
  poseAxis,
  quatFromUnitVectors,
  quatMultiply,
  quatRotate,
  referenceRotation,
  retargetRotation,
  solveLeg,
  type Quat,
  type Vec3,
} from '../../src/characters/retarget';

const axisAngle = (axis: Vec3, angle: number): Quat => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 5));

describe('retarget bone map', () => {
  it('maps every source bone to exactly one target bone', () => {
    const sources = RETARGET_MAP.map((entry) => entry.source);
    const targets = RETARGET_MAP.map((entry) => entry.target);
    expect(new Set(sources).size).toBe(sources.length);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('starts at the hips and lists parents before children', () => {
    expect(RETARGET_MAP[0]!.target).toBe('Hips');
    const seen = new Set<string>();
    for (const entry of RETARGET_MAP) {
      const parent = TARGET_PARENT[entry.target];
      if (parent) expect(seen.has(parent)).toBe(true);
      seen.add(entry.target);
    }
  });

  it('covers both sides symmetrically', () => {
    const left = RETARGET_MAP.filter((entry) => entry.target.startsWith('Left')).map((entry) => entry.target.slice(4));
    const right = RETARGET_MAP.filter((entry) => entry.target.startsWith('Right')).map((entry) => entry.target.slice(5));
    expect(left.sort()).toEqual(right.sort());
    expect(left).toContain('ForeArm');
    expect(left).toContain('ToeBase');
  });

  it('aligns limb bones by direction and keeps the spine relative to rest', () => {
    const mode = (target: string) => RETARGET_MAP.find((entry) => entry.target === target)!.align;
    expect(mode('LeftArm')).toBe('direction');
    expect(mode('RightLeg')).toBe('direction');
    expect(mode('Spine1')).toBe('rest');
    expect(mode('LeftHand')).toBe('parent');
  });
});

describe('quaternion helpers', () => {
  it('builds the shortest rotation between two directions', () => {
    const q = quatFromUnitVectors([1, 0, 0], [0, 1, 0]);
    close(quatRotate(q, [1, 0, 0]), [0, 1, 0]);
  });

  it('handles opposite directions', () => {
    const q = quatFromUnitVectors([0, 1, 0], [0, -1, 0]);
    close(quatRotate(q, [0, 1, 0]), [0, -1, 0]);
  });
});

describe('retargetRotation', () => {
  // Source rests in an A-pose (arm 45 degrees down), target in a T-pose.
  const sourceRestDir: Vec3 = [Math.SQRT1_2, -Math.SQRT1_2, 0];
  const targetRestDir: Vec3 = [1, 0, 0];
  const sourceRest = axisAngle([0, 0, 1], 0.3);
  const targetRest = axisAngle([0, 1, 0], 1.1);
  const align = quatFromUnitVectors(sourceRestDir, targetRestDir);
  const reference = referenceRotation(sourceRest, align);

  it('returns the target rest rotation when the source is in the matching pose', () => {
    close(retargetRotation(reference, reference, targetRest), targetRest);
  });

  it('copies the world direction of the source bone', () => {
    const swing = axisAngle([0, 1, 0], 0.8);
    const sourceNow = quatMultiply(swing, sourceRest);
    const sourceDirNow = quatRotate(swing, sourceRestDir);
    const targetNow = retargetRotation(sourceNow, reference, targetRest);
    // The target bone's world direction is its rest direction moved by the same world delta.
    const delta = quatMultiply(targetNow, [-targetRest[0], -targetRest[1], -targetRest[2], targetRest[3]]);
    close(quatRotate(delta, targetRestDir), sourceDirNow);
  });
});

describe('solveLeg', () => {
  const upper = 0.45;
  const lower = 0.42;
  const hip: Vec3 = [0.1, 0.9, 0];
  const right: Vec3 = [1, 0, 0];
  const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  /** How far the knee sits in front (-Z, the way the soldier faces) of the straight line from hip to foot. */
  const kneeAhead = (knee: Vec3, goal: Vec3) => {
    const t = (knee[1] - hip[1]) / (goal[1] - hip[1]);
    return hip[2] + (goal[2] - hip[2]) * t - knee[2];
  };

  it('reaches the foot and keeps both bone lengths', () => {
    const goal: Vec3 = [0.1, 0.25, -0.2];
    const solved = solveLeg(hip, [0.1, 0.5, -0.2], goal, upper, lower, right);
    expect(distance(solved.end, goal)).toBeLessThan(1e-9);
    expect(distance(solved.knee, hip)).toBeCloseTo(upper, 9);
    expect(distance(solved.end, solved.knee)).toBeCloseTo(lower, 9);
  });

  it('stops just short of full stretch when the foot is out of reach', () => {
    const solved = solveLeg(hip, [0.1, 0.5, -0.1], [0.1, -0.5, 0], upper, lower, right);
    expect(distance(solved.end, hip)).toBeLessThan(upper + lower);
    expect(distance(solved.end, hip)).toBeGreaterThan((upper + lower) * 0.99);
  });

  it('bends the knee forwards even when the clip has it behind the leg', () => {
    for (const goal of [[0.1, 0.25, -0.3], [0.1, 0.2, 0], [0.1, 0.3, 0.35]] as Vec3[]) {
      for (const clipKnee of [[0.1, 0.5, -0.3], [0.1, 0.5, 0.4], [0.1, 0.55, 0.05]] as Vec3[]) {
        expect(kneeAhead(solveLeg(hip, clipKnee, goal, upper, lower, right).knee, goal)).toBeGreaterThan(0.05);
      }
    }
  });

  it('lifts the knee above a leg raised out in front', () => {
    const goal: Vec3 = [0.1, 0.85, -0.6];
    const solved = solveLeg(hip, [0.1, 0.6, -0.3], goal, upper, lower, right);
    expect(solved.knee[1]).toBeGreaterThan(0.9);
  });

  it('keeps the sideways splay the clip gives a bent knee', () => {
    const goal: Vec3 = [0.1, 0.3, -0.1];
    const out = solveLeg(hip, [0.3, 0.6, -0.3], goal, upper, lower, right);
    const straight = solveLeg(hip, [0.1, 0.6, -0.3], goal, upper, lower, right);
    expect(out.knee[0]).toBeGreaterThan(straight.knee[0] + 0.05);
  });

  it('moves the knee smoothly as the clip knee swings from in front of the leg to behind it', () => {
    const goal: Vec3 = [0.1, 0.2, 0.05];
    let previous = solveLeg(hip, [0.1, 0.55, -0.3], goal, upper, lower, right).knee;
    for (let z = -0.3; z <= 0.3; z += 0.01) {
      const knee = solveLeg(hip, [0.1, 0.55, z], goal, upper, lower, right).knee;
      expect(distance(knee, previous)).toBeLessThan(0.03);
      previous = knee;
    }
  });
});

describe('poseAxis', () => {
  it('gives the model axis back in the rest pose, whatever the rest rotation of the bone', () => {
    const halfTurn: Quat = [0, 1, 0, 0];
    const axis = poseAxis(halfTurn, halfTurn, [1, 0, 0]);
    expect(axis[0]).toBeCloseTo(1);
    expect(axis[1]).toBeCloseTo(0);
    expect(axis[2]).toBeCloseTo(0);
  });

  it('turns the axis by how far the bone has moved from rest', () => {
    const halfTurn: Quat = [0, 1, 0, 0];
    // A quarter turn to the left about the vertical, on top of the rest rotation.
    const s = Math.SQRT1_2;
    const posed = quatMultiply([0, s, 0, s], halfTurn);
    const axis = poseAxis(posed, halfTurn, [1, 0, 0]);
    expect(axis[0]).toBeCloseTo(0);
    expect(axis[2]).toBeCloseTo(-1);
  });
});
