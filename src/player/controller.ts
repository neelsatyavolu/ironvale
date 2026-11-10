import { MathUtils, Vector3 } from 'three/webgpu';
import type { EventBus } from '../core/events';
import type { Input } from '../core/input';
import type { SettingsStore } from '../core/settings';
import type { CombatantHit, DamageInfo, GameEvents, PlayerBody, Team } from '../game/contracts';
import { hitTestHumanoid } from '../game/hitbox';
import type { Engine } from '../render/engine';
import type { InteriorZone, Surface, World } from '../world/types';

const RADIUS = 0.34;
const STAND_HEIGHT = 1.8;
const CROUCH_HEIGHT = 1.2;
const STAND_EYE = 1.64;
const CROUCH_EYE = 1.08;
const WALK_SPEED = 4.2;
const SPRINT_SPEED = 6.4;
const CROUCH_SPEED = 2.1;
const AIM_SPEED_FACTOR = 0.55;
const GROUND_ACCEL = 48;
const AIR_ACCEL = 6;
const FRICTION = 9.5;
const GRAVITY = 17.5;
const JUMP_SPEED = 5.1;
const COYOTE_TIME = 0.1;
const MAX_PITCH = MathUtils.degToRad(86);
/** Metres travelled per footstep. */
const STRIDE_WALK = 1.55;
const STRIDE_RUN = 2.1;
const REGEN_DELAY = 5;
const REGEN_PER_SECOND = 18;
const DEG = Math.PI / 180;

export interface PlayerDeps {
  readonly engine: Engine;
  readonly input: Input;
  readonly settings: SettingsStore;
  readonly events: EventBus<GameEvents>;
  readonly world: World;
  readonly id: number;
  readonly team: Team;
  readonly interiors: () => readonly InteriorZone[];
}

/**
 * First-person body: walking, sprinting, crouching, jumping, the camera rig
 * (bob, sway, recoil, landing dip) and health with delayed regeneration.
 */
export class PlayerController implements PlayerBody {
  readonly kind = 'local' as const;
  readonly name = 'You';
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly id: number;
  readonly team: Team;

  yaw = 0;
  pitch = 0;
  onGround = false;
  sprinting = false;
  crouching = false;
  indoors = false;
  lookYaw = 0;
  lookPitch = 0;
  health = 100;
  alive = true;
  /** When false the body ignores input (menus, death). */
  controllable = true;

  private eye = STAND_EYE;
  private surface: Surface = 'concrete';
  private sinceGrounded = 0;
  private strideProgress = 0;
  private bobPhase = 0;
  private bobAmount = 0;
  private landDip = 0;
  private landDipVelocity = 0;
  private roll = 0;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private recoilReturnPitch = 0;
  private recoilReturnYaw = 0;
  private sinceHurt = Infinity;
  private mobility = 1;
  private blockSprint = false;
  private aimBlend = 0;
  private zoom = 1;
  private nudgeYaw = 0;
  private nudgePitch = 0;

  private readonly wish = new Vector3();
  private readonly scratch = new Vector3();

  constructor(private readonly deps: PlayerDeps) {
    this.id = deps.id;
    this.team = deps.team;
    deps.engine.camera.rotation.order = 'YXZ';
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  eyePosition(target: Vector3): Vector3 {
    return target.set(this.position.x, this.position.y + this.eye, this.position.z);
  }

  hitTest(origin: Vector3, direction: Vector3, maxDistance: number): CombatantHit | null {
    return hitTestHumanoid(this.position, this.crouching, origin, direction, maxDistance);
  }

  applyDamage(info: DamageInfo): void {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - info.amount);
    this.sinceHurt = 0;
    this.deps.events.emit('playerHurt', {
      amount: info.amount,
      health: this.health,
      direction: this.scratch.copy(info.direction).negate(),
    });
    // A hit jolts the view a little.
    this.addRecoil(MathUtils.randFloat(0.6, 1.4), MathUtils.randFloatSpread(1.6), 0.9);
    if (this.health <= 0) {
      this.alive = false;
      this.deps.events.emit('died', {
        victimId: this.id,
        killerId: info.attackerId,
        weaponId: info.weaponId,
        headshot: info.zone === 'head',
      });
    }
  }

  setWeaponModifiers(modifiers: { mobility: number; aimBlend: number; zoom: number; blockSprint?: boolean }): void {
    this.blockSprint = modifiers.blockSprint ?? false;
    this.mobility = modifiers.mobility;
    this.aimBlend = modifiers.aimBlend;
    this.zoom = modifiers.zoom;
  }

  addRecoil(pitchDegrees: number, yawDegrees: number, recovery: number): void {
    const pitch = pitchDegrees * DEG;
    const yaw = yawDegrees * DEG;
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
    this.recoilReturnPitch += pitch * recovery;
    this.recoilReturnYaw += yaw * recovery;
  }

  nudgeView(yaw: number, pitch: number): void {
    this.nudgeYaw += yaw;
    this.nudgePitch += pitch;
  }

