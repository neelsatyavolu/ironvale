/**
 * The third-person soldier: retargeted clips for the legs and body, a
 * procedural upper body for aiming, and arm IK onto the rifle.
 */
import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { HitZone, SoldierVisual, Team } from '../game/contracts';
import { deathFrame, planDeath, GunDrop, type DeathFrame, type DeathVariant, DEATH } from './death';
import { CARBINE, GunHold, type HoldInput } from './gun-hold';
import { createArmSolution, solveArm } from './ik';
import { VisibilityTracker, poseInterval, shouldPose } from './lod';
import { GAIT_CLIPS, advancePhase, clipTimeAtPhase, createGaitWeights, gaitWeights, isMovingClip, resolveHeading } from './locomotion';
import { Pose, blendPose, copyPose, sampleClip, steerBone } from './pose';
import { Flinch, Recoil } from './reactions';
import { BONE_INDEX, type SoldierRig } from './rig';
import { Skeleton } from './skeleton';

type SoldierState = { -readonly [K in keyof Parameters<SoldierVisual['setState']>[0]]: Parameters<SoldierVisual['setState']>[0][K] };

const TUNING = {
  /** Seconds to change stance, raise the rifle and settle into a run carry. */
  crouchTime: 0.22,
  aimTime: 0.18,
  carryTime: 0.3,
  /** Keep the rifle up this long after the last shot. */
  aimHold: 0.6,
  /** Carry the rifle across the chest above this speed, m/s. */
  carrySpeed: 4.4,
  /** Chest turn that brings the support shoulder forward (radians, negative is to the right). */
  bladeAimed: -0.62,
  bladeReady: -0.3,
  /** Chest lean in radians, negative forwards: at the ready, shouldering the rifle, and extra when crouched. */
  readyLean: -0.12,
  aimLean: -0.2,
  crouchLean: -0.36,
  /** Further lean when moving crouched, which keeps the head down without folding the legs flat. */
  crouchMoveLean: -0.22,
  /** Extra forward lean per m/s of speed, and its limit. */
  paceLean: 0.075,
  maxPaceLean: 0.3,
  /** Share of the aim pitch the chest takes; the head takes the rest and the rifle all of it. */
  chestPitchShare: 0.55,
  /** Chest lean while running with the rifle carried. */
  carryLean: -0.42,
  /** How firmly the chest is held to the aim stance rather than left to the clip (0 - 1), aiming and carrying. */
  chestHold: 0.82,
  carryHold: 0.6,
  /** The same for the head, as a share of the chest's hold. */
  headHold: 1,
  /** Head tilt onto the stock, and the nod that brings the eye down to the sights. */
  cheekRoll: -0.28,
  sightNod: -0.2,
  /** How far the firing shoulder is shrugged up behind the butt, radians at the collarbone. */
  aimShrug: 0.2,
  maxPitch: 1.2,
  /** How far the collarbones are pulled from the clip back to rest while the hands are on the rifle. */
  collarSettle: 0.8,
  reloadSeconds: 2.3,
  /** Below this measured speed the travel direction is not trusted, m/s. */
  minHeadingSpeed: 0.35,
  headingRate: 9,
} as const;

/** How the three spine bones share a chest correction. */
const SPINE_SHARE = { Spine: 0.3, Spine1: 0.35, Spine2: 0.35 } as const;
const SPINE_BONES = ['Spine', 'Spine1', 'Spine2'] as const;
const BOUNDS = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.4);
const RIGHT_ELBOW = new THREE.Vector3(0.55, -0.8, 0.25).normalize();
const LEFT_ELBOW = new THREE.Vector3(-0.3, -0.92, 0.1).normalize();
/** The right eye from the head joint in the rest pose, model axes, metres. */
const RIGHT_EYE = new THREE.Vector3(0.032, 0.085, -0.085);

const euler = new THREE.Euler();
const cameraPosition = new THREE.Vector3();
const worldPosition = new THREE.Vector3();
const scratchQ = new THREE.Quaternion();
const identityQ = new THREE.Quaternion();
const clipChest = new THREE.Quaternion();
const clipHead = new THREE.Quaternion();
const chestNow = new THREE.Quaternion();
const chestFix = new THREE.Quaternion();
const headNow = new THREE.Quaternion();
const headFix = new THREE.Quaternion();
const elbow = new THREE.Vector3();
const eye = new THREE.Vector3();
const approach = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

