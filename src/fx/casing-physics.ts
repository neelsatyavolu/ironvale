import { Vector3 } from 'three/webgpu';
import type { RayHit, Surface } from '../world/types';

export interface CasingTuning {
  /** m/s^2, downwards. */
  readonly gravity: number;
  /** Fraction of the speed into the surface that comes back out. */
  readonly restitution: number;
  /** Fraction of the speed along the surface lost on each contact. */
  readonly friction: number;
  /** Rebounds off the ground before the casing stays down. */
  readonly maxBounces: number;
  /** A rebound slower than this (m/s) is not worth simulating; the casing rests. */
  readonly restSpeed: number;
}

export const CASING_TUNING: CasingTuning = {
  gravity: 9.81,
  restitution: 0.38,
  friction: 0.45,
  maxBounces: 2,
  restSpeed: 0.55,
};

/** Surfaces at least this upright count as ground. */
const GROUND_NORMAL_Y = 0.5;

/** Simulation state for one casing. Mutated in place every frame. */
export interface CasingBody {
  readonly position: Vector3;
  readonly velocity: Vector3;
  /** Rebounds off the ground so far. */
  bounces: number;
  /** true after the first ground contact. */
  landed: boolean;
  resting: boolean;
  /** Surface of the last contact. */
  surface: Surface | null;
}

/**
 * What happened during a step: still in the air, rebounded off something,
 * touched the ground for the first time, came to rest on a later contact, or
 * was already at rest.
 */
export type CasingStep = 'flying' | 'bounced' | 'landed' | 'rested' | 'resting';

/** Ray query against the level. `direction` is unit length. */
export type GroundProbe = (origin: Vector3, direction: Vector3, maxDistance: number) => RayHit | null;

const direction = new Vector3();

export function createCasingBody(): CasingBody {
  return { position: new Vector3(), velocity: new Vector3(), bounces: 0, landed: false, resting: false, surface: null };
}

/**
 * Bounce a velocity off a surface: the part going into the surface is reversed
 * and scaled by `restitution`, the part along it loses `friction`. A velocity
 * already leaving the surface is returned unchanged.
 */
export function reflectVelocity(
  velocity: Vector3,
  normal: Vector3,
  restitution: number,
  friction: number,
  out: Vector3,
): Vector3 {
  const into = velocity.dot(normal);
  if (into >= 0) return out.copy(velocity);
  const keep = 1 - friction;
  // tangent * keep + normal * (-into * restitution), with tangent = velocity - normal * into
  return out.copy(velocity).multiplyScalar(keep).addScaledVector(normal, -into * (keep + restitution));
}

/**
 * Advance one casing by `dt`. Sweeps a ray along the frame's motion so a fast
 * casing cannot pass through thin floors.
 */
export function stepCasing(
  body: CasingBody,
  dt: number,
  probe: GroundProbe,
  radius: number,
  tuning: CasingTuning,
): CasingStep {
  if (body.resting) return 'resting';
  body.velocity.y -= tuning.gravity * dt;
  const speed = body.velocity.length();
  const travel = speed * dt;
  if (travel < 1e-6) return 'flying';

  direction.copy(body.velocity).divideScalar(speed);
  const hit = probe(body.position, direction, travel + radius);
  if (!hit) {
    body.position.addScaledVector(body.velocity, dt);
    return 'flying';
  }

  body.position.copy(hit.point).addScaledVector(hit.normal, radius);
  body.surface = hit.surface;
  reflectVelocity(body.velocity, hit.normal, tuning.restitution, tuning.friction, body.velocity);
  if (hit.normal.y < GROUND_NORMAL_Y) return 'bounced';

  const firstContact = !body.landed;
  body.landed = true;
  const rebound = body.velocity.dot(hit.normal);
  if (body.bounces >= tuning.maxBounces || rebound < tuning.restSpeed) {
    body.resting = true;
    body.velocity.set(0, 0, 0);
    return firstContact ? 'landed' : 'rested';
  }
  body.bounces++;
  return firstContact ? 'landed' : 'bounced';
}
