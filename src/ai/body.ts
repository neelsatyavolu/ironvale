import { MathUtils, Vector3 } from 'three/webgpu';
import type { GameEvents } from '../game/contracts';
import type { Surface } from '../world/types';
import type { BotEnv } from './env';
import { PathHandle, type PathAvoid } from './pathfinder';

/** Body measurements, the same as the player's. */
export const BODY = {
  radius: 0.34,
  standHeight: 1.8,
  crouchHeight: 1.2,
  standEye: 1.64,
  crouchEye: 1.08,
  chestStand: 1.2,
  chestCrouch: 0.75,
} as const;

/** Movement speeds in m/s, before the weapon's mobility. */
export const SPEED = { walk: 1.7, jog: 3.4, run: 5.2, crouch: 1.8, strafe: 2.6 } as const;

const ACCELERATION = 22;
const GRAVITY = 17.5;
const STRIDE_WALK = 1.55;
const STRIDE_RUN = 2.1;
/** How close counts as reaching the last point of a path, and a corner on the way. */
const ARRIVE_DISTANCE = 0.15;
const CORNER_DISTANCE = 0.45;
const GOAL_TOLERANCE = 1.6;
const STUCK_INTERVAL = 0.75;
const STUCK_DISTANCE = 0.2;
const MAX_REPATHS = 3;
const SEPARATION = 0.85;

const footstepEvent: GameEvents['footstep'] = { ownerId: 0, position: new Vector3(), surface: 'concrete', running: false, local: false };

/**
 * The part of a bot that walks: a capsule the size of the player's that
 * follows paths from the shared queue, slides along the world, keeps clear of
 * squad mates, notices when it is stuck and emits footsteps from its stride.
 */
export abstract class BotBody {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly path = new PathHandle();
  readonly goal = new Vector3();
  /** The post this soldier patrols from. */
  readonly home = new Vector3();
  alive = true;
  crouching = false;
  moving = false;
  arrived = false;
  pathFailed = false;
  onGround = false;
  /** Speed of the current move order. */
  moveSpeed = 0;
  private waypoint = 0;
  private wishX = 0;
  private wishZ = 0;
  private stuckTimer = 0;
  private stuckCount = 0;
  private repaths = 0;
  private readonly stuckFrom = new Vector3();
  private surface: Surface = 'concrete';
  private stride = 0;

  protected constructor(
    protected readonly env: BotEnv,
    readonly id: number,
    /** Speed multiplier of the weapon carried. */
    private readonly mobility: number,
  ) {}

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Walk to a point along a path from the shared queue. */
  moveTo(x: number, y: number, z: number, speed: number, avoid?: PathAvoid): void {
    this.goal.set(x, y, z);
    this.beginMove(speed);
    this.repaths = 0;
    this.env.paths.request(this.path, this.position.x, this.position.y, this.position.z, x, y, z, avoid);
  }

  /** Step straight to a nearby point the caller knows is reachable (a sidestep, a peek). */
  moveDirect(x: number, y: number, z: number, speed: number): void {
    if (this.path.status === 'queued') this.env.paths.cancel(this.path);
    this.goal.set(x, y, z);
    this.beginMove(speed);
    this.repaths = MAX_REPATHS;
    this.path.points[0] = x;
    this.path.points[1] = y;
    this.path.points[2] = z;
    this.path.count = 1;
    this.path.partial = false;
    this.path.status = 'ready';
  }

  halt(): void {
    if (this.path.status === 'queued') this.env.paths.cancel(this.path);
    this.moving = false;
  }

  /** Path corner points still ahead, for the debug view. */
  get waypointIndex(): number {
    return this.waypoint;
  }

  /** One frame of movement: steer along the path, move the capsule, count strides. */
  protected move(dt: number): void {
    this.steer(dt);
    this.integrate(dt);
    this.footsteps(dt);
  }

  private beginMove(speed: number): void {
    this.moveSpeed = speed;
    this.moving = true;
    this.arrived = false;
    this.pathFailed = false;
    this.waypoint = 0;
    this.stuckTimer = 0;
    this.stuckCount = 0;
    this.stuckFrom.copy(this.position);
  }