let nextSlot = 0;

export class Soldier implements SoldierVisual {
  readonly root = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private readonly gun: THREE.Mesh;
  private readonly mesh: THREE.SkinnedMesh;
  private readonly skeleton: Skeleton;
  private readonly hold = new GunHold();
  private readonly holdInput: HoldInput = { aim: 0, carry: 0, pitch: 0, recoil: 0, recoilSide: 0, reload: -1, swayPitch: 0, swayYaw: 0 };
  private readonly rightArm = createArmSolution();
  private readonly leftArm = createArmSolution();
  private readonly pose: Pose;
  private readonly sample: Pose;
  private readonly deathFrom: Pose;
  private readonly weights = createGaitWeights();
  private readonly visibility = new VisibilityTracker();
  private readonly flinchState = new Flinch();
  private readonly recoil = new Recoil();
  private readonly drop = new GunDrop();
  private readonly death: DeathFrame = { clipTime: 0, blend: 0, ikWeight: 1, turn: 0, settled: false };
  private readonly slot = nextSlot++;
  private readonly lastPosition = new THREE.Vector3();
  private hasLastPosition = false;

  private readonly state: SoldierState = { speed: 0, crouching: false, aimPitch: 0, aiming: false, firing: false, reloading: false };
  private frame = 0;
  private clock = 0;
  private phase = 0;
  private crouch = 0;
  private aim = 0;
  private carry = 0;
  private aimHold = 0;
  private pitch = 0;
  private reloadTime = -1;
  private hipYaw = 0;
  private reverse = false;
  private dead = false;
  private deadTime = 0;
  private deathYaw = 0;
  private deathVariant: DeathVariant = 'back';
  private corpseAtRest = false;
  /** Times the skeleton has been posed; the viewer and dev scripts read it to check level of detail. */
  poseCount = 0;

