import type { WeaponDef } from '../game/contracts';

/**
 * Seconds a soldier with a scoped rifle needs to bring the scope onto a target,
 * on top of its full reaction time, every time the target comes into view.
 */
export const SCOPE_IN_SECONDS = 0.35;

/**
 * Whether a soldier may fire after the target has been in its sights for
 * `sightedTime` seconds without a break. A scoped rifle (one hit kills) waits
 * the full reaction time plus the scope-in time each time the target shows,
 * not the shorter re-acquire time a known target needs for noticing, so a
 * player stepping out of cover gets a moment to act. Other weapons fire as
 * soon as the soldier has noticed.
 */
export function readyToFire(def: Pick<WeaponDef, 'scoped'>, sightedTime: number, reactionTime: number): boolean {
  return !def.scoped || sightedTime >= reactionTime + SCOPE_IN_SECONDS;
}

/**
 * Spread cone half-angle in degrees for a bot's shot. Inside `minRange` a
 * scoped rifle is fired without the scope, with the weapon's hip spread.
 */
export function botShotSpread(def: Pick<WeaponDef, 'scoped' | 'spreadAim' | 'spreadHip'>, aimSpread: number, distance: number, minRange: number): number {
  const weaponSpread = def.scoped && distance < minRange ? def.spreadHip : def.spreadAim;
  return Math.max(aimSpread, weaponSpread);
}
