/**
 * Where the rifle sits and where the hands hold it, in the soldier's model
 * space. The gun is placed from the right shoulder and the aim, never from an
 * animated hand, so its direction is exact and the hands (posed by IK
 * afterwards) cannot drift off it.
 */
import { Euler, Quaternion, Vector3 } from 'three/webgpu';
import { CARBINE_POINTS } from './carbine-meta';
import { quatFromBasis } from './ik';

/**
 * Points on the carbine in its own space: barrel along -Z, origin at the
 * pistol grip. The muzzle and butt are measured from the model when it is
 * built; the grips are placed by hand against its profile.
 */
export const CARBINE = {
  muzzle: new Vector3(...CARBINE_POINTS.muzzle),
  /** Upper part of the butt plate, which sits in the shoulder pocket. */
  butt: new Vector3(...CARBINE_POINTS.butt),
  trigger: { position: new Vector3(0.012, 0, 0.006), fingers: new Vector3(0, -0.35, -1), thumb: new Vector3(0, 1, 0) },
  /** The wrist sits below and left of the handguard, so the palm is under it and the fingers wrap up its far side. */
  support: { position: new Vector3(-0.06, 0.045, -0.26), fingers: new Vector3(0.85, 0.25, -0.45), thumb: new Vector3(-0.45, 0.25, -0.85) },
  /** Where the support hand grabs the magazine during a reload. */
  magazine: { position: new Vector3(-0.012, -0.07, -0.15), fingers: new Vector3(0.85, 0.3, -0.3), thumb: new Vector3(-0.3, 0.2, -0.9) },
} as const;

/**
 * The sight line, and how far the shouldered rifle may slide in the shoulder
 * to bring it to the eye. Posture changes where the head sits over the
 * shoulder (standing, crouched, mid-stride), so the last few centimetres are
 * closed here rather than by a fixed offset.
 */
export const SIGHT = {
  /** Height of the eye above the rifle's origin when looking through the sights, metres. */
  height: 0.165,
  /** Most the rifle is raised or lowered, and moved sideways, to meet the eye. */
  maxRaise: 0.05,
  maxShift: 0.03,
} as const;

interface HoldPose {
  /** Butt position relative to the right shoulder joint, model axes, metres. */
  readonly butt: Vector3;
  /** Gun pitch (up positive), yaw (left positive) and roll in radians, before the aim pitch is added. */
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
  /** How much of the aim pitch the gun follows. */
  readonly follow: number;
}

/** Shouldered and sighted. */
const AIMED: HoldPose = { butt: new Vector3(-0.085, 0.06, -0.1), pitch: 0, yaw: 0, roll: 0, follow: 1 };
/** Low ready: butt in the shoulder, muzzle down and across the body. */
const READY: HoldPose = { butt: new Vector3(-0.05, -0.06, -0.1), pitch: -0.62, yaw: 0.42, roll: 0.18, follow: 0.35 };
/** Running: carried across the chest. */
const CARRY: HoldPose = { butt: new Vector3(0.04, -0.3, -0.14), pitch: 0.6, yaw: 1.0, roll: 0.4, follow: 0 };

export interface HoldInput {
  /** 0 ready, 1 aimed. */
  aim: number;
  /** 0 - 1, blends toward the running carry. */
  carry: number;
  /** Aim pitch in radians, up positive. */
  pitch: number;
  /** 0 - 1 kick of the current shot. */
  recoil: number;
  /** -1 - 1, sideways scatter of the current shot. */
  recoilSide: number;
  /** 0 - 1 through a reload, or negative when not reloading. */
  reload: number;
  /** Small breathing and stride sway, radians. */
  swayPitch: number;
  swayYaw: number;
}

const euler = new Euler();
const poseQ = new Quaternion();
const offset = new Vector3();
const gripFrame = new Quaternion();
const axisX = new Vector3();
const axisY = new Vector3();
const axisZ = new Vector3();
const local = new Vector3();

function holdRotation(pose: HoldPose, pitch: number, out: Quaternion): Quaternion {
  // Yaw about the vertical first, then pitch, then roll about the barrel.
  return out.setFromEuler(euler.set(pose.pitch + pitch * pose.follow, pose.yaw, pose.roll, 'YXZ'));
}

