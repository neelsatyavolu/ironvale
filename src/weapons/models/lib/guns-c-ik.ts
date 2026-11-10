/**
 * Two-bone inverse kinematics for the first-person arms. Pure maths on
 * caller-owned objects: nothing here allocates after module load.
 */
import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';

const EPSILON = 1e-6;
const direction = new Vector3();
const perpendicular = new Vector3();
const axisX = new Vector3();
const axisY = new Vector3();
const axisZ = new Vector3();
const basis = new Matrix4();

/** Writes into `out` a unit vector perpendicular to `unit`, as close to `hint` as possible. */
function perpendicularTo(unit: Vector3, hint: Vector3, out: Vector3): Vector3 {
  out.copy(hint).addScaledVector(unit, -hint.dot(unit));
  if (out.lengthSq() < EPSILON) {
    // The hint is parallel to the axis: fall back to whichever world axis is least aligned.
    out.set(Math.abs(unit.x) < 0.9 ? 1 : 0, Math.abs(unit.x) < 0.9 ? 0 : 1, 0);
    out.addScaledVector(unit, -out.dot(unit));
  }
  return out.normalize();
}

/**
 * Elbow position for an arm with bone lengths `upper` and `fore` reaching from
 * `shoulder` to `wrist`. The elbow bends toward `pole` (a direction, need not
 * be unit length). When the wrist is out of reach the arm points straight at it.
 */
export function solveElbow(shoulder: Vector3, wrist: Vector3, upper: number, fore: number, pole: Vector3, out: Vector3): Vector3 {
  direction.subVectors(wrist, shoulder);
  const distance = direction.length();
  if (distance < EPSILON) direction.set(0, 0, -1);
  else direction.multiplyScalar(1 / distance);
  const reach = Math.min(Math.max(distance, Math.abs(upper - fore) + EPSILON), upper + fore);
  const along = (upper * upper - fore * fore + reach * reach) / (2 * reach);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  perpendicularTo(direction, pole, perpendicular);
  return out.copy(shoulder).addScaledVector(direction, along).addScaledVector(perpendicular, height);
}

/**
 * Moves `shoulder` along the line to `wrist` so their distance stays within
 * [minReach, maxReach]. This is what keeps the arm from stretching when the
 * gun is pushed further out than the arm is long.
 */
export function clampReach(shoulder: Vector3, wrist: Vector3, minReach: number, maxReach: number): Vector3 {
  direction.subVectors(wrist, shoulder);
  const distance = direction.length();
  if (distance >= minReach && distance <= maxReach) return shoulder;
  if (distance < EPSILON) direction.set(0, 0, -1);
  else direction.multiplyScalar(1 / distance);
  return shoulder.copy(wrist).addScaledVector(direction, -(distance > maxReach ? maxReach : minReach));
}

/**
 * Rotation that turns local -Z onto `aim` (unit length) and local +X as close
 * to `hint` as the aim allows.
 */
export function basisQuaternion(aim: Vector3, hint: Vector3, out: Quaternion): Quaternion {
  axisZ.copy(aim).negate();
  perpendicularTo(axisZ, hint, axisX);
  axisY.crossVectors(axisZ, axisX);
  return out.setFromRotationMatrix(basis.makeBasis(axisX, axisY, axisZ));
}

/**
 * The part of rotation `q` that turns about `axis` (unit length), scaled by
 * `share` (0 - 1), taking the short way round. Used to hand some of the
 * hand's roll to the forearm so the wrist does not look wrung.
 */
export function twistAbout(q: Quaternion, axis: Vector3, share: number, out: Quaternion): Quaternion {
  const projection = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  const sign = q.w < 0 ? -1 : 1;
  const angle = 2 * Math.atan2(projection * sign, q.w * sign);
  return out.setFromAxisAngle(axis, angle * share);
}
