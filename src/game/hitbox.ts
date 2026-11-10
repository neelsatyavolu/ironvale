import { Vector3 } from 'three/webgpu';
import type { CombatantHit, HitZone } from './contracts';

interface Volume {
  readonly zone: HitZone;
  /** Segment end points as heights above the feet. */
  readonly bottom: number;
  readonly top: number;
  readonly radius: number;
}

const STANDING: readonly Volume[] = [
  { zone: 'head', bottom: 1.6, top: 1.68, radius: 0.125 },
  { zone: 'torso', bottom: 0.98, top: 1.42, radius: 0.24 },
  { zone: 'limb', bottom: 0.14, top: 0.9, radius: 0.2 },
];

const CROUCHING: readonly Volume[] = [
  { zone: 'head', bottom: 1.04, top: 1.12, radius: 0.125 },
  { zone: 'torso', bottom: 0.56, top: 0.9, radius: 0.25 },
  { zone: 'limb', bottom: 0.14, top: 0.46, radius: 0.24 },
];

const offset = new Vector3();

/**
 * Ray against a three-capsule humanoid (head, torso, legs) standing at `feet`.
 * Shared by the player, bots and remote players so everyone is hit the same way.
 */
export function hitTestHumanoid(
  feet: Vector3,
  crouching: boolean,
  origin: Vector3,
  direction: Vector3,
  maxDistance: number,
): CombatantHit | null {
  // Volumes overlap at the neck and hips. They are listed head, torso, legs, and
  // the first one the ray touches wins, so a ray through the head is a headshot
  // even though the wider torso capsule is entered slightly earlier.
  for (const volume of crouching ? CROUCHING : STANDING) {
    const distance = rayVerticalCapsule(feet, volume, origin, direction);
    if (distance === null || distance > maxDistance) continue;
    return {
      distance,
      zone: volume.zone,
      point: origin.clone().addScaledVector(direction, distance),
    };
  }
  return null;
}

/** Distance along the ray to an upright capsule, or null on a miss. */
function rayVerticalCapsule(feet: Vector3, volume: Volume, origin: Vector3, direction: Vector3): number | null {
  const r2 = volume.radius * volume.radius;
  let nearest: number | null = null;

  // Infinite vertical cylinder, then clamp to the segment.
  const ox = origin.x - feet.x;
  const oz = origin.z - feet.z;
  const a = direction.x * direction.x + direction.z * direction.z;
  const c = ox * ox + oz * oz - r2;
  const startY = origin.y - feet.y;
  // A ray that starts inside the volume (an enemy pressed against the muzzle) hits at once.
  if (c < 0 && startY >= volume.bottom && startY <= volume.top) return 0;
  if (a > 1e-9) {
    const b = ox * direction.x + oz * direction.z;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      const y = origin.y + direction.y * t - feet.y;
      if (t >= 0 && y >= volume.bottom && y <= volume.top) nearest = t;
    }
  }

  for (const height of [volume.bottom, volume.top]) {
    offset.set(ox, origin.y - (feet.y + height), oz);
    const b = offset.dot(direction);
    const c = offset.lengthSq() - r2;
    if (c < 0) return 0;
    const disc = b * b - c;
    if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t >= 0 && (nearest === null || t < nearest)) nearest = t;
  }
  return nearest;
}
