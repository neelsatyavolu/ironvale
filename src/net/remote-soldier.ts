import { Vector3 } from 'three/webgpu';
import type { CombatantHit, Combatant, DamageInfo, GameContext, GameEvents, HitZone, SoldierVisual, Team } from '../game/contracts';
import { hitTestHumanoid } from '../game/hitbox';
import type { WeaponId } from '../weapons/models/api';
import type { Surface } from '../world/types';
import { SnapshotBuffer, type Pose, type Snapshot } from './interp';

const STAND_EYE = 1.64;
const CROUCH_EYE = 1.08;
const CHEST_STAND = 1.25;
const CHEST_CROUCH = 0.8;
/** Metres per footstep, as the local player's. */
const STRIDE_WALK = 1.55;
const STRIDE_RUN = 2.1;
const MIN_STEP_SPEED = 0.8;
/** A jump this large between frames is a respawn or a correction, not walking. */
const TELEPORT_DISTANCE = 3;
const FIRING_POSE_SECONDS = 0.12;
/** A muzzle further than this from the eye is a stale transform. */
const MUZZLE_REACH = 1.5;
const DOWN = new Vector3(0, -1, 0);

const footstepEvent: GameEvents['footstep'] = { ownerId: 0, position: new Vector3(), surface: 'concrete', running: false, local: false };
const probe = new Vector3();
const eye = new Vector3();

export interface RemoteSoldierOptions {
  readonly id: number;
  /** Id on the wire. */
  readonly wireId: number;
  /** Side in combat on this machine. */
  readonly team: Team;
  readonly name: string;
  readonly visual: SoldierVisual;
  readonly weapon: WeaponId;
  /** How far in the past the body is shown, milliseconds. */
  readonly delayMs: number;
  readonly maxExtrapolationMs: number;
  /** Work speed out from positions (bots) instead of using the velocity sent (players). */
  readonly deriveVelocity: boolean;
  /** Called with damage the local machine dealt: forward it to whoever owns this body. */
  readonly onDamage: (target: RemoteSoldier, info: DamageInfo) => void;
}

/** What arrived about the body besides its pose. Taken from the newest message, not delayed. */
export interface RemoteFlags {
  readonly crouching: boolean;
  readonly aiming: boolean;
  readonly reloading: boolean;
  readonly running: boolean;
  readonly onGround: boolean;
  readonly alive: boolean;
  readonly health: number;
  readonly weapon: WeaponId;
}

/**
 * A body simulated on the other machine: the other player, or (for a co-op
 * guest) one of the host's bots. It is a `Combatant`, so bullets and bots
 * treat it like anyone else, but it never decides its own fate: damage dealt
 * here is forwarded, and death arrives as a message.
 */
export class RemoteSoldier implements Combatant {
  readonly kind = 'remote' as const;
  readonly id: number;
  readonly wireId: number;
  readonly team: Team;
  readonly visual: SoldierVisual;
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  name: string;
  alive = false;
  health = 100;
  crouching = false;
  weapon: WeaponId;
  yaw = 0;
  pitch = 0;
  /** Seconds since death, for clearing bodies away. */
  corpseTime = 0;
  /** Lives at or below this number are over; state from them must not bring the body back. */
  endedLife = -1;

