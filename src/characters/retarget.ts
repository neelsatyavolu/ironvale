/**
 * Bone map and rotation maths for moving clips from the Quaternius Universal
 * Animation Library rig onto the soldier's skeleton. Used by
 * `scripts/process-soldier.mjs` when it bakes the clips; nothing here runs in
 * the game. Plain tuples, no Three, so the script can import it under Node.
 */

export type Quat = readonly [number, number, number, number];
export type Vec3 = readonly [number, number, number];

/**
 * How the source and target rest poses are matched for a bone:
 * - `direction`: rotate the source rest so its bone points the way the
 *   target's does (arms and legs; the source rests in an A-pose).
 * - `rest`: treat both rest poses as the same neutral stance (spine, head, feet).
 * - `parent`: reuse the parent's correction (hands follow the forearm).
 */
export type AlignMode = 'direction' | 'rest' | 'parent';

export interface RetargetEntry {
  readonly source: string;
  readonly target: string;
  readonly align: AlignMode;
  /** Child bones whose position gives the bone direction, for `direction`. */
  readonly sourceChild?: string;
  readonly targetChild?: string;
}

function limb(side: 'l' | 'r'): RetargetEntry[] {
  const Side = side === 'l' ? 'Left' : 'Right';
  return [
    { source: `clavicle_${side}`, target: `${Side}Shoulder`, align: 'rest' },
    { source: `upperarm_${side}`, target: `${Side}Arm`, align: 'direction', sourceChild: `lowerarm_${side}`, targetChild: `${Side}ForeArm` },
    { source: `lowerarm_${side}`, target: `${Side}ForeArm`, align: 'direction', sourceChild: `hand_${side}`, targetChild: `${Side}Hand` },
    { source: `hand_${side}`, target: `${Side}Hand`, align: 'parent' },
    { source: `thigh_${side}`, target: `${Side}UpLeg`, align: 'direction', sourceChild: `calf_${side}`, targetChild: `${Side}Leg` },
    { source: `calf_${side}`, target: `${Side}Leg`, align: 'direction', sourceChild: `foot_${side}`, targetChild: `${Side}Foot` },
    { source: `foot_${side}`, target: `${Side}Foot`, align: 'rest' },
    { source: `ball_${side}`, target: `${Side}ToeBase`, align: 'rest' },
  ];
}

/** Parents come before children. */
export const RETARGET_MAP: readonly RetargetEntry[] = [
  { source: 'pelvis', target: 'Hips', align: 'rest' },
  { source: 'spine_01', target: 'Spine', align: 'rest' },
  { source: 'spine_02', target: 'Spine1', align: 'rest' },
  { source: 'spine_03', target: 'Spine2', align: 'rest' },
  { source: 'neck_01', target: 'Neck', align: 'rest' },
  { source: 'Head', target: 'Head', align: 'rest' },
  ...limb('l'),
  ...limb('r'),
];

/** Parent of each animated target bone; the hips have none. */
export const TARGET_PARENT: Readonly<Record<string, string | undefined>> = {
  Hips: undefined,
  Spine: 'Hips',
  Spine1: 'Spine',
  Spine2: 'Spine1',
  Neck: 'Spine2',
  Head: 'Neck',
  LeftShoulder: 'Spine2',
  LeftArm: 'LeftShoulder',
  LeftForeArm: 'LeftArm',
  LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2',
  RightArm: 'RightShoulder',
  RightForeArm: 'RightArm',
  RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips',
  LeftLeg: 'LeftUpLeg',
  LeftFoot: 'LeftLeg',
  LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips',
  RightLeg: 'RightUpLeg',
  RightFoot: 'RightLeg',
  RightToeBase: 'RightFoot',
};

export function quatMultiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatNormalize(q: Quat): Quat {
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Shortest rotation taking unit vector `from` to unit vector `to`. */
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (dot < -0.999999) {
    // Opposite: any axis perpendicular to `from`.
    const axis: Vec3 = Math.abs(from[0]) > Math.abs(from[2]) ? [-from[1], from[0], 0] : [0, -from[2], from[1]];
    return quatNormalize([axis[0], axis[1], axis[2], 0]);
  }
  return quatNormalize([
    from[1] * to[2] - from[2] * to[1],
    from[2] * to[0] - from[0] * to[2],
    from[0] * to[1] - from[1] * to[0],
    1 + dot,
  ]);
}

/** World rotation the source bone has in the pose that matches the target's rest pose. */
export function referenceRotation(sourceRestWorld: Quat, align: Quat): Quat {
  return quatMultiply(align, sourceRestWorld);
}

/**
 * World rotation for a target bone: the source bone's world-space change from
 * its reference pose, applied to the target's rest rotation.
 */
export function retargetRotation(sourceWorld: Quat, sourceReference: Quat, targetRestWorld: Quat): Quat {
  const delta = quatMultiply(sourceWorld, quatConjugate(sourceReference));
  return quatNormalize(quatMultiply(delta, targetRestWorld));
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit3 = (a: Vec3): Vec3 => scale3(a, 1 / (length3(a) || 1));

/**
 * A model-space axis carried along with a bone: where `axis` points once the
 * bone has turned from its rest rotation to `world`. Rest rotations are not
 * identity on every rig (the soldier's hips rest half a turn about the
 * vertical), so rotating the axis by `world` alone gets the wrong answer.
 */
export function poseAxis(world: Quat, rest: Quat, axis: Vec3): Vec3 {
  return quatRotate(quatMultiply(world, quatConjugate(rest)), axis);
}

/** The clip's own knee direction is trusted once the knee is this far off the hip-to-foot line, as a share of the thigh. */
const KNEE_TRUST = 0.3;
/** A leg is never stretched quite straight, which would leave the knee direction undefined on the next frame. */
const FULL_STRETCH = 0.999;

export interface LegSolution {
  readonly knee: Vec3;
  /** Where the ankle ends up: the goal, or as near as the leg reaches. */
  readonly end: Vec3;
}

/**
 * Bends a two-bone leg so its end reaches `goal`. A knee folds about the
 * pelvis's side-to-side axis (`right`, the soldier's right as the pelvis is
 * posed), which puts it in front of a hanging leg and above one raised
 * forwards. The clip's own knee position is kept for its splay while it
 * agrees with that; it is faded out as the clip's knee nears the hip-to-goal
 * line or crosses behind it, so a knee never folds backwards and never jumps
 * from one frame to the next.
 */
export function solveLeg(hip: Vec3, clipKnee: Vec3, goal: Vec3, upper: number, lower: number, right: Vec3): LegSolution {
  const toGoal = sub3(goal, hip);
  const reach = Math.min(length3(toGoal), (upper + lower) * FULL_STRETCH);
  const axis = unit3(toGoal);
  const front = unit3(cross3(right, axis));
  const offset = sub3(clipKnee, hip);
  const clipSide = sub3(offset, scale3(axis, dot3(offset, axis)));
  const bend = length3(clipSide);
  const trust = bend < 1e-6 ? 0 : Math.min(1, bend / (KNEE_TRUST * upper)) * Math.max(0, dot3(clipSide, front) / bend);
  const side = unit3(add3(scale3(front, 1 - trust), scale3(clipSide, bend < 1e-6 ? 0 : trust / bend)));
  const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
  const out = Math.sqrt(Math.max(0, upper * upper - along * along));
  return { knee: add3(hip, add3(scale3(axis, along), scale3(side, out))), end: add3(hip, scale3(axis, reach)) };
}
