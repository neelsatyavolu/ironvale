import { MathUtils, Vector3 } from 'three/webgpu';
import type { Difficulty } from '../core/settings';
import type { Combatant, CombatantHit, DamageInfo, GameEvents, SoldierVisual, Team, WeaponDef } from '../game/contracts';
import { hitTestHumanoid } from '../game/hitbox';
import { WEAPON_DEFS } from '../weapons/defs';
import { AimModel } from './aim';
import type { BotState } from './blackboard';
import { BODY, BotBody } from './body';
import { BotWeapon } from './botweapon';
import { DIFFICULTY, scaledWeapon, type DifficultyProfile } from './difficulty';
import type { BotEnv } from './env';
import { botShotSpread, readyToFire } from './marksman';
import { Awareness, type NoiseKind } from './perception';
import { ROLES, type BotRole, type RoleDef } from './roles';

const DEG = Math.PI / 180;
/** The muzzle must point within this of the target before the trigger is pulled. */
const FIRE_ARC = 9 * DEG;
const FIRING_POSE_SECONDS = 0.12;
/** A muzzle further than this from the eye is a stale or broken transform. */
const MUZZLE_REACH = 1.5;
const FLINCH_DEGREES = 2.5;
/** A mate this close to the line of fire, plus this much per metre along it, makes the soldier hold its shot. */
const MATE_CLEARANCE = 0.8;
const MATE_CONE = 0.06;
const PITCH_LIMIT = 60 * DEG;
const NOISE_URGENCY: Readonly<Record<NoiseKind, number>> = { footstep: 0, shot: 1, impact: 2, nearMiss: 3 };

const actionEvent: GameEvents['weaponAction'] = { shooterId: 0, weapon: WEAPON_DEFS.m4a1, stage: 'magOut', position: new Vector3(), local: false };
const eye = new Vector3();
const muzzle = new Vector3();
const shotDirection = new Vector3();

/**
 * One enemy soldier: a `Combatant` that aims and shoots as its brain orders,
 * on top of the walking body in `body.ts`. The brain (`brain.ts`,
 * `tactics.ts`) writes the public fields a few times a second; `update`
 * carries them out every frame.
 */
export class Bot extends BotBody implements Combatant {
  readonly kind = 'bot' as const;
  readonly roleDef: RoleDef;
  readonly profile: DifficultyProfile;
  readonly weaponDef: WeaponDef;
  readonly weapon: BotWeapon;
  readonly aim: AimModel;
  readonly awareness = new Awareness();
  readonly maxHealth: number;
  health: number;
  yaw: number;

  // ---- set by the brain
  state: BotState = 'patrol';
  /** Seconds in the current state. */
  stateTime = 0;
  target: Combatant | null = null;
  /** The target is in view and the reaction delay has passed. */
  targetVisible = false;
  /** Only the target's head is in view, so that is the aim point. */
  aimAtHead = false;
  /** Seconds since this soldier last saw the target with its own eyes. */
  unseenTime = Infinity;
  /** Seconds the target has been tracked without a break; 0 while it is out of sight. */
  sightedTime = 0;
  readonly lastKnown = new Vector3();
  /** Game time `lastKnown` was last updated. */
  infoTime = -Infinity;
  /** What the gun does: track the visible target, fire at the last known position, or stay quiet. */
  fireMode: 'none' | 'target' | 'lastKnown' = 'none';
  /** What the soldier faces when not just looking where it walks. */
  watch: 'none' | 'enemy' | 'point' = 'none';
  readonly watchPoint = new Vector3();
  /** Facing to settle on when idle. */
  restYaw: number;
  coverNode = -1;
  /** Seconds until the current tactic is reconsidered. */
  tacticTimer = 0;
  /** General-purpose step inside a state (moving / hiding / peeking, ...) and its timer. */
  phase: 'moving' | 'hiding' | 'peeking' = 'moving';
  phaseTimer = 0;
  idleTimer = 0;
  scanTimer = 0;
  thinkTimer = 0;
  lastThink = 0;
  /** Game time until which this soldier holds one of the squad's firing turns, and when it may ask again. */
  fireTurnUntil = -Infinity;
  fireTurnAgain = -Infinity;
  fellBack = false;
  soughtReloadCover = false;
  preferCover = false;
  strafeSide = 1;
  failedPeeks = 0;

  // ---- stimuli, written by event handlers and read at the next think
  noisePending = false;
  investigatePending = false;
  noiseKind: NoiseKind = 'shot';
  readonly noisePoint = new Vector3();
  hitPending = false;
  readonly hitFrom = new Vector3();

  corpseTime = 0;
  private aimPitch = 0;
  private firingTime = 0;
  private yawError = 0;
  private readonly aimPoint = new Vector3();
  private readonly pose = { speed: 0, crouching: false, aimPitch: 0, aiming: false, firing: false, reloading: false };