  constructor(
    private readonly rig: SoldierRig,
    team: Team,
  ) {
    this.root.name = `soldier-${team}`;
    const model = cloneSkinned(rig.template);
    this.pivot.add(model);
    this.root.add(this.pivot);

    let mesh: THREE.SkinnedMesh | null = null;
    model.traverse((child) => {
      if ((child as THREE.SkinnedMesh).isSkinnedMesh) mesh = child as THREE.SkinnedMesh;
    });
    if (!mesh) throw new Error('Soldier model has no skinned mesh');
    this.mesh = mesh;
    this.mesh.material = rig.material(team);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // A fixed sphere wide enough for a fallen body: the rest-pose bounds would cull a corpse at the screen edge.
    this.mesh.boundingSphere = BOUNDS;
    this.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      // The sun's shadow pass also calls this, with an orthographic camera; only the player's view counts.
      if (!(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return;
      cameraPosition.setFromMatrixPosition(camera.matrixWorld);
      worldPosition.setFromMatrixPosition(this.root.matrixWorld);
      this.visibility.seen(cameraPosition.distanceTo(worldPosition));
    };

    this.gun = new THREE.Mesh(rig.carbine.geometry, rig.carbine.material);
    this.gun.name = 'carbine';
    this.gun.castShadow = true;
    this.root.add(this.gun);

    this.skeleton = new Skeleton(rig, model);
    const bones = this.skeleton.bones.length;
    this.pose = new Pose(bones);
    this.sample = new Pose(bones);
    this.deathFrom = new Pose(bones);
    this.poseNow();
  }

  muzzleWorld(target: THREE.Vector3): THREE.Vector3 {
    this.gun.updateWorldMatrix(true, false);
    return target.copy(CARBINE.muzzle).applyMatrix4(this.gun.matrixWorld);
  }

  setState(state: SoldierState): void {
    // Callers reuse their state object, so take the values rather than the reference.
    const own = this.state;
    own.speed = state.speed;
    own.crouching = state.crouching;
    own.aimPitch = state.aimPitch;
    own.aiming = state.aiming;
    own.firing = state.firing;
    own.reloading = state.reloading;
  }

  flinch(zone: HitZone): void {
    if (!this.dead) this.flinchState.hit(zone);
  }

  die(direction: THREE.Vector3): void {
    if (this.dead) return;
    this.dead = true;
    this.corpseAtRest = false;
    this.deadTime = 0;
    copyPose(this.deathFrom, this.pose);
    // The bullet's direction in the soldier's own frame.
    scratchQ.copy(this.root.quaternion).invert();
    worldPosition.copy(direction).applyQuaternion(scratchQ);
    const plan = planDeath(worldPosition.x, worldPosition.z);
    this.deathVariant = plan.variant;
    this.deathYaw = plan.turn;
    this.drop.release(this.gun, worldPosition);
  }

  revive(): void {
    this.dead = false;
    this.corpseAtRest = false;
    this.deadTime = 0;
    this.deathYaw = 0;
    this.pivot.rotation.y = 0;
    this.flinchState.reset();
    this.recoil.reset();
    this.drop.reset();
    this.aim = 0;
    this.carry = 0;
    this.aimHold = 0;
    this.reloadTime = -1;
    this.hipYaw = 0;
    this.hasLastPosition = false;
    this.poseNow();
  }

  update(dt: number): void {
    const step = Math.min(Math.max(dt, 0), 0.1);
    this.frame++;
    this.visibility.tick();
    this.clock += step;
    if (this.dead) {
      this.deadTime += step;
      this.drop.update(this.gun, step);
      if (this.corpseAtRest) return;
    } else {
      this.advance(step);
    }
    const interval = poseInterval(this.visibility.visible, this.visibility.distance);
    if (shouldPose(this.frame, this.slot, interval)) this.poseNow();
  }

  /** Pose the skeleton now, whatever the level-of-detail schedule says. For the viewer and tests. */
  refresh(): void {
    this.poseNow();
  }

  dispose(): void {
    this.root.removeFromParent();
    // Geometry, textures and materials are shared by every soldier; only the per-instance bone data is ours.
    this.mesh.skeleton.dispose();
  }

  /** Per-frame bookkeeping that must not skip frames: stride phase, blends and timers. */
  private advance(dt: number): void {
    const state = this.state;
    this.trackHeading(dt);
    this.crouch = approach(this.crouch, state.crouching ? 1 : 0, dt / TUNING.crouchTime);
    this.aimHold = state.firing ? TUNING.aimHold : Math.max(0, this.aimHold - dt);
    const wantsAim = state.aiming || this.aimHold > 0;
    this.aim = approach(this.aim, wantsAim && !state.reloading ? 1 : 0, dt / TUNING.aimTime);
    const wantsCarry = !wantsAim && !state.reloading && !state.crouching && state.speed > TUNING.carrySpeed;
    this.carry = approach(this.carry, wantsCarry ? 1 : 0, dt / TUNING.carryTime);
    this.pitch += (THREE.MathUtils.clamp(state.aimPitch, -TUNING.maxPitch, TUNING.maxPitch) - this.pitch) * Math.min(1, dt * 14);
    this.reloadTime = state.reloading ? (Math.max(0, this.reloadTime) + dt / TUNING.reloadSeconds) % 1 : -1;
    this.recoil.update(dt, state.firing);
    this.flinchState.update(dt);
    gaitWeights(state.speed, this.crouch, this.weights);
    this.phase = advancePhase(this.phase, state.speed, this.weights, dt, this.reverse);
  }

  /** Works out which way the soldier is travelling relative to its facing, from how the root moved. */
  private trackHeading(dt: number): void {
    const position = this.root.position;
    let target = 0;
    if (this.hasLastPosition && dt > 1e-5) {
      const dx = position.x - this.lastPosition.x;
      const dz = position.z - this.lastPosition.z;
      if (Math.hypot(dx, dz) / dt > TUNING.minHeadingSpeed) {
        const yaw = this.root.rotation.y;
        const forward = -dx * Math.sin(yaw) - dz * Math.cos(yaw);
        const left = -dx * Math.cos(yaw) + dz * Math.sin(yaw);
        const heading = resolveHeading(Math.atan2(left, forward), this.reverse);
        this.reverse = heading.reverse;
        target = heading.hipYaw;
      } else {
        this.reverse = false;
      }
    }
    this.lastPosition.copy(position);
    this.hasLastPosition = true;
    this.hipYaw += (target - this.hipYaw) * Math.min(1, dt * TUNING.headingRate);
  }

  private poseNow(): void {
    this.poseCount++;
    const { clips } = this.rig;
    const pose = this.pose;

    // Body from the gait clips.
    let total = 0;
    for (const clip of GAIT_CLIPS) {
      const weight = this.weights[clip];
      if (weight <= 0) continue;
      const time = isMovingClip(clip) ? clipTimeAtPhase(clip, this.phase) : this.clock;
      total += weight;
      if (total === weight) {
        sampleClip(clips[clip], time, pose);
      } else {
        sampleClip(clips[clip], time, this.sample);
        blendPose(pose, this.sample, weight / total);
      }
    }

    let alive = 1;
    let ik = 1;
    if (this.dead) {
      deathFrame(this.deathVariant, this.deadTime, this.death);
      sampleClip(clips[DEATH.variants[this.deathVariant].clip], this.death.clipTime, this.sample);
      copyPose(pose, this.deathFrom);
      blendPose(pose, this.sample, this.death.blend);
      alive = 1 - this.death.blend;
      ik = this.death.ikWeight;
      this.pivot.rotation.y = this.deathYaw * this.death.turn;
      this.corpseAtRest = this.death.settled;
    }

    // The clips swing the arms from the collarbones. With both hands on a rifle that swing has nowhere
    // to go and bunches the shoulders, so the collarbones settle most of the way back to rest.
    const settle = TUNING.collarSettle * ik;
    steerBone(pose, BONE_INDEX.LeftShoulder, this.rig.restLocal[BONE_INDEX.LeftShoulder]!, settle);
    steerBone(pose, BONE_INDEX.RightShoulder, this.rig.restLocal[BONE_INDEX.RightShoulder]!, settle);
    this.setAdjustments(alive);
    this.skeleton.apply(pose);
    if (ik > 0) this.holdRifle(ik);
  }

  /**
   * Aim pitch, the bladed stance, strafing hips and hit reactions, as
   * model-space corrections on the clip. The chest and head are steered most
   * of the way to the orientation the aim needs, whatever the clip has them
   * doing (the library's run twists the chest a long way to swing the arms,
   * which a rifle held in both hands cannot follow). A share of the clip's own
   * motion is kept so the spine stays alive.
   */
  private setAdjustments(alive: number): void {
    const skeleton = this.skeleton;
    skeleton.clearAdjust();
    if (alive <= 0) return;
    skeleton.measure(this.pose, clipChest, clipHead);

    const flinch = this.flinchState;
    const carry = this.carry;
    const aimed = (0.4 + 0.6 * this.aim) * (1 - carry);
    const moving = 1 - this.weights.idle - this.weights.crouchIdle;
    const standing =
      TUNING.readyLean +
      (TUNING.aimLean - TUNING.readyLean) * this.aim +
      (TUNING.crouchLean + TUNING.crouchMoveLean * moving) * this.crouch -
      Math.min(TUNING.maxPaceLean, this.state.speed * TUNING.paceLean);
    const lean = standing + (TUNING.carryLean - standing) * carry;
    const blade = (TUNING.bladeReady + (TUNING.bladeAimed - TUNING.bladeReady) * this.aim) * (1 - carry);
    const hold = (TUNING.chestHold + (TUNING.carryHold - TUNING.chestHold) * carry) * alive;
    const kick = this.recoil.value * alive;

    // Hips: turn toward the direction of travel when strafing, and buckle on a limb hit.
    const hips = skeleton.adjust[BONE_INDEX.Hips]!.setFromEuler(euler.set(flinch.hipsPitch * alive, this.hipYaw * alive, flinch.hipsRoll * alive, 'XYZ'));

    // Chest: from where the clip (on the turned hips) has it, to the bladed, leaning aim stance.
    chestNow.multiplyQuaternions(hips, clipChest);
    chestFix.setFromEuler(euler.set(lean + this.pitch * aimed * TUNING.chestPitchShare, blade, 0, 'XYZ')).multiply(scratchQ.copy(chestNow).invert());
    chestFix.copy(identityQ.identity().slerp(chestFix, hold));
    for (const name of SPINE_BONES) {
      const adjust = skeleton.adjust[BONE_INDEX[name]]!.identity().slerp(chestFix, SPINE_SHARE[name]);
      if (name === 'Spine1') adjust.premultiply(scratchQ.setFromEuler(euler.set(flinch.torsoPitch * alive, 0, 0, 'XYZ')));
      if (name === 'Spine2') adjust.premultiply(scratchQ.setFromEuler(euler.set(kick * 0.02, flinch.torsoYaw * alive, 0, 'XYZ')));
    }

    // Head: rides on the corrected chest; bring the eyes onto the target and the cheek onto the stock.
    headNow.multiplyQuaternions(chestFix, hips).multiply(clipHead);
    const sighting = this.aim * (1 - carry);
    // Crouched, the chest is already bent over the rifle, so the head needs no nod and the shoulder no shrug.
    const upright = sighting * (1 - this.crouch);
    headFix.setFromEuler(euler.set(this.pitch * aimed + TUNING.sightNod * upright, 0, TUNING.cheekRoll * sighting, 'XYZ')).multiply(scratchQ.copy(headNow).invert());
    headFix.copy(identityQ.identity().slerp(headFix, hold * TUNING.headHold));
    skeleton.adjust[BONE_INDEX.Neck]!.identity().slerp(headFix, 0.45).premultiply(scratchQ.setFromEuler(euler.set(flinch.headPitch * 0.4 * alive, 0, 0, 'XYZ')));
    skeleton.adjust[BONE_INDEX.Head]!.identity().slerp(headFix, 0.55).premultiply(scratchQ.setFromEuler(euler.set(flinch.headPitch * 0.6 * alive, flinch.headYaw * alive, 0, 'XYZ')));
    // The firing shoulder comes up behind the butt, which lifts the sights toward the eye.
    skeleton.adjust[BONE_INDEX.RightShoulder]!.setFromEuler(euler.set(0, 0, TUNING.aimShrug * upright * alive, 'XYZ'));
  }

  /** Places the rifle from the shoulder and aim, then puts both hands on it. */
  private holdRifle(weight: number): void {
    const { arms } = this.rig;
    const skeleton = this.skeleton;
    const input = this.holdInput;
    const stride = this.phase * Math.PI * 2;
    const moving = 1 - this.weights.idle - this.weights.crouchIdle;
    input.aim = this.aim;
    input.carry = this.carry;
    input.pitch = this.pitch;
    input.recoil = this.recoil.value;
    input.recoilSide = this.recoil.side;
    input.reload = this.reloadTime;
    input.swayPitch = Math.sin(this.clock * 1.7) * 0.006 + Math.sin(stride * 2) * 0.012 * moving - this.flinchState.gunDip;
    input.swayYaw = Math.sin(this.clock * 1.1 + 1) * 0.005 + Math.sin(stride) * 0.014 * moving;
    // The aiming eye, from the head as posed, so the sights can be brought to it.
    eye.copy(RIGHT_EYE).applyQuaternion(scratchQ.copy(skeleton.modelQ[BONE_INDEX.Head]!).multiply(headNow.copy(this.rig.restModel[BONE_INDEX.Head]!).invert())).add(skeleton.modelP[BONE_INDEX.Head]!);
    this.hold.update(skeleton.modelP[arms.right.upper]!, input, eye);

    if (!this.dead) {
      this.gun.position.copy(this.hold.position);
      this.gun.quaternion.copy(this.hold.quaternion);
    }
    // Elbows hang down and out; the firing elbow lifts a little when the rifle is shouldered.
    elbow.copy(RIGHT_ELBOW);
    elbow.y += 0.1 * this.aim;
    solveArm(arms.right.setup, skeleton.modelP[arms.right.upper]!, this.hold.triggerPosition, this.hold.triggerRotation, elbow.normalize(), this.rightArm);
    solveArm(arms.left.setup, skeleton.modelP[arms.left.upper]!, this.hold.supportPosition, this.hold.supportRotation, LEFT_ELBOW, this.leftArm);
    skeleton.setArm(arms.right, this.rightArm, weight);
    skeleton.setArm(arms.left, this.leftArm, weight);
  }
}
