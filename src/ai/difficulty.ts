import type { Difficulty } from '../core/settings';
import type { WeaponDef } from '../game/contracts';

/** Everything that changes with the difficulty setting, in one place. */
export interface DifficultyProfile {
  /** Seconds a target must stay in view before the soldier reacts. */
  readonly reactionTime: number;
  /** Radius in metres of the circle shots land in at 20 m once the aim has settled. */
  readonly aimErrorAt20m: number;
  /** How many times wider the first shots at a new target are. */
  readonly firstShotPenalty: number;
  /** How fast the aim settles while tracking, per second. */
  readonly aimTightenRate: number;
  /** Seconds the aim trails a moving target. */
  readonly trackingLag: number;
  /** Multiplier on a role's burst length. */
  readonly burstLength: number;
  /** Multiplier on the pause between bursts. */
  readonly burstPause: number;
  readonly damageMultiplier: number;
  /** Soldiers allowed to fire at the same time; the others wait their turn in cover. */
  readonly attackers: number;
  /** Out of 100. */
  readonly health: number;
  /** Metres, before fog and the target's stance. */
  readonly visionRange: number;
  /** Chance a rifleman goes round the side when the front is already held. */
  readonly flankChance: number;
  /** Share of the squad allowed to advance at the same time. */
  readonly pushFraction: number;
  /** Chance of taking cover when cover is near. */
  readonly coverUse: number;
  /** Degrees per second. */
  readonly turnRate: number;
  /** Seconds a last known position is remembered. */
  readonly memorySeconds: number;
  /** Multiplier on how far noises are heard. */
  readonly hearingScale: number;
  /** Seconds without contact before the squad starts sweeping toward the player. */
  readonly sweepDelay: number;
}

export const DIFFICULTY_ORDER: readonly Difficulty[] = ['recruit', 'regular', 'veteran', 'elite'];

/**
 * Recruit is meant for a first game on a trackpad: slow to notice, wide of the
 * mark, soft-hitting, and only two soldiers fire at a time. Elite notices in
 * a quarter of a second and lands most rounds on anyone standing in the open.
 */
export const DIFFICULTY: Readonly<Record<Difficulty, DifficultyProfile>> = {
  recruit: {
    reactionTime: 0.9,
    aimErrorAt20m: 1.3,
    firstShotPenalty: 2.6,
    aimTightenRate: 0.6,
    trackingLag: 0.16,
    burstLength: 0.7,
    burstPause: 1.7,
    damageMultiplier: 0.45,
    attackers: 2,
    health: 70,
    visionRange: 45,
    flankChance: 0.1,
    pushFraction: 0.2,
    coverUse: 0.45,
    turnRate: 150,
    memorySeconds: 6,
    hearingScale: 0.7,
    sweepDelay: 16,
  },
  regular: {
    reactionTime: 0.6,
    aimErrorAt20m: 0.85,
    firstShotPenalty: 2.2,
    aimTightenRate: 1,
    trackingLag: 0.11,
    burstLength: 0.85,
    burstPause: 1.25,
    damageMultiplier: 0.6,
    attackers: 3,
    health: 85,
    visionRange: 60,
    flankChance: 0.25,
    pushFraction: 0.3,
    coverUse: 0.65,
    turnRate: 200,
    memorySeconds: 9,
    hearingScale: 0.9,
    sweepDelay: 10,
  },
  veteran: {
    reactionTime: 0.42,
    aimErrorAt20m: 0.72,
    firstShotPenalty: 1.8,
    aimTightenRate: 1.6,
    trackingLag: 0.07,
    burstLength: 1,
    burstPause: 1,
    damageMultiplier: 0.75,
    attackers: 4,
    health: 100,
    visionRange: 75,
    flankChance: 0.45,
    pushFraction: 0.4,
    coverUse: 0.85,
    turnRate: 260,
    memorySeconds: 12,
    hearingScale: 1,
    sweepDelay: 7,
  },
  elite: {
    reactionTime: 0.25,
    aimErrorAt20m: 0.45,
    firstShotPenalty: 1.5,
    aimTightenRate: 2.6,
    trackingLag: 0.04,
    burstLength: 1.15,
    burstPause: 0.8,
    damageMultiplier: 1,
    attackers: 8,
    health: 100,
    visionRange: 90,
    flankChance: 0.65,
    pushFraction: 0.5,
    coverUse: 0.95,
    turnRate: 330,
    memorySeconds: 16,
    hearingScale: 1.15,
    sweepDelay: 4,
  },
};

/** Which way each parameter moves as the game gets harder. Checked by the tests. */
export const DIFFICULTY_TREND: Readonly<Record<keyof DifficultyProfile, 'rises' | 'falls'>> = {
  reactionTime: 'falls',
  aimErrorAt20m: 'falls',
  firstShotPenalty: 'falls',
  aimTightenRate: 'rises',
  trackingLag: 'falls',
  burstLength: 'rises',
  burstPause: 'falls',
  damageMultiplier: 'rises',
  attackers: 'rises',
  health: 'rises',
  visionRange: 'rises',
  flankChance: 'rises',
  pushFraction: 'rises',
  coverUse: 'rises',
  turnRate: 'rises',
  memorySeconds: 'rises',
  hearingScale: 'rises',
  sweepDelay: 'falls',
};

const scaled = new Map<string, WeaponDef>();

/**
 * The weapon as a bot of this difficulty carries it: a copy with scaled damage, cached.
 * Snipers are left alone so a hit kills on every difficulty.
 */
export function scaledWeapon(def: WeaponDef, difficulty: Difficulty): WeaponDef {
  if (def.weaponClass === 'sniper') return def;
  const key = `${def.id}:${difficulty}`;
  const cached = scaled.get(key);
  if (cached) return cached;
  const copy: WeaponDef = { ...def, damage: def.damage * DIFFICULTY[difficulty].damageMultiplier };
  scaled.set(key, copy);
  return copy;
}
