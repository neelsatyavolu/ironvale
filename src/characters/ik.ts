/**
 * Two-bone arm IK in the soldier's model space. `calibrateArm` reads the rig's
 * rest pose once; `solveArm` then places a hand on a grip (palm centre, -Z
 * along the fingers, +Y toward the thumb) and returns bone rotations.
 */
import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';

export interface JointRest {
  /** Model-space rest rotation and position. */
  readonly q: Quaternion;
  readonly p: Vector3;
}

export interface ArmRest {
  readonly side: 'left' | 'right';
  readonly upper: JointRest;
  readonly lower: JointRest;
  readonly hand: JointRest;
  /** Model-space rest position of the first finger joint, for the fingers' direction. */
  readonly fingers: Vector3;
  /** Model-space rest position of the thumb's first joint, for the thumb side. */
  readonly thumb: Vector3;
}

export interface ArmSetup {
  readonly upperLength: number;
  readonly lowerLength: number;
  /** Bone rotation = (frame from bone direction and elbow hinge) x offset. */
  readonly upperOffset: Quaternion;
  readonly lowerOffset: Quaternion;
  /** Hand rotation = grip frame x offset. */
  readonly handOffset: Quaternion;
  /** Palm centre in the hand bone's space. */
  readonly palmLocal: Vector3;
  /** The forearm's long axis in its own space. */
  readonly lowerAxis: Vector3;
  /** Hand rotation relative to the forearm at rest. */
  readonly handRest: Quaternion;
}

export interface ArmSolution {
  readonly upper: Quaternion;
  readonly lower: Quaternion;
  readonly hand: Quaternion;
  readonly elbow: Vector3;
  readonly wrist: Vector3;
}

/** How far along the fingers and into the palm the palm centre sits from the wrist, metres. */
const PALM_FORWARD = 0.085;
const PALM_DEPTH = 0.028;
/** Share of the hand's roll the forearm takes, so the wrist skin is not wrung like a sweet wrapper. */
const FOREARM_TWIST_SHARE = 0.55;
const MAX_REACH = 0.995;

const basis = new Matrix4();
const bx = new Vector3();
const by = new Vector3();
const bz = new Vector3();

/** Rotation whose X axis is `x` and whose Y axis is `y` made perpendicular to it. */
export function quatFromBasis(x: Vector3, y: Vector3, out: Quaternion): Quaternion {
  bx.copy(x).normalize();
  bz.crossVectors(bx, y).normalize();
  by.crossVectors(bz, bx);
  return out.setFromRotationMatrix(basis.makeBasis(bx, by, bz));
}

export function createArmSolution(): ArmSolution {
  return { upper: new Quaternion(), lower: new Quaternion(), hand: new Quaternion(), elbow: new Vector3(), wrist: new Vector3() };
}

export function calibrateArm(rest: ArmRest): ArmSetup {
  const upperDir = rest.lower.p.clone().sub(rest.upper.p);
  const lowerDir = rest.hand.p.clone().sub(rest.lower.p);
  const upperLength = upperDir.length();
  const lowerLength = lowerDir.length();
  // In a T-pose the elbow folds the forearm forwards (-Z), so the hinge is the upper arm crossed with forward.
  const forward = new Vector3(0, 0, -1);
  const hinge = upperDir.clone().cross(forward).normalize();
  const upperFrame = quatFromBasis(upperDir, hinge, new Quaternion());
  const lowerFrame = quatFromBasis(lowerDir, hinge, new Quaternion());

  const fingers = rest.fingers.clone().sub(rest.hand.p).normalize();
  const thumb = rest.thumb.clone().sub(rest.hand.p);
  thumb.addScaledVector(fingers, -thumb.dot(fingers)).normalize();
  // Grip frame: Z = -fingers, Y = thumb side, X = Y x Z.
  const gripZ = fingers.clone().negate();
  const gripX = thumb.clone().cross(gripZ);
  const gripRest = quatFromBasis(gripX, thumb, new Quaternion());
  // X of the grip frame is the back of a right hand and the palm of a left hand.
  const palmNormal = gripX.clone().multiplyScalar(rest.side === 'right' ? -1 : 1);
  const palm = fingers.clone().multiplyScalar(PALM_FORWARD).addScaledVector(palmNormal, PALM_DEPTH);
  const handInverse = rest.hand.q.clone().invert();

  return {
    upperLength,
    lowerLength,
    upperOffset: upperFrame.invert().multiply(rest.upper.q),
    lowerOffset: lowerFrame.invert().multiply(rest.lower.q),
    handOffset: gripRest.invert().multiply(rest.hand.q),
    palmLocal: palm.applyQuaternion(handInverse),
    lowerAxis: lowerDir.clone().normalize().applyQuaternion(rest.lower.q.clone().invert()),
    handRest: rest.lower.q.clone().invert().multiply(rest.hand.q),
  };
}

const toWrist = new Vector3();
const dir = new Vector3();
const side = new Vector3();
const elbowDir = new Vector3();
const foreDir = new Vector3();
const hingeAxis = new Vector3();
const frame = new Quaternion();
const relative = new Quaternion();
const twist = new Quaternion();
const identity = new Quaternion();

/**
 * Places the palm on a grip. `shoulder` is the upper arm joint, `pole` the
 * rough direction the elbow should point. Everything is in model space.
 */
export function solveArm(setup: ArmSetup, shoulder: Vector3, gripPosition: Vector3, gripRotation: Quaternion, pole: Vector3, out: ArmSolution): void {
  const { upperLength: l1, lowerLength: l2 } = setup;
  out.hand.copy(gripRotation).multiply(setup.handOffset);
  toWrist.copy(setup.palmLocal).applyQuaternion(out.hand);
  toWrist.subVectors(gripPosition, toWrist).sub(shoulder);
  const wanted = toWrist.length();
  const reach = Math.min(Math.max(wanted, Math.abs(l1 - l2) + 0.01), (l1 + l2) * MAX_REACH);
  if (wanted > 1e-6) dir.copy(toWrist).divideScalar(wanted);
  else dir.set(0, 0, -1);
  out.wrist.copy(shoulder).addScaledVector(dir, reach);

  side.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (side.lengthSq() < 1e-8) side.set(dir.z, 0, -dir.x);
  side.normalize();
  const along = (l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach);
  const across = Math.sqrt(Math.max(0, 1 - along * along));
  elbowDir.copy(dir).multiplyScalar(along).addScaledVector(side, across);
  out.elbow.copy(shoulder).addScaledVector(elbowDir, l1);
  foreDir.subVectors(out.wrist, out.elbow).normalize();
  hingeAxis.crossVectors(elbowDir, foreDir);
  if (hingeAxis.lengthSq() < 1e-8) hingeAxis.crossVectors(dir, side).negate();
  hingeAxis.normalize();

  out.upper.copy(quatFromBasis(elbowDir, hingeAxis, frame)).multiply(setup.upperOffset);
  out.lower.copy(quatFromBasis(foreDir, hingeAxis, frame)).multiply(setup.lowerOffset);

  // Roll of the hand about the forearm beyond its rest relation; the forearm takes a share of it.
  relative.copy(out.lower).invert().multiply(out.hand);
  twist.copy(setup.handRest).invert();
  relative.multiply(twist);
  const axis = setup.lowerAxis;
  const projection = relative.x * axis.x + relative.y * axis.y + relative.z * axis.z;
  twist.set(axis.x * projection, axis.y * projection, axis.z * projection, relative.w);
  if (twist.lengthSq() < 1e-10) return;
  twist.normalize();
  out.lower.multiply(identity.identity().slerp(twist, FOREARM_TWIST_SHARE));
}
