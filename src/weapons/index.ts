import type { Ballistics, GameContext, PlayerWeapons } from '../game/contracts';
import { createBallisticsSystem } from './ballistics';
import { createPlayerWeaponSystem } from './player-weapons';
import { viewModelAssets } from './view/registry';

export type { PlayerWeaponSystem } from './player-weapons';
export type { DebugInput } from './intent';
/** Builds a weapon's model for anyone who needs one (bots carry them too). Falls back to a stand-in. */
export { buildGunModel } from './view/registry';

/** Asset ids the weapons need loaded before a match (models, textures). */
export function weaponAssets(): readonly string[] {
  return viewModelAssets();
}

/** Shared ballistics: spread, traces, damage and the events effects and audio listen for. */
export function createBallistics(ctx: GameContext): Ballistics {
  return createBallisticsSystem(ctx);
}

/** The local player's guns: handling, aiming, recoil, aim assist and the view model. */
export function createPlayerWeapons(ctx: GameContext): PlayerWeapons {
  return createPlayerWeaponSystem(ctx);
}

/** Thrown grenades: flight, bounces and the blast. `GRENADE_DEF` names the grenade wherever a weapon is named. */
export { createGrenades, GRENADE_DEF, GRENADE_ID } from './grenades';
