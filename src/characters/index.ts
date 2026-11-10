import type { Assets } from '../core/assets';
import type { SoldierVisual, Team } from '../game/contracts';
import { CARBINE_ASSET, SOLDIER_ASSET, soldierRig } from './rig';
import { Soldier } from './soldier';

/** Asset ids the soldier needs loaded before `createSoldier`. */
export function soldierAssets(): readonly string[] {
  return [SOLDIER_ASSET, CARBINE_ASSET];
}

/**
 * A soldier body for a bot or the other player. Feet at the root's origin,
 * facing the root's -Z. Geometry, textures and clip data are shared between
 * soldiers; each one costs two draw calls (body and rifle).
 */
export function createSoldier(assets: Assets, team: Team): SoldierVisual {
  return new Soldier(soldierRig(assets), team);
}
