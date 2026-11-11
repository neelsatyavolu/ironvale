import * as THREE from 'three/webgpu';
import type { ArmsRig, WeaponActionStage } from '../../game/contracts';
import type { World } from '../../world/types';
import type { WeaponMachine } from '../machine';
import type { GunView } from './gun-view';
import { clamp01, damp, smoothstep, Spring } from './motion';
import { AGAINST_WALL, LOWERED, reloadPose, sprintPose, workPose, type PoseOffset } from './poses';

/** Everything the rig needs to know about one frame. The owner reuses one object. */
export interface ViewFrame {
  dt: number;
  machine: WeaponMachine;
  /** 0 hip, 1 aimed (linear; eased here). */
  aim: number;
  /** 0 - 1 sprint carry. */
  sprint: number;
  /** 0 up, 1 fully lowered for a weapon switch. */
  lowered: number;
  /** Horizontal speed in m/s. */
  speed: number;
  verticalSpeed: number;
  onGround: boolean;
  /** The player's own turn this frame, radians (recoil and assist excluded). */
  lookYaw: number;
  lookPitch: number;
  hidden: boolean;
}

const RUN_SPEED = 6.4;
const STRIDE = 1.7;
const MAX_TURN_RATE = 3;
/** Radians of lag per radian-per-second of turn, and metres of drift. */
const SWAY_ROTATION = 0.012;
const SWAY_SHIFT = 0.004;
const AIMED_SWAY = 0.15;
const AIMED_BOB = 0.08;
const AIMED_RISE = 0.4;
/** Converts a wanted peak displacement into the impulse that produces it on the recoil springs. */
const KICK_IMPULSE = 26;
/** Clear space kept between the muzzle and a wall, metres. */
const WALL_MARGIN = 0.06;
/** The barrel never swings further than this off the line of sight, radians. */
const WALL_MAX_ANGLE = 1.25;
/**
 * The gun is drawn as if through a narrower lens than the world, the way
 * shooters usually do it: depth is compressed about the eye by the ratio of
 * the two lenses. It stays in the main scene, so it is still lit, shadowed and
 * reflected with everything else, and its size on screen no longer changes
 * when the sights zoom the world.
 */
const VIEW_MODEL_FOV = 54;
const VIEW_MODEL_TAN = Math.tan(THREE.MathUtils.degToRad(VIEW_MODEL_FOV / 2));
/** Pivot for hip rotations: about where the stock meets the shoulder, in gun space. */
const SHOULDER = new THREE.Vector3(0, 0.02, 0.14);

/**
 * The first-person view model: one gun (and the arms, when there are any)
 * parented to the camera in the main scene, posed every frame from layered
 * procedural motion.
 */
