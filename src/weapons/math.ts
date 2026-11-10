import { Vector3 } from 'three/webgpu';
import type { HitZone, WeaponDef } from '../game/contracts';

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

type FalloffFields = Pick<WeaponDef, 'falloffStart' | 'falloffEnd' | 'falloffMin'>;

/** Damage multiplier at a distance: 1 up to `falloffStart`, linear down to `falloffMin` at `falloffEnd`. */
export function damageFalloff(def: FalloffFields, distance: number): number {
  if (distance <= def.falloffStart) return 1;
  if (distance >= def.falloffEnd) return def.falloffMin;
  const t = (distance - def.falloffStart) / (def.falloffEnd - def.falloffStart);
  return 1 + (def.falloffMin - 1) * t;
}

export function zoneMultiplier(def: Pick<WeaponDef, 'headshotMultiplier' | 'limbMultiplier'>, zone: HitZone): number {
  if (zone === 'head') return def.headshotMultiplier;
  if (zone === 'limb') return def.limbMultiplier;
  return 1;
}

/** Damage one projectile does to a zone at a distance. */
export function damageAt(def: WeaponDef, distance: number, zone: HitZone): number {
  return def.damage * damageFalloff(def, distance) * zoneMultiplier(def, zone);
}

/** Seconds between shots at the weapon's rate of fire. */
export function shotInterval(def: Pick<WeaponDef, 'roundsPerMinute'>): number {
  return 60 / Math.max(1, def.roundsPerMinute);
}

const tangent = new Vector3();
const bitangent = new Vector3();

/**
 * Random unit direction inside a cone around `axis` (unit length), uniform over
 * the cone's cross-section. `random` returns values in [0, 1).
 */
export function sampleCone(axis: Vector3, halfAngleDegrees: number, random: () => number, out: Vector3): Vector3 {
  if (halfAngleDegrees <= 0) return out.copy(axis);
  const angle = halfAngleDegrees * DEG * Math.sqrt(random());
  const around = random() * TWO_PI;
  // Any vector not parallel to the axis gives a stable tangent frame.
  if (Math.abs(axis.y) < 0.99) tangent.set(0, 1, 0);
  else tangent.set(1, 0, 0);
  tangent.cross(axis).normalize();
  bitangent.crossVectors(axis, tangent);
  const side = Math.sin(angle);
  return out
    .copy(axis)
    .multiplyScalar(Math.cos(angle))
    .addScaledVector(tangent, side * Math.cos(around))
    .addScaledVector(bitangent, side * Math.sin(around))
    .normalize();
}

/** Nearest point to `p` on the segment a-b, written into `out`. */
export function closestPointOnSegment(a: Vector3, b: Vector3, p: Vector3, out: Vector3): Vector3 {
  out.subVectors(b, a);
  const lengthSq = out.lengthSq();
  if (lengthSq < 1e-12) return out.copy(a);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * out.x + (p.y - a.y) * out.y + (p.z - a.z) * out.z) / lengthSq));
  return out.multiplyScalar(t).add(a);
}