  constructor(
    env: BotEnv,
    id: number,
    readonly team: Team,
    readonly name: string,
    readonly role: BotRole,
    difficulty: Difficulty,
    readonly visual: SoldierVisual,
    spawn: Vector3,
    yaw: number,
  ) {
    const roleDef = ROLES[role];
    const weaponDef = scaledWeapon(WEAPON_DEFS[roleDef.weapon], difficulty);
    super(env, id, weaponDef.mobility);
    const profile = DIFFICULTY[difficulty];
    this.roleDef = roleDef;
    this.profile = profile;
    this.weaponDef = weaponDef;
    this.weapon = new BotWeapon(
      weaponDef,
      {
        burstMin: Math.max(1, Math.round(roleDef.burstMin * profile.burstLength)),
        burstMax: Math.max(1, Math.round(roleDef.burstMax * profile.burstLength)),
        pauseMin: roleDef.pauseMin * profile.burstPause,
        pauseMax: roleDef.pauseMax * profile.burstPause,
      },
      env.random,
    );
    this.aim = new AimModel(profile);
    this.maxHealth = profile.health;
    this.health = profile.health;
    this.position.copy(spawn);
    this.home.copy(spawn);
    this.yaw = yaw;
    this.restYaw = yaw;
    this.syncVisual(0);
  }

  get firing(): boolean {
    return this.alive && this.fireTurnUntil > this.env.time;
  }

  /** Up or down tilt of the aim, in radians. Sent to a co-op guest with the rest of the pose. */
  get pitch(): number {
    return this.aimPitch;
  }

  get inCombat(): boolean {
    return this.state !== 'patrol' && this.state !== 'investigate' && this.state !== 'dead';
  }

  eyePosition(target: Vector3): Vector3 {
    const height = this.crouching ? BODY.crouchEye : BODY.standEye;
    return target.set(this.position.x, this.position.y + height, this.position.z);
  }

  hitTest(origin: Vector3, direction: Vector3, maxDistance: number): CombatantHit | null {
    return hitTestHumanoid(this.position, this.crouching, origin, direction, maxDistance);
  }

  applyDamage(info: DamageInfo): void {
    if (!this.alive) return;
    const attacker = this.env.ctx.combat.get(info.attackerId);
    // Stray rounds from the squad's own crossfire do not hurt.
    if (attacker && attacker.team === this.team) return;
    this.health = Math.max(0, this.health - info.amount);
    if (this.health <= 0) {
      this.die(info);
      return;
    }
    this.visual.flinch(info.zone);
    this.aim.disturb(FLINCH_DEGREES);
    if (attacker) {
      this.hitPending = true;
      this.hitFrom.copy(attacker.position);
    }
  }

  /** Take in a noise for the next think. The more urgent kind wins when two arrive together. */
  hear(kind: NoiseKind, point: Vector3): void {
    if (this.noisePending && NOISE_URGENCY[kind] < NOISE_URGENCY[this.noiseKind]) return;
    this.noisePending = true;
    this.noiseKind = kind;
    this.noisePoint.copy(point);
  }

  setState(state: BotState, reason: string): void {
    if (state === this.state) return;
    this.env.transition(this, this.state, state, reason);
    this.state = state;
    this.stateTime = 0;
  }

  update(dt: number): void {
    if (!this.alive) {
      this.corpseTime += dt;
      this.visual.update(dt);
      return;
    }
    this.stateTime += dt;
    this.move(dt);
    this.face(dt);
    this.shoot(dt);
    this.syncVisual(dt);
  }

  /** Turn at a human rate toward the enemy, the watched point, or the way the soldier walks. */
  private face(dt: number): void {
    let desired = this.restYaw;
    let pitch = 0;
    if (this.watch !== 'none') {
      const point = this.aimPoint;
      const target = this.target;
      if (this.watch === 'point') point.copy(this.watchPoint);
      else if (this.targetVisible && target) {
        if (this.aimAtHead) target.eyePosition(point);
        else {
          point.copy(target.position);
          point.y += target.crouching ? BODY.chestCrouch : BODY.chestStand;
        }
      } else {
        point.copy(this.lastKnown);
        point.y += BODY.chestStand;
      }
      const dx = point.x - this.position.x;
      const dz = point.z - this.position.z;
      desired = Math.atan2(-dx, -dz);
      const eyeHeight = this.position.y + (this.crouching ? BODY.crouchEye : BODY.standEye);
      pitch = MathUtils.clamp(Math.atan2(point.y - eyeHeight, Math.hypot(dx, dz)), -PITCH_LIMIT, PITCH_LIMIT);
    } else if (this.speed > 0.4) {
      desired = Math.atan2(-this.velocity.x, -this.velocity.z);
    }
    const difference = wrapAngle(desired - this.yaw);
    const size = Math.abs(difference);
    // Fast through the bulk of a turn, easing in at the end.
    const rate = this.profile.turnRate * DEG * MathUtils.clamp(size / 0.5, 0.25, 1);
    const turn = Math.min(size, rate * dt);
    this.yaw = wrapAngle(this.yaw + Math.sign(difference) * turn);
    this.yawError = size - turn;
    this.aimPitch = MathUtils.damp(this.aimPitch, pitch, 10, dt);
  }