  respawn(position: Vector3, yaw: number): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.health = 100;
    this.alive = true;
    this.crouching = false;
    this.eye = STAND_EYE;
    this.recoilPitch = this.recoilYaw = this.recoilReturnPitch = this.recoilReturnYaw = 0;
    this.sinceHurt = Infinity;
    this.deps.events.emit('spawned', { combatantId: this.id });
    this.applyCamera(0);
  }

  update(dt: number): void {
    const { input, settings, world } = this.deps;
    const controls = settings.value.controls;
    const active = this.controllable && this.alive;

    this.lookYaw = 0;
    this.lookPitch = 0;
    if (active) this.look(dt);
    this.recoverRecoil(dt);

    // Movement intent in the horizontal plane.
    const forward = active ? Number(input.isDown('moveForward')) - Number(input.isDown('moveBack')) : 0;
    const strafe = active ? Number(input.isDown('moveRight')) - Number(input.isDown('moveLeft')) : 0;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.wish.set(strafe * cos - forward * sin, 0, -strafe * sin - forward * cos);
    const moving = this.wish.lengthSq() > 0;
    if (moving) this.wish.normalize();

    const wantsCrouch = active && input.isDown('crouch');
    if (wantsCrouch) this.crouching = true;
    else if (this.crouching && this.canStand()) this.crouching = false;

    // Holding breath shares Shift with sprint; aiming wins.
    this.sprinting =
      active &&
      input.isDown('sprint') &&
      forward > 0 &&
      !this.crouching &&
      this.onGround &&
      !this.blockSprint &&
      this.aimBlend < 0.3;

    let maxSpeed = this.crouching ? CROUCH_SPEED : this.sprinting ? SPRINT_SPEED : WALK_SPEED;
    maxSpeed *= this.mobility * MathUtils.lerp(1, AIM_SPEED_FACTOR, this.aimBlend);

    if (this.onGround) {
      this.applyFriction(dt);
      this.accelerate(maxSpeed, GROUND_ACCEL, dt);
    } else {
      this.accelerate(maxSpeed, AIR_ACCEL, dt);
    }

    this.sinceGrounded = this.onGround ? 0 : this.sinceGrounded + dt;
    if (active && input.wasPressed('jump') && this.sinceGrounded < COYOTE_TIME && !this.crouching) {
      this.velocity.y = JUMP_SPEED;
      this.sinceGrounded = COYOTE_TIME;
      this.onGround = false;
      this.deps.events.emit('jumped', { ownerId: this.id, position: this.position, local: true });
    }

    this.velocity.y -= GRAVITY * dt;
    const fallSpeed = -this.velocity.y;
    const wasGrounded = this.onGround;
    const height = this.crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
    const result = world.moveCapsule(this.position, this.velocity, dt, RADIUS, height);
    this.position.copy(result.position);
    this.velocity.copy(result.velocity);
    this.onGround = result.onGround;
    if (result.groundSurface) this.surface = result.groundSurface;
    if (this.onGround && this.velocity.y < 0) this.velocity.y = 0;

    if (this.onGround && !wasGrounded && fallSpeed > 3) {
      this.landDipVelocity -= Math.min(fallSpeed, 12) * 0.22;
      this.deps.events.emit('landed', {
        ownerId: this.id,
        position: this.position,
        surface: this.surface,
        speed: fallSpeed,
        local: true,
      });
      this.strideProgress = 0;
    }

    // Fell out of the world: put the player back on the ground above.
    if (this.position.y < world.bounds.min.y - 20) {
      const ground = world.groundHeight(this.position.x, this.position.z, world.bounds.max.y + 5, 500);
      this.position.y = (ground ?? 0) + 0.1;
      this.velocity.set(0, 0, 0);
    }

    this.footsteps(dt);
    this.regenerate(dt);
    this.indoors = this.deps.interiors().some((zone) => zone.box.containsPoint(this.eyePosition(this.scratch)));

    const eyeTarget = this.crouching ? CROUCH_EYE : STAND_EYE;
    this.eye = MathUtils.damp(this.eye, eyeTarget, 12, dt);
    this.applyCamera(dt, strafe, controls.preset === 'trackpad');
  }

  private look(dt: number): void {
    const { input, settings } = this.deps;
    const controls = settings.value.controls;
    const look = input.consumeLook(dt);
    // Sensitivity is degrees per 1000 px; scale with zoom so aimed turns match what is on screen.
    const aimScale = MathUtils.lerp(1, controls.adsSensitivity * this.zoom, this.aimBlend);
    const scale = (controls.sensitivity / 1000) * DEG * aimScale;
    this.lookYaw = -look.dx * scale;
    this.lookPitch = -look.dy * scale * (controls.invertY ? -1 : 1);
    this.yaw += this.lookYaw;
    this.pitch += this.lookPitch;
    this.yaw += this.nudgeYaw;
    this.pitch += this.nudgePitch;
    this.nudgeYaw = 0;
    this.nudgePitch = 0;
    this.pitch = MathUtils.clamp(this.pitch, -MAX_PITCH, MAX_PITCH);
  }

  private recoverRecoil(dt: number): void {
    // Kick is applied to the real view angles quickly, then the recoverable share eases back.
    const applyRate = 1 - Math.exp(-dt * 38);
    const kickPitch = this.recoilPitch * applyRate;
    const kickYaw = this.recoilYaw * applyRate;
    this.recoilPitch -= kickPitch;
    this.recoilYaw -= kickYaw;
    this.pitch = MathUtils.clamp(this.pitch + kickPitch, -MAX_PITCH, MAX_PITCH);
    this.yaw += kickYaw;

    const returnRate = 1 - Math.exp(-dt * 6.5);
    const backPitch = this.recoilReturnPitch * returnRate;
    const backYaw = this.recoilReturnYaw * returnRate;
    this.recoilReturnPitch -= backPitch;
    this.recoilReturnYaw -= backYaw;
    this.pitch -= backPitch;
    this.yaw -= backYaw;
  }

  private applyFriction(dt: number): void {
    const speed = this.speed;
    if (speed < 1e-4) return;
    const drop = Math.max(speed, 1.2) * FRICTION * dt;
    const factor = Math.max(0, speed - drop) / speed;
    this.velocity.x *= factor;
    this.velocity.z *= factor;
  }

  private accelerate(maxSpeed: number, accel: number, dt: number): void {
    const current = this.velocity.x * this.wish.x + this.velocity.z * this.wish.z;
    const add = Math.min(maxSpeed - current, accel * dt);
    if (add <= 0) return;
    this.velocity.x += this.wish.x * add;
    this.velocity.z += this.wish.z * add;
  }

  private canStand(): boolean {
    const head = this.scratch.set(this.position.x, this.position.y + CROUCH_HEIGHT - 0.1, this.position.z);
    return this.deps.world.raycast(head, UP, STAND_HEIGHT - CROUCH_HEIGHT + 0.15) === null;
  }

  private footsteps(dt: number): void {
    if (!this.onGround || this.speed < 0.8) {
      this.strideProgress = Math.min(this.strideProgress, 0.5);
      return;
    }
    const stride = this.sprinting ? STRIDE_RUN : STRIDE_WALK;
    this.strideProgress += (this.speed * dt) / stride;
    if (this.strideProgress < 1) return;
    this.strideProgress -= 1;
    // Crouch-walking is quiet enough to skip.
    if (this.crouching) return;
    this.deps.events.emit('footstep', {
      ownerId: this.id,
      position: this.position,
      surface: this.surface,
      running: this.sprinting,
      local: true,
    });
  }

  private regenerate(dt: number): void {
    this.sinceHurt += dt;
    if (!this.alive || this.health >= 100 || this.sinceHurt < REGEN_DELAY) return;
    this.health = Math.min(100, this.health + REGEN_PER_SECOND * dt);
  }

  private applyCamera(dt: number, strafe = 0, gentle = false): void {
    const { engine, settings } = this.deps;
    const gameplay = settings.value.gameplay;
    const camera = engine.camera;

    const moving = this.onGround && this.speed > 0.5;
    const target = moving ? Math.min(1, this.speed / SPRINT_SPEED) : 0;
    this.bobAmount = MathUtils.damp(this.bobAmount, target, 8, dt);
    const stride = this.sprinting ? STRIDE_RUN : STRIDE_WALK;
    if (moving) this.bobPhase += ((this.speed * dt) / stride) * Math.PI;
    // Aiming steadies the head; trackpad players get a slightly calmer bob.
    const bobScale = gameplay.headBob * this.bobAmount * (1 - this.aimBlend * 0.75) * (gentle ? 0.8 : 1);
    const bobY = Math.sin(this.bobPhase * 2) * 0.028 * bobScale;
    const bobX = Math.cos(this.bobPhase) * 0.02 * bobScale;

    // Critically damped spring for the landing dip.
    this.landDipVelocity += (-this.landDip * 140 - this.landDipVelocity * 20) * dt;
    this.landDip += this.landDipVelocity * dt;

    this.roll = MathUtils.damp(this.roll, -strafe * 0.012 * (this.onGround ? 1 : 0.3), 8, dt);

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    camera.position.set(
      this.position.x + bobX * cos,
      this.position.y + this.eye + bobY + this.landDip,
      this.position.z - bobX * sin,
    );
    camera.rotation.set(this.pitch, this.yaw, this.roll + bobX * 0.25);
    engine.setFov(fovForZoom(gameplay.fov, MathUtils.lerp(1, this.zoom, smooth(this.aimBlend))));
  }
}

const UP = new Vector3(0, 1, 0);

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Zoom multiplies the tangent of the half field of view, the way optical magnification works. */
function fovForZoom(baseFov: number, zoom: number): number {
  const half = Math.tan((baseFov * DEG) / 2) * zoom;
  return (2 * Math.atan(half)) / DEG;
}