function gripRotation(fingers: Vector3, thumb: Vector3, out: Quaternion): Quaternion {
  axisZ.copy(fingers).normalize().negate();
  axisY.copy(thumb).addScaledVector(axisZ, -thumb.dot(axisZ)).normalize();
  axisX.crossVectors(axisY, axisZ);
  return quatFromBasis(axisX, axisY, out);
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

export class GunHold {
  /** Gun origin (pistol grip) and rotation in model space. */
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly triggerPosition = new Vector3();
  readonly triggerRotation = new Quaternion();
  readonly supportPosition = new Vector3();
  readonly supportRotation = new Quaternion();
  private readonly triggerLocal = gripRotation(CARBINE.trigger.fingers, CARBINE.trigger.thumb, new Quaternion());
  private readonly supportLocal = gripRotation(CARBINE.support.fingers, CARBINE.support.thumb, new Quaternion());
  private readonly magazineLocal = gripRotation(CARBINE.magazine.fingers, CARBINE.magazine.thumb, new Quaternion());

  /**
   * Places the gun for the given right shoulder joint position. With `eye`
   * (the aiming eye, in the same space) the shouldered rifle slides to put its
   * sights in front of that eye.
   */
  update(shoulder: Vector3, input: HoldInput, eye?: Vector3): void {
    const aim = smooth(input.aim);
    const carry = smooth(input.carry);
    holdRotation(READY, input.pitch, this.quaternion);
    this.quaternion.slerp(holdRotation(AIMED, input.pitch, poseQ), aim);
    this.quaternion.slerp(holdRotation(CARRY, input.pitch, poseQ), carry);
    offset.copy(READY.butt).lerp(AIMED.butt, aim).lerp(CARRY.butt, carry);

    // Reload: tip the muzzle up and roll the magazine well toward the support hand.
    const reloading = input.reload >= 0;
    const tilt = reloading ? smooth(Math.min(1, input.reload / 0.15, (1 - input.reload) / 0.15)) : 0;
    // Recoil: a short shove back into the shoulder with a little muzzle climb and scatter.
    this.quaternion.multiply(
      poseQ.setFromEuler(euler.set(input.swayPitch + input.recoil * 0.05 + tilt * 0.35, input.swayYaw + input.recoilSide * input.recoil * 0.02, tilt * 0.45, 'YXZ')),
    );
    this.position.copy(shoulder).add(offset);
    local.copy(CARBINE.butt).applyQuaternion(this.quaternion);
    this.position.sub(local);
    local.set(0, 0, input.recoil * 0.03).applyQuaternion(this.quaternion);
    this.position.add(local);

    const sighting = aim * (1 - carry);
    if (eye && sighting > 0) {
      local.copy(eye).sub(this.position).applyQuaternion(poseQ.copy(this.quaternion).invert());
      const raise = Math.min(SIGHT.maxRaise, Math.max(-SIGHT.maxRaise, local.y - SIGHT.height));
      const shift = Math.min(SIGHT.maxShift, Math.max(-SIGHT.maxShift, local.x));
      this.position.add(local.set(shift * sighting, raise * sighting, 0).applyQuaternion(this.quaternion));
    }

    this.triggerPosition.copy(CARBINE.trigger.position).applyQuaternion(this.quaternion).add(this.position);
    this.triggerRotation.copy(this.quaternion).multiply(this.triggerLocal);

    // Support hand: on the fore-end, or working the magazine during a reload.
    this.supportPosition.copy(CARBINE.support.position);
    gripFrame.copy(this.supportLocal);
    if (reloading) {
      const reach = smooth(Math.min(1, input.reload / 0.2, (1 - input.reload) / 0.2));
      // Down and out with the old magazine, back up with the new one.
      const stroke = Math.sin(Math.min(1, Math.max(0, (input.reload - 0.25) / 0.5)) * Math.PI);
      local.copy(CARBINE.magazine.position);
      local.y -= stroke * 0.16;
      local.x -= stroke * 0.05;
      this.supportPosition.lerp(local, reach);
      gripFrame.slerp(this.magazineLocal, reach);
    }
    this.supportPosition.applyQuaternion(this.quaternion).add(this.position);
    this.supportRotation.copy(this.quaternion).multiply(gripFrame);
  }
}
