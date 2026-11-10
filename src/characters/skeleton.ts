/**
 * One soldier's animated bones. Takes a sampled `Pose`, runs forward
 * kinematics in model space with per-bone corrections (aim pitch, hip twist,
 * flinch), then lets the arm IK overwrite the arms. Model space is the
 * soldier's own frame: feet at the origin, facing -Z.
 */
import { Object3D, Quaternion, Vector3 } from 'three/webgpu';
import { CLIP_BONES } from './clip-meta';
import type { ArmSolution } from './ik';
import type { Pose } from './pose';
import { BONE_INDEX, type ArmRig, type SoldierRig } from './rig';

const parentQ = new Quaternion();
const scratch = new Quaternion();
const identity = new Quaternion();
const chain = new Quaternion();
const SPINE_CHAIN = [BONE_INDEX.Hips, BONE_INDEX.Spine, BONE_INDEX.Spine1, BONE_INDEX.Spine2, BONE_INDEX.Neck, BONE_INDEX.Head];

export class Skeleton {
  readonly bones: Object3D[];
  /** Model-space rotation and position of each clip bone after `apply`. */
  readonly modelQ: Quaternion[];
  readonly modelP: Vector3[];
  /** Extra model-space rotation applied on top of the clip, per bone. Identity means none. */
  readonly adjust: Quaternion[];

  constructor(
    private readonly rig: SoldierRig,
    model: Object3D,
  ) {
    this.bones = CLIP_BONES.map((name) => {
      const bone = model.getObjectByName(name);
      if (!bone) throw new Error(`Soldier clone is missing bone "${name}"`);
      return bone;
    });
    this.modelQ = this.bones.map(() => new Quaternion());
    this.modelP = this.bones.map(() => new Vector3());
    this.adjust = this.bones.map(() => new Quaternion());
    for (const finger of rig.fingers) model.getObjectByName(finger.name)?.quaternion.copy(finger.grip);
  }

  /**
   * How far the clip alone has turned the chest and the head from their rest
   * orientation, in model space. Lets the caller steer both to where the aim
   * needs them instead of stacking an aim offset on whatever the clip does.
   */
  measure(pose: Pose, chest: Quaternion, head: Quaternion): void {
    const { restModel } = this.rig;
    const rotations = pose.rotations;
    chain.identity();
    for (let i = 0; i < SPINE_CHAIN.length; i++) {
      const index = SPINE_CHAIN[i]!;
      chain.multiply(scratch.set(rotations[index * 4]!, rotations[index * 4 + 1]!, rotations[index * 4 + 2]!, rotations[index * 4 + 3]!));
      if (index === BONE_INDEX.Spine2) chest.copy(chain).multiply(scratch.copy(restModel[index]!).invert());
    }
    head.copy(chain).multiply(scratch.copy(restModel[BONE_INDEX.Head]!).invert());
  }

  clearAdjust(): void {
    for (const q of this.adjust) q.identity();
  }

  /** Writes the pose to the bones, with the corrections in `adjust` folded in. */
  apply(pose: Pose): void {
    const { parents, offsets } = this.rig;
    const rotations = pose.rotations;
    for (let i = 0; i < this.bones.length; i++) {
      const bone = this.bones[i]!;
      const parent = parents[i]!;
      const modelQ = this.modelQ[i]!;
      const local = bone.quaternion.set(rotations[i * 4]!, rotations[i * 4 + 1]!, rotations[i * 4 + 2]!, rotations[i * 4 + 3]!);
      if (parent < 0) {
        parentQ.identity();
        this.modelP[i]!.set(pose.hips[0]!, pose.hips[1]!, pose.hips[2]!);
        bone.position.copy(this.modelP[i]!);
      } else {
        parentQ.copy(this.modelQ[parent]!);
        this.modelP[i]!.copy(offsets[i]!).applyQuaternion(parentQ).add(this.modelP[parent]!);
      }
      modelQ.multiplyQuaternions(parentQ, local);
      const adjust = this.adjust[i]!;
      if (adjust.w < 0.9999995) {
        modelQ.premultiply(adjust);
        local.copy(parentQ).invert().multiply(modelQ);
      }
    }
  }

  /** Blends an arm toward an IK solution. `weight` 1 uses the solution outright. */
  setArm(arm: ArmRig, solution: ArmSolution, weight: number): void {
    if (weight <= 0) return;
    this.setBone(arm.upper, solution.upper, weight);
    this.setBone(arm.lower, solution.lower, weight);
    this.setBone(arm.hand, solution.hand, weight);
  }

  private setBone(index: number, target: Quaternion, weight: number): void {
    const { parents, offsets } = this.rig;
    const parent = parents[index]!;
    const modelQ = this.modelQ[index]!;
    if (weight >= 1) modelQ.copy(target);
    else modelQ.slerp(target, weight);
    parentQ.copy(parent < 0 ? identity : this.modelQ[parent]!);
    this.modelP[index]!.copy(offsets[index]!).applyQuaternion(parentQ).add(this.modelP[parent]!);
    this.bones[index]!.quaternion.copy(scratch.copy(parentQ).invert().multiply(modelQ));
  }
}
