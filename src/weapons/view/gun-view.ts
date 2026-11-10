import * as THREE from 'three/webgpu';
import type { GunModel, WeaponDef } from '../../game/contracts';
import { HANDLING, type Handling } from '../handling';
import { PartsAnimator } from './parts';

const scratchMatrix = new THREE.Matrix4();
const inverseRoot = new THREE.Matrix4();
const scratchScale = new THREE.Vector3();
const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const noRaycast = (): void => undefined;

/** Loading port of a tube-fed shotgun, relative to the firing grip. */
const LOADING_PORT_FROM_GRIP = new THREE.Vector3(-0.015, 0.03, -0.14);
const CLIP_ABOVE_PORT = 0.045;

/**
 * One gun as the player sees it: the model, its hip and aimed poses, the
 * parts animator and the points the hands move between.
 */
export class GunView {
  readonly handling: Handling;
  readonly parts: PartsAnimator;
  /** Holder pose that puts the model's sight anchor on the camera, looking down its axis. */
  readonly aimPosition = new THREE.Vector3();
  readonly aimQuaternion = new THREE.Quaternion();
  readonly hipPosition = new THREE.Vector3();
  readonly hipQuaternion = new THREE.Quaternion();
  /** Metres from the grip to the muzzle along the barrel. */
  readonly barrelLength: number;
  /** Hand targets handed to the arms. Children of the gun root. */
  readonly triggerTarget = new THREE.Object3D();
  readonly supportTarget = new THREE.Object3D();

  /** Where the support hand goes during a reload, in gun space. Null when the gun has nowhere obvious. */
  private readonly awayNode: THREE.Object3D | null;
  private readonly awayOffset = new THREE.Vector3();
  private readonly triggerRest = new THREE.Vector3();
  private readonly triggerRestQuaternion = new THREE.Quaternion();

  constructor(
    readonly model: GunModel,
    readonly def: WeaponDef,
  ) {
    this.handling = HANDLING[def.weaponClass];
    const root = model.root;
    root.position.set(0, 0, 0);
    root.quaternion.identity();
    root.updateMatrixWorld(true);
    inverseRoot.copy(root.matrixWorld).invert();

    // Aimed: holder * sight = identity, so the eye sits exactly on the sight anchor.
    scratchMatrix.multiplyMatrices(inverseRoot, model.sight.matrixWorld).decompose(scratchPosition, scratchQuaternion, scratchScale);
    this.aimQuaternion.copy(scratchQuaternion).invert();
    this.aimPosition.copy(scratchPosition).applyQuaternion(this.aimQuaternion).negate();

    const [hx, hy, hz] = this.handling.hip;
    const [pitch, yaw, roll] = this.handling.hipTilt;
    this.hipPosition.set(hx, hy, hz);
    this.hipQuaternion.setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));

    scratchMatrix.multiplyMatrices(inverseRoot, model.muzzle.matrixWorld);
    this.barrelLength = Math.max(0.05, -scratchPosition.setFromMatrixPosition(scratchMatrix).z);

    scratchMatrix.multiplyMatrices(inverseRoot, model.grips.trigger.matrixWorld).decompose(this.triggerRest, this.triggerRestQuaternion, scratchScale);

    this.awayNode = this.pickAwayNode();
    this.triggerTarget.name = 'hand_trigger_target';
    this.supportTarget.name = 'hand_support_target';
    root.add(this.triggerTarget, this.supportTarget);
    this.parts = new PartsAnimator(model, def);

    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      // Parented to the camera, so culling by bounds only risks popping; and it must never be hit-tested.
      child.frustumCulled = false;
      child.raycast = noRaycast;
    });
    this.updateHands();
  }

  private pickAwayNode(): THREE.Object3D | null {
    const { parts, ejection, grips } = this.model;
    switch (this.def.reloadStyle) {
      case 'enbloc':
        this.awayOffset.set(0, CLIP_ABOVE_PORT, 0);
        return ejection;
      case 'single-shell':
        this.awayOffset.copy(LOADING_PORT_FROM_GRIP);
        return grips.trigger;
      case 'belt':
        return parts.cover ?? parts.magazine ?? null;
      case 'magazine':
        return parts.magazine ?? null;
    }
  }

  /**
   * Place the hand targets for this frame. Call after the parts and the holder
   * have moved and world matrices are current.
   */
  updateHands(): void {
    const { model, parts } = this;
    inverseRoot.copy(model.root.matrixWorld).invert();

    scratchMatrix.multiplyMatrices(inverseRoot, model.grips.support.matrixWorld);
    scratchMatrix.decompose(this.supportTarget.position, this.supportTarget.quaternion, scratchScale);
    if (this.awayNode && parts.supportAway > 0.001) {
      scratchMatrix.multiplyMatrices(inverseRoot, this.awayNode.matrixWorld);
      scratchPosition.setFromMatrixPosition(scratchMatrix).add(this.awayOffset);
      this.supportTarget.position.lerp(scratchPosition, parts.supportAway);
    }

    this.triggerTarget.position.copy(this.triggerRest);
    this.triggerTarget.quaternion.copy(this.triggerRestQuaternion);
    const bolt = model.parts.bolt;
    if (bolt && parts.triggerAway > 0.001) {
      scratchMatrix.multiplyMatrices(inverseRoot, bolt.matrixWorld);
      scratchPosition.setFromMatrixPosition(scratchMatrix);
      this.triggerTarget.position.lerp(scratchPosition, parts.triggerAway);
    }
    this.triggerTarget.updateMatrixWorld(true);
    this.supportTarget.updateMatrixWorld(true);
  }
}
