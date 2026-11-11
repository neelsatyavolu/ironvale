import { Vector3 } from 'three/webgpu';
import type { RayHit, Surface } from '../world/types';

/** Hand grenade figures. Tuned so a level throw first lands about 15 m out and rests near 18 m. */
export const GRENADE = {
  /** Seconds from release to the blast. Holding the grenade does not run it down. */
  fuse: 2.5,
  /** Metres per second off the hand. */
  throwSpeed: 16,
  /** Added to the look direction before it is normalised: about ten degrees of lift on a level look. */
  upBias: 0.18,
  gravity: 9.81,
  /** Collision radius in metres. */
  radius: 0.045,
  /** Share of the speed into a surface that comes back out of a hard bounce. */
  restitution: 0.35,
  /** Share of the speed along a surface kept through a hard bounce. */
  friction: 0.45,
  /** Friction coefficient once it is rolling. */
  rollFriction: 0.6,
  /** Contacts slower than this (m/s into the surface) roll instead of bouncing. */
  bounceSpeed: 1,
  /** Rolling slower than this on walkable ground, it stops. */
  restSpeed: 0.25,
  /** Fixed simulation step, seconds. The flight and the preview arc both use it. */
  step: 1 / 60,
  /** Full damage at the centre; still lethal at `lethalRadius`; nothing at `blastRadius`. */
  maxDamage: 200,
  lethalDamage: 100,
  lethalRadius: 3,
  blastRadius: 8,
  /** The view shakes out to here. */
  shakeRadius: 32,
  /** Points an arc can have: one per step of the fuse, plus the start. */
  maxArcPoints: 152,
} as const;

/** Slopes at least this upright (normal.y) can hold a grenade at rest. */
const REST_NORMAL_Y = 0.7;
/** How far past this step's travel to look for a surface, in radii. Catches grazing contacts early. */
const LOOKAHEAD_RADII = 4;
const CONTACTS_PER_STEP = 2;
/** The blast is traced from a little above where the grenade lies, so a kerb or a rut does not shield everyone. */
export const BLAST_LIFT = 0.25;

/** The part of the collision world a grenade needs. */
export interface GrenadeWorld {
  raycast(origin: Vector3, direction: Vector3, maxDistance: number): RayHit | null;
  lineOfSight(a: Vector3, b: Vector3): boolean;
}

/** One grenade's simulation state. Mutated in place by `stepGrenade`. */
export interface GrenadeBody {
  readonly position: Vector3;
  readonly velocity: Vector3;
  resting: boolean;
  /** Speed into the surface of a hard bounce during the last step, m/s; 0 when there was none. */
  impact: number;
  /** What the last hard bounce hit. */
  surface: Surface;
}

const direction = new Vector3();
const from = new Vector3();
const arcBody = createGrenadeBody();

export function createGrenadeBody(): GrenadeBody {
  return { position: new Vector3(), velocity: new Vector3(), resting: false, impact: 0, surface: 'concrete' };
}

/** Velocity of a grenade thrown while looking along `forward` (unit length), written to `out`. */
export function throwVelocity(forward: Vector3, out: Vector3): Vector3 {
  out.copy(forward);
  out.y += GRENADE.upBias;
  return out.normalize().multiplyScalar(GRENADE.throwSpeed);
}

/**
 * Advance a grenade by one step: gravity, then travel, bouncing off or rolling
 * along whatever is in the way. The same function drives the thrown grenade
 * and the preview arc, so the two always agree.
 */