  private readonly buffer: SnapshotBuffer;
  private readonly sampled: Pose = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0 };
  private readonly poseState = { speed: 0, crouching: false, aimPitch: 0, aiming: false, firing: false, reloading: false };
  private readonly last = new Vector3();
  private placed = false;
  private aiming = false;
  private reloading = false;
  private running = false;
  private onGround = true;
  private stride = 0;
  private firingTime = 0;
  private dead = false;
  /** The death fall has been played for this life. */
  private fallen = false;
  private epoch = -1;

  constructor(
    private readonly ctx: GameContext,
    private readonly options: RemoteSoldierOptions,
  ) {
    this.id = options.id;
    this.wireId = options.wireId;
    this.team = options.team;
    this.name = options.name;
    this.visual = options.visual;
    this.weapon = options.weapon;
    this.buffer = new SnapshotBuffer({ maxExtrapolationMs: options.maxExtrapolationMs, deriveVelocity: options.deriveVelocity });
    // Nothing to show until the owner says where the body is.
    this.visual.root.visible = false;
  }

  /** Put the body somewhere before any state has arrived. */
  place(x: number, y: number, z: number, yaw: number): void {
    this.position.set(x, y, z);
    this.last.copy(this.position);
    this.yaw = yaw;
    this.placed = true;
    this.visual.root.visible = true;
    this.syncVisual(0);
  }

  /** A state message. `snapshot.time` is on this machine's clock; `life` identifies the life it belongs to. */
  push(snapshot: Snapshot, flags: RemoteFlags, life: number): void {
    // A new life starts somewhere else: forget the old path so the body is not shown where it fell.
    if (snapshot.epoch !== this.epoch && snapshot.time > this.buffer.newestTime) {
      this.epoch = snapshot.epoch;
      this.buffer.reset();
    }
    if (snapshot.epoch !== this.epoch || !this.buffer.push(snapshot)) return;
    this.visual.root.visible = true;
    if (snapshot.time < this.buffer.newestTime) return;
    this.crouching = flags.crouching;
    this.aiming = flags.aiming;
    this.reloading = flags.reloading;
    this.running = flags.running;
    this.onGround = flags.onGround;
    this.weapon = flags.weapon;
    this.health = flags.health;
    const alive = flags.alive && life > this.endedLife;
    if (alive && !this.alive) this.revive();
    else if (!alive && this.alive && !flags.alive) this.markDead();
  }

  eyePosition(target: Vector3): Vector3 {
    return target.set(this.position.x, this.position.y + (this.crouching ? CROUCH_EYE : STAND_EYE), this.position.z);
  }

  chestPosition(target: Vector3): Vector3 {
    return target.set(this.position.x, this.position.y + (this.crouching ? CHEST_CROUCH : CHEST_STAND), this.position.z);
  }

  hitTest(origin: Vector3, direction: Vector3, maxDistance: number): CombatantHit | null {
    return hitTestHumanoid(this.position, this.crouching, origin, direction, maxDistance);
  }

  /** The shooter's machine decided this hit. The body's owner applies it and reports back. */
  applyDamage(info: DamageInfo): void {
    if (!this.alive) return;
    this.visual.flinch(info.zone);
    this.options.onDamage(this, info);
  }

  /** Where a shot from this body should appear to start. */
  muzzle(target: Vector3, fallback: Vector3): Vector3 {
    this.eyePosition(eye);
    this.visual.muzzleWorld(target);
    const usable = Number.isFinite(target.x) && target.distanceToSquared(eye) < MUZZLE_REACH * MUZZLE_REACH;
    return usable ? target : target.copy(fallback.distanceToSquared(eye) < 9 ? fallback : eye);
  }

  fired(): void {
    this.firingTime = FIRING_POSE_SECONDS;
  }

  flinch(zone: HitZone): void {
    this.visual.flinch(zone);
  }

  /** The owner reported this body's death. */
  die(direction: Vector3, life: number): void {
    this.endedLife = Math.max(this.endedLife, life);
    this.markDead();
    if (this.fallen) return;
    this.fallen = true;
    this.visual.die(direction);
  }

  /** `now`: this machine's clock in milliseconds. The body is shown `delayMs` behind it. */
  update(dt: number, now: number): void {
    if (this.dead) {
      this.corpseTime += dt;
      this.visual.update(dt);
      return;
    }
    const mode = this.buffer.sample(now - this.options.delayMs, this.sampled);
    if (mode === 'empty') {
      this.syncVisual(dt);
      return;
    }
    const pose = this.sampled;
    this.position.set(pose.x, pose.y, pose.z);
    this.velocity.set(pose.vx, pose.vy, pose.vz);
    this.yaw = pose.yaw;
    this.pitch = pose.pitch;
    this.firingTime = Math.max(0, this.firingTime - dt);
    this.footsteps();
    this.syncVisual(dt);
  }

  dispose(): void {
    this.visual.dispose();
  }

  private revive(): void {
    this.alive = true;
    this.dead = false;
    this.fallen = false;
    this.corpseTime = 0;
    this.stride = 0;
    this.placed = false;
    this.visual.revive();
  }

  private markDead(): void {
    if (this.dead) return;
    this.alive = false;
    this.dead = true;
    this.corpseTime = 0;
    this.velocity.set(0, 0, 0);
  }

  /** Count strides along the path the body is shown walking and emit a footstep for each. */
  private footsteps(): void {
    const travelled = Math.hypot(this.position.x - this.last.x, this.position.z - this.last.z);
    const jumped = !this.placed || travelled > TELEPORT_DISTANCE;
    this.last.copy(this.position);
    this.placed = true;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (jumped || !this.alive || !this.onGround || speed < MIN_STEP_SPEED) {
      this.stride = Math.min(this.stride, 0.5);
      return;
    }
    this.stride += travelled / (this.running ? STRIDE_RUN : STRIDE_WALK);
    if (this.stride < 1) return;
    this.stride -= 1;
    // Crouch-walking is quiet enough to skip, as it is for the local player.
    if (this.crouching) return;
    footstepEvent.ownerId = this.id;
    footstepEvent.position.copy(this.position);
    footstepEvent.surface = this.surfaceBelow();
    footstepEvent.running = this.running;
    this.ctx.events.emit('footstep', footstepEvent);
  }

  private surfaceBelow(): Surface {
    probe.set(this.position.x, this.position.y + 0.5, this.position.z);
    return this.ctx.world.raycast(probe, DOWN, 1.5)?.surface ?? 'concrete';
  }

  private syncVisual(dt: number): void {
    const visual = this.visual;
    visual.root.position.copy(this.position);
    visual.root.rotation.y = this.yaw;
    const pose = this.poseState;
    pose.speed = Math.hypot(this.velocity.x, this.velocity.z);
    pose.crouching = this.crouching;
    pose.aimPitch = this.pitch;
    pose.aiming = this.aiming || this.firingTime > 0;
    pose.firing = this.firingTime > 0;
    pose.reloading = this.reloading;
    visual.setState(pose);
    visual.update(dt);
  }
}