  /** Follow the path: sets the velocity the body wants this frame. */
  private steer(dt: number): void {
    this.wishX = 0;
    this.wishZ = 0;
    if (this.moving) this.followPath(dt);
    // Keep a little room between soldiers.
    for (const other of this.env.bots) {
      if (other.id === this.id || !other.alive) continue;
      const dx = this.position.x - other.position.x;
      const dz = this.position.z - other.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance >= SEPARATION || distance < 1e-4 || Math.abs(this.position.y - other.position.y) > 1.5) continue;
      const push = ((SEPARATION - distance) / distance) * 3;
      this.wishX += dx * push;
      this.wishZ += dz * push;
    }
  }

  private followPath(dt: number): void {
    const path = this.path;
    if (path.status === 'queued') return;
    if (path.status !== 'ready') {
      this.moving = false;
      this.pathFailed = true;
      return;
    }
    const points = path.points;
    let dx = 0;
    let dz = 0;
    let distance = 0;
    while (this.waypoint < path.count) {
      const at = this.waypoint * 3;
      dx = (points[at] ?? 0) - this.position.x;
      dz = (points[at + 2] ?? 0) - this.position.z;
      distance = Math.hypot(dx, dz);
      if (distance > (this.waypoint === path.count - 1 ? ARRIVE_DISTANCE : CORNER_DISTANCE)) break;
      this.waypoint++;
    }
    if (this.waypoint >= path.count) {
      const short = Math.hypot(this.goal.x - this.position.x, this.goal.z - this.position.z) > GOAL_TOLERANCE;
      if (path.partial && short && this.repaths < MAX_REPATHS) {
        this.repath();
        return;
      }
      this.moving = false;
      this.arrived = !short;
      this.pathFailed = short;
      return;
    }
    const last = this.waypoint === path.count - 1;
    let speed = this.moveSpeed * this.mobility;
    if (this.crouching) speed = Math.min(speed, SPEED.crouch);
    if (last) speed *= MathUtils.clamp(distance / 0.8, 0.4, 1);
    this.wishX = (dx / distance) * speed;
    this.wishZ = (dz / distance) * speed;

    this.stuckTimer += dt;
    if (this.stuckTimer < STUCK_INTERVAL) return;
    this.stuckTimer = 0;
    const moved = this.stuckFrom.distanceTo(this.position);
    this.stuckFrom.copy(this.position);
    if (moved >= STUCK_DISTANCE) {
      this.stuckCount = 0;
    } else if (++this.stuckCount >= MAX_REPATHS || this.repaths >= MAX_REPATHS) {
      this.moving = false;
      this.pathFailed = true;
    } else {
      this.repath();
    }
  }

  private repath(): void {
    this.repaths++;
    this.waypoint = 0;
    const p = this.position;
    this.env.paths.request(this.path, p.x, p.y, p.z, this.goal.x, this.goal.y, this.goal.z);
  }

  private integrate(dt: number): void {
    const velocity = this.velocity;
    const wishing = this.wishX !== 0 || this.wishZ !== 0;
    // A soldier standing still on the ground costs nothing.
    if (!wishing && this.onGround && this.speed < 0.05) {
      velocity.set(0, 0, 0);
      return;
    }
    const ax = this.wishX - velocity.x;
    const az = this.wishZ - velocity.z;
    const change = Math.hypot(ax, az);
    const limit = ACCELERATION * dt;
    const scale = change > limit ? limit / change : 1;
    velocity.x += ax * scale;
    velocity.z += az * scale;
    velocity.y -= GRAVITY * dt;
    const height = this.crouching ? BODY.crouchHeight : BODY.standHeight;
    const world = this.env.ctx.world;
    const result = world.moveCapsule(this.position, velocity, dt, BODY.radius, height);
    this.position.copy(result.position);
    velocity.copy(result.velocity);
    this.onGround = result.onGround;
    if (result.groundSurface) this.surface = result.groundSurface;
    if (this.onGround && velocity.y < 0) velocity.y = 0;
    // Fell out of the level: back to the last place the soldier meant to be.
    if (this.position.y < world.bounds.min.y - 10) {
      this.position.copy(this.home);
      velocity.set(0, 0, 0);
    }
  }


  private footsteps(dt: number): void {
    const speed = this.speed;
    if (!this.onGround || speed < 0.8) {
      this.stride = Math.min(this.stride, 0.5);
      return;
    }
    const running = speed > SPEED.jog + 0.6;
    this.stride += (speed * dt) / (running ? STRIDE_RUN : STRIDE_WALK);
    if (this.stride < 1) return;
    this.stride -= 1;
    if (this.crouching) return;
    footstepEvent.ownerId = this.id;
    footstepEvent.position.copy(this.position);
    footstepEvent.surface = this.surface;
    footstepEvent.running = running;
    this.env.ctx.events.emit('footstep', footstepEvent);
  }
}
