import { describe, expect, it } from 'vitest';
import { Pose, blendPose, buildClipData, copyPose, sampleClip, steerBone } from '../../src/characters/pose';

const yaw = (angle: number) => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
const angleOf = (pose: Pose, bone: number) => 2 * Math.atan2(pose.rotations[bone * 4 + 1]!, pose.rotations[bone * 4 + 3]!);

/** Two bones, three frames at 2 fps: bone 0 turns 0, 0.4, 0.8 rad; hips rise 0, 1, 2. */
function clip(loop: boolean) {
  const frames = [0, 0.4, 0.8];
  return buildClipData({
    bones: ['A', 'B'],
    fps: 2,
    loop,
    tracks: [
      { name: 'A.quaternion', values: new Float32Array(frames.flatMap(yaw)) },
      { name: 'B.quaternion', values: new Float32Array(frames.flatMap(() => yaw(0.1))) },
      { name: 'Hips.position', values: new Float32Array(frames.flatMap((_, i) => [0, i, 0])) },
    ],
  });
}

describe('sampleClip', () => {
  it('returns exact keys on frame times', () => {
    const pose = new Pose(2);
    sampleClip(clip(false), 0.5, pose);
    expect(angleOf(pose, 0)).toBeCloseTo(0.4);
    expect(pose.hips[1]).toBeCloseTo(1);
  });

  it('interpolates between keys', () => {
    const pose = new Pose(2);
    sampleClip(clip(false), 0.25, pose);
    expect(angleOf(pose, 0)).toBeCloseTo(0.2, 3);
    expect(pose.hips[1]).toBeCloseTo(0.5);
  });

  it('holds the last frame of a one-shot clip', () => {
    const pose = new Pose(2);
    sampleClip(clip(false), 99, pose);
    expect(angleOf(pose, 0)).toBeCloseTo(0.8);
  });

  it('wraps a looping clip, blending the last frame back into the first', () => {
    const pose = new Pose(2);
    const data = clip(true);
    expect(data.duration).toBeCloseTo(1.5);
    sampleClip(data, 1.5 + 0.5, pose);
    expect(angleOf(pose, 0)).toBeCloseTo(0.4);
    sampleClip(data, 1.25, pose);
    expect(angleOf(pose, 0)).toBeCloseTo(0.4, 3);
  });

  it('handles negative time in loops', () => {
    const pose = new Pose(2);
    sampleClip(clip(true), -1, pose);
    expect(angleOf(pose, 0)).toBeCloseTo(0.4);
  });
});

describe('blendPose', () => {
  it('moves part of the way toward the other pose and stays normalised', () => {
    const a = new Pose(1);
    const b = new Pose(1);
    a.rotations.set(yaw(0));
    b.rotations.set(yaw(1));
    b.hips.set([0, 2, 0]);
    blendPose(a, b, 0.5);
    expect(angleOf(a, 0)).toBeCloseTo(0.5, 2);
    expect(a.hips[1]).toBeCloseTo(1);
    expect(Math.hypot(...a.rotations)).toBeCloseTo(1, 6);
  });

  it('takes the short way round when the quaternions have opposite signs', () => {
    const a = new Pose(1);
    const b = new Pose(1);
    a.rotations.set(yaw(0.2));
    b.rotations.set(yaw(0.4).map((value) => -value));
    blendPose(a, b, 0.5);
    expect(Math.abs(angleOf(a, 0))).toBeCloseTo(0.3, 2);
  });

  it('copies a pose', () => {
    const a = new Pose(1);
    const b = new Pose(1);
    b.rotations.set(yaw(1));
    b.hips.set([1, 2, 3]);
    copyPose(a, b);
    expect(Array.from(a.hips)).toEqual([1, 2, 3]);
    expect(angleOf(a, 0)).toBeCloseTo(1);
  });
});

describe('buildClipData', () => {
  it('rejects a clip that is missing a bone track', () => {
    expect(() => buildClipData({ bones: ['A'], fps: 30, loop: true, tracks: [{ name: 'Hips.position', values: [0, 0, 0] }] })).toThrow(/A\.quaternion/);
  });
});

describe('steerBone', () => {
  it('pulls one bone toward a target and leaves the others alone', () => {
    const pose = new Pose(2);
    pose.rotations.set([...yaw(1), ...yaw(0.6)]);
    steerBone(pose, 0, { x: 0, y: 0, z: 0, w: 1 }, 0.5);
    expect(angleOf(pose, 0)).toBeCloseTo(0.5, 1);
    expect(angleOf(pose, 1)).toBeCloseTo(0.6);
  });
});