  private shoot(dt: number): void {
    const weapon = this.weapon;
    const target = this.target;
    const tracking = this.fireMode === 'target' && this.targetVisible && target !== null && target.alive;
    this.aim.update(dt, tracking);
    this.sightedTime = tracking ? this.sightedTime + dt : 0;
    const ready = !tracking || readyToFire(this.weaponDef, this.sightedTime, this.profile.reactionTime);
    const wantsFire = (tracking || this.fireMode === 'lastKnown') && this.watch === 'enemy' && ready;
    const fired = weapon.update(dt, wantsFire && this.yawError < FIRE_ARC && !this.mateInLine());
    if (weapon.reloadStarted) {
      this.env.callout(this, 'reloading');
      this.emitAction(this.weaponDef.reloadStyle === 'belt' ? 'beltOpen' : 'magOut');
    }
    if (weapon.reloadFinished) this.emitAction(this.weaponDef.reloadStyle === 'belt' ? 'beltClose' : 'magIn');
    this.firingTime = fired ? FIRING_POSE_SECONDS : Math.max(0, this.firingTime - dt);
    if (!fired) return;

    const world = this.env.ctx.world;
    this.eyePosition(eye);
    this.visual.muzzleWorld(muzzle);
    // Never start a bullet from a muzzle that is stale or poking through a wall, and
    // when the eye has the target but the gun is still below the cover, shoot from the eye.
    const usable = muzzle.distanceToSquared(eye) < MUZZLE_REACH * MUZZLE_REACH && world.lineOfSight(eye, muzzle);
    if (!usable || (tracking && !world.lineOfSight(muzzle, this.aimPoint))) muzzle.copy(eye);
    shotDirection.subVectors(this.aimPoint, muzzle);
    const distance = shotDirection.length();
    if (distance < 1e-3) return;
    shotDirection.divideScalar(distance);
    let crossing = 0;
    if (tracking && target) {
      // How fast the target moves across the line of fire, in degrees per second.
      const along = target.velocity.dot(shotDirection);
      const across = Math.sqrt(Math.max(0, target.velocity.lengthSq() - along * along));
      crossing = (across / distance) / DEG;
    }
    const spread = botShotSpread(this.weaponDef, this.aim.spread(crossing, this.speed > 1), distance, this.roleDef.minRange);
    this.env.ctx.ballistics.fire(this, this.weaponDef, muzzle, shotDirection, spread);
  }
  /** true when a squad mate stands in or near the line of fire. Checked every frame the trigger is wanted. */
  private mateInLine(): boolean {
    const ax = this.position.x;
    const az = this.position.z;
    const dx = this.aimPoint.x - ax;
    const dz = this.aimPoint.z - az;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq < 1e-6) return false;
    const length = Math.sqrt(lengthSq);
    for (const other of this.env.bots) {
      if (other.id === this.id || !other.alive || Math.abs(other.position.y - this.position.y) > 2.5) continue;
      const t = ((other.position.x - ax) * dx + (other.position.z - az) * dz) / lengthSq;
      if (t <= 0 || t >= 1) continue;
      const off = Math.hypot(other.position.x - (ax + dx * t), other.position.z - (az + dz * t));
      // The safe corridor widens with distance, like the cone the shots fall in.
      if (off < MATE_CLEARANCE + t * length * MATE_CONE) return true;
    }
    return false;
  }

  private syncVisual(dt: number): void {
    const visual = this.visual;
    visual.root.position.copy(this.position);
    visual.root.rotation.y = this.yaw;
    const pose = this.pose;
    pose.speed = this.speed;
    pose.crouching = this.crouching;
    pose.aimPitch = this.aimPitch;
    pose.aiming = this.watch === 'enemy';
    pose.firing = this.firingTime > 0;
    pose.reloading = this.weapon.reloading;
    visual.setState(pose);
    visual.update(dt);
  }

  private emitAction(stage: GameEvents['weaponAction']['stage']): void {
    actionEvent.shooterId = this.id;
    actionEvent.weapon = this.weaponDef;
    actionEvent.stage = stage;
    actionEvent.position.copy(this.position);
    actionEvent.position.y += BODY.chestStand;
    this.env.ctx.events.emit('weaponAction', actionEvent);
  }

  private die(info: DamageInfo): void {
    const from = this.state;
    this.alive = false;
    this.state = 'dead';
    this.env.transition(this, from, 'dead', `killed by ${info.weaponId}`);
    this.halt();
    this.fireMode = 'none';
    this.velocity.set(0, 0, 0);
    this.coverNode = -1;
    this.visual.die(info.direction);
    const events = this.env.ctx.events;
    events.emit('died', {
      victimId: this.id,
      killerId: info.attackerId,
      weaponId: info.weaponId,
      headshot: info.zone === 'head',
    });
    this.env.callout(this, 'death');
  }
}

/** Wrap an angle to -PI .. PI. */
export function wrapAngle(angle: number): number {
  const wrapped = (angle + Math.PI) % (Math.PI * 2);
  return (wrapped < 0 ? wrapped + Math.PI * 2 : wrapped) - Math.PI;
}