export class ViewRig {
  readonly root = new THREE.Group();
  private readonly holder = new THREE.Group();
  private active: GunView | null = null;
  private time = 0;
  private bobPhase = 0;
  private bobAmount = 0;
  private turnYaw = 0;
  private turnPitch = 0;
  private retract = 0;
  /** Rotation offsets accumulated while composing a frame. */
  private pitch = 0;
  private yaw = 0;
  private roll = 0;
  private readonly kick = new Spring(260, 20);
  private readonly rise = new Spring(230, 17);
  private readonly cant = new Spring(200, 14);
  private readonly twist = new Spring(200, 16);
  private readonly drop = new Spring(120, 15);
  private readonly jolt = new Spring(320, 22);

  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly offset = new THREE.Vector3();
  private readonly angles = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly turn = new THREE.Quaternion();
  private readonly pivot = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly arms: ArmsRig | null,
  ) {
    this.root.name = 'view_model';
    this.root.add(this.holder);
    if (arms) this.holder.add(arms.root);
    this.root.visible = false;
    camera.add(this.root);
  }

  get gun(): GunView | null {
    return this.active;
  }

  /** Swap the gun in the hands. Only the shown gun is in the scene graph. */
  show(gun: GunView): void {
    if (this.active === gun) return;
    if (this.active) this.holder.remove(this.active.model.root);
    this.active = gun;
    gun.parts.reset();
    this.holder.add(gun.model.root);
    this.kick.reset();
    this.rise.reset();
    this.cant.reset();
    this.twist.reset();
    this.jolt.reset();
    this.retract = 0;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /** A shot was fired: jolt the gun back, up and a little sideways. `side` is -1 to 1. */
  fired(aim: number, side: number): void {
    const gun = this.active;
    if (!gun) return;
    const recoil = gun.def.recoil;
    const eased = smoothstep(aim);
    gun.parts.fired();
    this.kick.kick(recoil.kickback * KICK_IMPULSE);
    this.rise.kick((0.012 + recoil.vertical * 0.008) * KICK_IMPULSE * (1 - (1 - AIMED_RISE) * eased));
    this.cant.kick(side * 0.014 * KICK_IMPULSE * (1 - 0.5 * eased));
    this.twist.kick(side * (0.004 + recoil.horizontal * 0.006) * KICK_IMPULSE * (1 - 0.6 * eased));
  }

  /** A reload or action stage happened: a small bump so the motion lands with the sound. */
  stage(stage: WeaponActionStage): void {
    const strong = stage === 'magIn' || stage === 'boltForward';
    this.jolt.kick(strong ? 0.26 : 0.14);
  }

  landed(speed: number): void {
    this.drop.kick(-Math.min(speed, 12) * 0.022);
  }

  /** World position of the muzzle right now. */
  muzzleWorld(target: THREE.Vector3): THREE.Vector3 {
    if (!this.active) return this.camera.getWorldPosition(target);
    return this.active.model.muzzle.getWorldPosition(target);
  }

  /** World position of the ejection port and the direction casings leave in. */
  ejectionWorld(position: THREE.Vector3, direction: THREE.Vector3): void {
    if (!this.active) {
      this.camera.getWorldPosition(position);
      direction.set(1, 0, 0);
      return;
    }
    const port = this.active.model.ejection;
    port.getWorldPosition(position);
    direction.setFromMatrixColumn(port.matrixWorld, 0).normalize();
  }

  update(frame: ViewFrame, world: World | null): void {
    const gun = this.active;
    if (!gun) return;
    const dt = frame.dt;
    this.root.visible = !frame.hidden;
    this.time += dt;
    gun.parts.update(dt, frame.machine);

    const aimed = smoothstep(frame.aim);
    const hip = 1 - aimed;
    const offset = this.offset.set(0, 0, 0);
    this.pitch = this.yaw = this.roll = 0;

    // Base pose: hip to sights, with a small dip and roll through the move so it is not a straight slide.
    this.position.lerpVectors(gun.hipPosition, gun.aimPosition, aimed);
    this.quaternion.slerpQuaternions(gun.hipQuaternion, gun.aimQuaternion, aimed);
    const mid = Math.sin(Math.PI * aimed);
    offset.y -= 0.012 * mid;
    this.roll -= 0.07 * mid;

    // Breathing at rest.
    offset.y += Math.sin(this.time * 1.6) * 0.0012 * hip;
    this.pitch += Math.sin(this.time * 1.1) * 0.003 * hip;

    // Look lag: the gun trails the view a little when turning.
    if (dt > 0) {
      const rateYaw = THREE.MathUtils.clamp(frame.lookYaw / dt, -MAX_TURN_RATE, MAX_TURN_RATE);
      const ratePitch = THREE.MathUtils.clamp(frame.lookPitch / dt, -MAX_TURN_RATE, MAX_TURN_RATE);
      this.turnYaw = damp(this.turnYaw, rateYaw, 9, dt);
      this.turnPitch = damp(this.turnPitch, ratePitch, 9, dt);
    }
    const swayScale = AIMED_SWAY + (1 - AIMED_SWAY) * hip;
    this.yaw -= this.turnYaw * SWAY_ROTATION * swayScale;
    this.pitch -= this.turnPitch * SWAY_ROTATION * swayScale;
    this.roll -= this.turnYaw * SWAY_ROTATION * 0.8 * hip;
    offset.x += this.turnYaw * SWAY_SHIFT * hip;
    offset.y -= this.turnPitch * SWAY_SHIFT * hip;

    // Walk bob, in step with ground speed.
    const sprint = smoothstep(frame.sprint);
    const stride = frame.onGround ? clamp01(frame.speed / RUN_SPEED) : 0;
    this.bobAmount = damp(this.bobAmount, stride, 8, dt);
    if (frame.onGround) this.bobPhase += ((frame.speed * dt) / STRIDE) * Math.PI;
    const bob = this.bobAmount * (AIMED_BOB + (1 - AIMED_BOB) * hip) * (1 + sprint * 0.9);
    const swing = Math.cos(this.bobPhase);
    const step = Math.abs(Math.sin(this.bobPhase));
    offset.x += swing * 0.007 * bob;
    offset.y -= step * 0.009 * bob;
    this.roll += swing * 0.014 * bob;
    this.yaw += swing * 0.012 * bob * sprint;

    this.add(sprintPose(gun.def), sprint);
    this.add(LOWERED, smoothstep(frame.lowered));
    this.add(reloadPose(gun.def), gun.parts.tilt);
    this.add(workPose(gun.def), gun.parts.work);
    offset.y -= 0.012 * gun.parts.seat * gun.parts.tilt;
    this.pitch -= 0.03 * gun.parts.seat * gun.parts.tilt;

    // Jumping, falling and landing.
    const airTarget = frame.onGround ? 0 : THREE.MathUtils.clamp(-frame.verticalSpeed * 0.004, -0.03, 0.03);
    const drop = this.drop.step(dt, airTarget);
    offset.y += drop;
    this.pitch += drop * 1.4;

    // Recoil and handling bumps.
    const kickLimit = gun.def.recoil.kickback * 2.5 + 0.02;
    offset.z += Math.min(this.kick.step(dt), kickLimit);
    this.pitch += this.rise.step(dt);
    this.roll += this.cant.step(dt);
    this.yaw += this.twist.step(dt);
    const jolt = this.jolt.step(dt);
    offset.y -= jolt * 0.012;
    this.roll += jolt * 0.03;

    // Keep the barrel out of walls: swing it up and in when something is closer than the muzzle.
    const depth = VIEW_MODEL_TAN / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.retract = damp(this.retract, this.wallAngle(world, (gun.barrelLength - this.position.z) * depth), 12, dt);
    if (this.retract > 0.001) this.add(AGAINST_WALL, this.retract);

    // Rotate about the shoulder at the hip and about the eye when aimed, so the sights stay on the axis.
    this.angles.set(this.pitch, this.yaw, this.roll);
    this.turn.setFromEuler(this.angles);
    this.pivot.copy(SHOULDER).applyQuaternion(this.quaternion).add(this.position).multiplyScalar(hip);
    this.holder.position.copy(this.position).sub(this.pivot).applyQuaternion(this.turn).add(this.pivot).add(offset);
    this.holder.quaternion.multiplyQuaternions(this.turn, this.quaternion);

    // Hands follow the gun: matrices first, then the targets, then the arms.
    this.root.scale.z = depth;
    this.camera.updateMatrixWorld();
    gun.updateHands();
    this.arms?.update(gun.triggerTarget, gun.supportTarget);
  }

  private add(pose: PoseOffset, weight: number): void {
    if (weight <= 0) return;
    this.offset.x += pose.x * weight;
    this.offset.y += pose.y * weight;
    this.offset.z += pose.z * weight;
    this.pitch += pose.pitch * weight;
    this.yaw += pose.yaw * weight;
    this.roll += pose.roll * weight;
  }

  /**
   * Angle the barrel must swing off the line of sight so the muzzle stays short
   * of whatever is in front of the eye. `reach` is how far ahead the muzzle sits
   * in the world when the gun points straight.
   */
  private wallAngle(world: World | null, reach: number): number {
    if (!world || reach <= 0) return 0;
    this.camera.getWorldPosition(this.eye);
    this.camera.getWorldDirection(this.forward);
    const hit = world.raycast(this.eye, this.forward, reach + WALL_MARGIN);
    if (!hit) return 0;
    const room = Math.max(0, hit.distance - WALL_MARGIN);
    return Math.min(WALL_MAX_ANGLE, Math.acos(Math.min(1, room / reach)));
  }

  dispose(): void {
    this.camera.remove(this.root);
    this.arms?.dispose();
  }
}
