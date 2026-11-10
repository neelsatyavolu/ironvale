/**
 * First-person arms: a rigged pair of sleeved, gloved arms ("First Person
 * arms" by DJMaesen, CC BY 4.0) driven by two-bone IK so the hands sit on a
 * gun's grip anchors.
 *
 * Each frame: the wrist is placed from the grip (palm centre, -Z along the
 * fingers, +Y toward the thumb), the elbow is solved with a pole pointing down
 * and out, and part of the hand's roll is given to the forearm so the wrist
 * does not look wrung. The shoulders sit at fixed points below the view and
 * slide toward the hand only when the gun is pushed out further than the arm
 * can reach, so the arm never stretches. Fingers hold a fixed curl: the
 * trigger hand wraps a pistol grip with the index finger laid along the
 * trigger, the support hand cups a fore-end.
 */
import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Assets } from '../../core/assets';
import type { ArmsRig } from '../../game/contracts';
import type { BuildArms } from './api';
import { FINGER_CURLS, HAND, SHOULDERS, SUPPORT_BLEND_SECONDS, TUCK, type FingerCurls, type Side } from './lib/guns-c-arms-pose';
import { basisQuaternion, clampReach, solveElbow, twistAbout } from './lib/guns-c-ik';

/** Preload this before calling `buildArms`. */
export const ARMS_ASSETS = ['mdl-fp-arms'] as const;

/** The source model is in centimetres and faces +Z. */
const SOURCE_SCALE = 0.01;
const FINGERS = ['point', 'middle', 'ring', 'pink'] as const;

const scratch = {
  matrix: new THREE.Matrix4(),
  rootInverse: new THREE.Matrix4(),
  gripPosition: new THREE.Vector3(),
  gripQuaternion: new THREE.Quaternion(),
  scale: new THREE.Vector3(),
  wrist: new THREE.Vector3(),
  shoulder: new THREE.Vector3(),
  elbow: new THREE.Vector3(),
  upperDirection: new THREE.Vector3(),
  foreDirection: new THREE.Vector3(),
  reach: new THREE.Vector3(),
  hinge: new THREE.Vector3(),
  hand: new THREE.Quaternion(),
  upper: new THREE.Quaternion(),
  fore: new THREE.Quaternion(),
  twist: new THREE.Quaternion(),
  inverse: new THREE.Quaternion(),
};

function bone(root: THREE.Object3D, pattern: RegExp): THREE.Object3D {
  let found: THREE.Object3D | null = null;
  root.traverse((child) => {
    if (!found && pattern.test(child.name)) found = child;
  });
  if (!found) throw new Error(`Arms model has no bone matching ${pattern}`);
  return found;
}

function worldPosition(object: THREE.Object3D): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
}

function worldQuaternion(object: THREE.Object3D): THREE.Quaternion {
  const quaternion = new THREE.Quaternion();
  object.matrixWorld.decompose(new THREE.Vector3(), quaternion, new THREE.Vector3());
  return quaternion;
}

/** Rotate `joint` by `degrees` about `axis` (rig space), on top of its rest pose. */
function curl(joint: THREE.Object3D, axis: THREE.Vector3, degrees: number): void {
  const local = axis.clone().applyQuaternion(worldQuaternion(joint).invert()).normalize();
  joint.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(local, THREE.MathUtils.degToRad(degrees)));
  joint.updateWorldMatrix(false, true);
}

/** One arm: bones, rest-pose measurements and the per-frame solve. */
class Arm {
  private readonly upperBone: THREE.Object3D;
  private readonly foreBone: THREE.Object3D;
  private readonly handBone: THREE.Object3D;
  private readonly upperLength: number;
  private readonly foreLength: number;
  /** Bone orientation relative to the aim-and-hinge frame built by `basisQuaternion`. */
  private readonly upperReference: THREE.Quaternion;
  private readonly foreReference: THREE.Quaternion;
  /** Wrist bone pose in the hand's grip frame. */
  private readonly wristOffset = new THREE.Vector3();
  private readonly wristRotation: THREE.Quaternion;
  /** Inverse of the hand's rest rotation relative to the forearm. */
  private readonly restBendInverse: THREE.Quaternion;
  private readonly foreAxis: THREE.Vector3;
  private readonly parentInverse: THREE.Matrix4;
  private readonly parentRotationInverse: THREE.Quaternion;
  private readonly home: THREE.Vector3;
  private readonly pole: THREE.Vector3;