export function stepGrenade(body: GrenadeBody, world: GrenadeWorld, dt: number): void {
  body.impact = 0;
  if (body.resting) return;
  const { position, velocity } = body;
  const radius = GRENADE.radius;
  velocity.y -= GRENADE.gravity * dt;

  let remaining = dt;
  for (let contact = 0; contact < CONTACTS_PER_STEP && remaining > 1e-6; contact++) {
    const speed = velocity.length();
    if (speed < 1e-5) return;
    const travel = speed * remaining;
    direction.copy(velocity).divideScalar(speed);
    const hit = world.raycast(position, direction, travel + radius * LOOKAHEAD_RADII);
    if (!hit) {
      position.addScaledVector(direction, travel);
      return;
    }
    const normal = hit.normal;
    // How fast the centre closes on the surface per metre travelled, and how far it can go before touching.
    const closing = -direction.dot(normal);
    const gap = hit.distance * closing - radius;
    if (gap < 0) {
      // Already closer than its own radius (a grazing approach): push it back out.
      position.addScaledVector(normal, -gap);
    } else {
      const advance = closing > 1e-6 ? gap / closing : travel;
      if (advance >= travel) {
        position.addScaledVector(direction, travel);
        return;
      }
      position.addScaledVector(direction, advance);
      remaining -= advance / speed;
    }

    const into = -velocity.dot(normal);
    if (into <= 0) continue;
    if (into > GRENADE.bounceSpeed) {
      // Hard bounce: split into the part along the surface and the part into it.
      velocity.addScaledVector(normal, into).multiplyScalar(GRENADE.friction);
      velocity.addScaledVector(normal, into * GRENADE.restitution);
      body.impact = Math.max(body.impact, into);
      body.surface = hit.surface;
      continue;
    }
    // Rolling contact: no rebound, and friction in proportion to the push into the surface.
    velocity.addScaledVector(normal, into);
    const along = velocity.length();
    const slowed = Math.max(0, along - GRENADE.rollFriction * into);
    if (normal.y > REST_NORMAL_Y && slowed < GRENADE.restSpeed) {
      velocity.set(0, 0, 0);
      body.resting = true;
      return;
    }
    if (along > 1e-6) velocity.multiplyScalar(slowed / along);
  }
}

/**
 * The path a grenade thrown from `origin` at `velocity` will take until it
 * rests or the fuse runs out. Writes one xyz point per step into `points` and
 * returns how many. The last point is where it will go off.
 */
export function predictArc(origin: Vector3, velocity: Vector3, world: GrenadeWorld, points: Float32Array): number {
  const body = arcBody;
  body.position.copy(origin);
  body.velocity.copy(velocity);
  body.resting = false;
  const capacity = Math.min(GRENADE.maxArcPoints, Math.floor(points.length / 3));
  let count = 0;
  let time = 0;
  while (count < capacity) {
    points[count * 3] = body.position.x;
    points[count * 3 + 1] = body.position.y;
    points[count * 3 + 2] = body.position.z;
    count++;
    if (time >= GRENADE.fuse || body.resting) break;
    stepGrenade(body, world, GRENADE.step);
    time += GRENADE.step;
  }
  return count;
}

/** Damage at `distance` metres from the blast with nothing in the way. */
export function blastDamage(distance: number): number {
  const { maxDamage, lethalDamage, lethalRadius, blastRadius } = GRENADE;
  if (!(distance < blastRadius)) return 0;
  if (distance <= lethalRadius) {
    return maxDamage - (maxDamage - lethalDamage) * (Math.max(0, distance) / lethalRadius);
  }
  return (lethalDamage * (blastRadius - distance)) / (blastRadius - lethalRadius);
}

/** Damage to a body whose chest is at `chest`: by distance, and none at all behind solid cover. */
export function blastDamageAt(blast: Vector3, chest: Vector3, world: GrenadeWorld): number {
  from.copy(blast);
  from.y += BLAST_LIFT;
  const damage = blastDamage(from.distanceTo(chest));
  if (damage <= 0) return 0;
  return world.lineOfSight(from, chest) ? damage : 0;
}

/** Strength of the view shake, 0 - 1, for a blast `distance` metres from the eye. */
export function blastShake(distance: number): number {
  const reach = 1 - distance / GRENADE.shakeRadius;
  return reach <= 0 ? 0 : Math.min(1, reach * reach);
}
