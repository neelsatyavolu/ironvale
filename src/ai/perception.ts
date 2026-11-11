/**
 * What a soldier can see and hear, as pure functions and a small reaction
 * timer. Line-of-sight raycasts are done by the caller only after these cheap
 * tests pass.
 */

const DEG = Math.PI / 180;

export const VISION = {
  /** Half of the roughly 110 degree field a relaxed soldier watches. */
  halfAngleCalm: 55 * DEG,
  /** An alerted soldier scans harder and catches more at the edges. */
  halfAngleAlert: 80 * DEG,
  /** Anyone this close is noticed whichever way the soldier faces. */
  proximity: 2.2,
  /**
   * Sight range in fog is this divided by the fog density. Set from what the
   * player can make out on screen: in thick mist (density 0.0215) a soldier is a
   * faint shape at 35 m and gone by 45 to 55 m, so sight there stops near 42 m.
   */
  fogVisibility: 0.9,
  crouchFactor: 0.75,
  stillFactor: 0.85,
  sprintFactor: 1.15,
  stillSpeed: 0.5,
  sprintSpeed: 5.5,
} as const;

/** Sight range against one target: cut by fog, by the target crouching and by it standing still. */
export function effectiveVisionRange(base: number, fogDensity: number, targetCrouching: boolean, targetSpeed: number): number {
  let range = Math.min(base, VISION.fogVisibility / Math.max(fogDensity, 1e-4));
  if (targetCrouching) range *= VISION.crouchFactor;
  if (targetSpeed < VISION.stillSpeed) range *= VISION.stillFactor;
  else if (targetSpeed > VISION.sprintSpeed) range *= VISION.sprintFactor;
  return range;
}

/** true when the target point is within `range` and inside the cone around the soldier's facing (yaw 0 looks down -Z). */
export function inVisionCone(
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  yaw: number,
  targetX: number,
  targetY: number,
  targetZ: number,
  halfAngle: number,
  range: number,
): boolean {
  const dx = targetX - eyeX;
  const dy = targetY - eyeY;
  const dz = targetZ - eyeZ;
  const distanceSq = dx * dx + dy * dy + dz * dz;
  if (distanceSq > range * range) return false;
  if (distanceSq < 1e-6) return true;
  const along = -Math.sin(yaw) * dx - Math.cos(yaw) * dz;
  return along >= Math.cos(halfAngle) * Math.sqrt(distanceSq);
}

export type NoiseKind = 'shot' | 'footstep' | 'impact' | 'nearMiss';

const SHOT_RADIUS = 85;
const FOOTSTEP_RADIUS = 16;
const IMPACT_RADIUS = 6;
const NEAR_MISS_RADIUS = 1.8;

/** How far a noise carries. `loudness` is the weapon's, `scale` the listener's hearing. */
export function hearingRadius(kind: NoiseKind, loudness: number, scale: number): number {
  switch (kind) {
    case 'shot':
      return SHOT_RADIUS * loudness * scale;
    case 'footstep':
      return FOOTSTEP_RADIUS * scale;
    case 'impact':
      return IMPACT_RADIUS * scale;
    case 'nearMiss':
      return NEAR_MISS_RADIUS;
  }
}

/** Share of the reaction time needed to pick a known target back up. */
const REACQUIRE_FRACTION = 0.4;
/** A glimpse fades at this fraction of real time, so repeated peeks add up. */
const GLIMPSE_DECAY = 0.5;

/**
 * Reaction delay and memory for one soldier. Feed it whether the target is
 * in view each time the soldier senses; it answers when the soldier has
 * noticed (`alerted`) and when it may open fire (`canEngage`).
 */
export class Awareness {
  /** Seconds of the target in view, fading while it is hidden. */
  visibleTime = 0;
  /** true once the target has been noticed, until memory runs out. */
  alerted = false;
  visible = false;
  /** Seconds since the target was last seen (or the soldier was last told about it). */
  sinceSeen = Infinity;
  private threshold = Infinity;

  update(dt: number, visible: boolean, reactionTime: number, memorySeconds: number): void {
    this.visible = visible;
    this.threshold = this.alerted ? reactionTime * REACQUIRE_FRACTION : reactionTime;
    if (visible) {
      this.visibleTime = Math.min(reactionTime, this.visibleTime + dt);
      if (this.visibleTime >= this.threshold - 1e-9) {
        this.alerted = true;
        this.sinceSeen = 0;
      }
      return;
    }
    this.visibleTime = Math.max(0, this.visibleTime - dt * GLIMPSE_DECAY);
    this.sinceSeen += dt;
    if (this.alerted && this.sinceSeen > memorySeconds) this.forget();
  }

  /** The target is in view and the reaction delay has passed. */
  get canEngage(): boolean {
    return this.alerted && this.visible && this.visibleTime >= this.threshold - 1e-9;
  }

  /** Something else gave the target away: a hit, a near miss, a squad mate's shout. */
  alert(): void {
    this.alerted = true;
    this.sinceSeen = 0;
  }

  forget(): void {
    this.alerted = false;
    this.visible = false;
    this.visibleTime = 0;
    this.sinceSeen = Infinity;
  }
}