  /** `model` must have its world matrices current and be at the rig root's origin. */
  constructor(model: THREE.Object3D, side: Side) {
    const right = side === 'R';
    this.upperBone = bone(model, new RegExp(`^${side}_arm`));
    this.foreBone = bone(model, new RegExp(`^${side}_elbow`));
    this.handBone = bone(model, new RegExp(`^${side}_wrist`));
    const parent = this.upperBone.parent;
    if (!parent) throw new Error('Arm bone has no parent');

    const shoulder = worldPosition(this.upperBone);
    const elbow = worldPosition(this.foreBone);
    const wrist = worldPosition(this.handBone);
    const knuckles = FINGERS.map((finger) => worldPosition(bone(model, new RegExp(`^${side}_${finger}1`))));
    this.upperLength = shoulder.distanceTo(elbow);
    this.foreLength = elbow.distanceTo(wrist);

    // Hand frame from the rest pose: forward to the middle knuckle, across from the little finger to the index.
    const forward = knuckles[1].clone().sub(wrist).normalize();
    const across = knuckles[0].clone().sub(knuckles[3]);
    across.addScaledVector(forward, -across.dot(forward)).normalize();
    const palmNormal = right ? across.clone().cross(forward) : forward.clone().cross(across);
    const knuckleCentre = knuckles.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / knuckles.length);
    const palm = wrist
      .clone()
      .lerp(knuckleCentre, HAND.palmAlong)
      .addScaledVector(across, HAND.palmAcross)
      .addScaledVector(palmNormal, HAND.palmDepth);
    const gripFrame = new THREE.Matrix4()
      .makeBasis(forward.clone().cross(across), across, forward.clone().negate())
      .setPosition(palm);
    const gripRotationInverse = new THREE.Quaternion().setFromRotationMatrix(gripFrame).invert();
    this.wristOffset.copy(wrist).applyMatrix4(gripFrame.clone().invert());
    const handRest = worldQuaternion(this.handBone);
    this.wristRotation = gripRotationInverse.clone().multiply(handRest);

    const upperDirection = elbow.clone().sub(shoulder).normalize();
    const foreDirection = wrist.clone().sub(elbow).normalize();
    const hinge = upperDirection.clone().cross(foreDirection).normalize();
    const upperRest = worldQuaternion(this.upperBone);
    const foreRest = worldQuaternion(this.foreBone);
    this.upperReference = basisQuaternion(upperDirection, hinge, new THREE.Quaternion()).invert().multiply(upperRest);
    this.foreReference = basisQuaternion(foreDirection, hinge, new THREE.Quaternion()).invert().multiply(foreRest);
    this.restBendInverse = foreRest.clone().invert().multiply(handRest).invert();
    this.foreAxis = this.handBone.position.clone().normalize();
    this.parentInverse = parent.matrixWorld.clone().invert();
    this.parentRotationInverse = worldQuaternion(parent).invert();
    this.home = new THREE.Vector3(...SHOULDERS[side].home);
    this.pole = new THREE.Vector3(...SHOULDERS[side].pole);

    this.poseFingers(model, side, FINGER_CURLS[side], forward, across, palmNormal);
  }

  private poseFingers(
    model: THREE.Object3D,
    side: Side,
    curls: FingerCurls,
    forward: THREE.Vector3,
    across: THREE.Vector3,
    palmNormal: THREE.Vector3,
  ): void {
    const right = side === 'R';
    // Positive angles close the fingers onto the palm, and bring the thumb across it.
    const closeAxis = right ? across : across.clone().negate();
    const opposeAxis = right ? forward.clone().negate() : forward;
    const spreadAxis = right ? palmNormal.clone().negate() : palmNormal;
    curl(bone(model, new RegExp(`^${side}_point1`)), spreadAxis, curls.pointSpread);
    for (const finger of FINGERS) {
      curls[finger].forEach((degrees, index) => curl(bone(model, new RegExp(`^${side}_${finger}${index + 1}`)), closeAxis, degrees));
    }
    curl(bone(model, new RegExp(`^${side}_palm`)), closeAxis, curls.cup);
    const thumb = bone(model, new RegExp(`^${side}_thumb1`));
    curl(thumb, spreadAxis, curls.thumbSpread);
    curls.thumb.forEach((degrees, index) => curl(bone(model, new RegExp(`^${side}_thumb${index + 1}`)), opposeAxis, degrees));
  }

  /** Pose the arm so the hand's grip frame sits at `position` / `quaternion` (rig space). */
  solve(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    const s = scratch;
    s.hand.copy(quaternion).multiply(this.wristRotation);
    s.wrist.copy(this.wristOffset).applyQuaternion(quaternion).add(position);
    clampReach(s.shoulder.copy(this.home), s.wrist, HAND.minReach, (this.upperLength + this.foreLength) * HAND.maxReach);
    solveElbow(s.shoulder, s.wrist, this.upperLength, this.foreLength, this.pole, s.elbow);

    s.upperDirection.subVectors(s.elbow, s.shoulder).normalize();
    s.foreDirection.subVectors(s.wrist, s.elbow).normalize();
    s.hinge.crossVectors(this.pole, s.reach.subVectors(s.wrist, s.shoulder));
    basisQuaternion(s.upperDirection, s.hinge, s.upper).multiply(this.upperReference);
    basisQuaternion(s.foreDirection, s.hinge, s.fore).multiply(this.foreReference);
    // Roll of the hand away from its rest relation to the forearm, in forearm space.
    s.twist.copy(s.fore).invert().multiply(s.hand).multiply(this.restBendInverse);
    s.fore.multiply(twistAbout(s.twist, this.foreAxis, HAND.forearmTwistShare, s.twist));

    this.upperBone.position.copy(s.shoulder).applyMatrix4(this.parentInverse);
    this.upperBone.quaternion.copy(this.parentRotationInverse).multiply(s.upper);
    this.foreBone.quaternion.copy(s.inverse.copy(s.upper).invert()).multiply(s.fore);
    this.handBone.quaternion.copy(s.inverse.copy(s.fore).invert()).multiply(s.hand);
  }
}

class FirstPersonArms implements ArmsRig {
  readonly root = new THREE.Group();
  private readonly left: Arm;
  private readonly right: Arm;
  private readonly supportPosition = new THREE.Vector3(...TUCK.position);
  private readonly supportQuaternion = new THREE.Quaternion();
  private readonly tuckPosition = new THREE.Vector3(...TUCK.position);
  private readonly tuckQuaternion: THREE.Quaternion;
  private readonly blendPosition = new THREE.Vector3();
  private readonly blendQuaternion = new THREE.Quaternion();
  /** 0 with the off hand tucked away, 1 with it on the gun. */
  private supportWeight = 0;
  private lastUpdate = -1;

  constructor(assets: Assets) {
    this.root.name = 'fp_arms';
    const model = cloneSkinned(assets.gltf(ARMS_ASSETS[0]).scene);
    model.scale.setScalar(SOURCE_SCALE);
    model.rotation.y = Math.PI;
    this.root.add(model);
    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      // The bones move far from the bind pose, so the bind-pose bounds are useless for culling.
      child.frustumCulled = false;
    });
    this.root.updateMatrixWorld(true);
    this.left = new Arm(model, 'L');
    this.right = new Arm(model, 'R');
    const z = new THREE.Vector3(...TUCK.fingers).normalize().negate();
    const y = new THREE.Vector3(...TUCK.thumb);
    y.addScaledVector(z, -y.dot(z)).normalize();
    this.tuckQuaternion = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(y, z), y, z),
    );
    this.supportQuaternion.copy(this.tuckQuaternion);
  }

  update(trigger: THREE.Object3D, support: THREE.Object3D | null): void {
    const s = scratch;
    const now = performance.now();
    const dt = this.lastUpdate < 0 ? 1 : Math.min(0.1, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;

    this.root.updateWorldMatrix(true, false);
    s.rootInverse.copy(this.root.matrixWorld).invert();
    trigger.updateWorldMatrix(true, false);
    s.matrix.multiplyMatrices(s.rootInverse, trigger.matrixWorld).decompose(s.gripPosition, s.gripQuaternion, s.scale);
    this.right.solve(s.gripPosition, s.gripQuaternion);

    if (support) {
      support.updateWorldMatrix(true, false);
      s.matrix.multiplyMatrices(s.rootInverse, support.matrixWorld).decompose(this.supportPosition, this.supportQuaternion, s.scale);
    }
    const step = dt / SUPPORT_BLEND_SECONDS;
    this.supportWeight = THREE.MathUtils.clamp(this.supportWeight + (support ? step : -step), 0, 1);
    const weight = this.supportWeight * this.supportWeight * (3 - 2 * this.supportWeight);
    this.blendPosition.lerpVectors(this.tuckPosition, this.supportPosition, weight);
    this.blendQuaternion.slerpQuaternions(this.tuckQuaternion, this.supportQuaternion, weight);
    this.left.solve(this.blendPosition, this.blendQuaternion);
  }

  dispose(): void {
    // Geometry, textures and materials belong to the asset cache and are shared; only detach.
    this.root.removeFromParent();
  }
}

/**
 * Build the arms. Needs `ARMS_ASSETS` preloaded. The first `update` snaps the
 * off hand straight to where it belongs; after that it eases on and off the
 * gun over `SUPPORT_BLEND_SECONDS`.
 */
export const buildArms: BuildArms = (assets) => new FirstPersonArms(assets);
