import type { Assets } from '../../core/assets';
import type { ArmsRig, GunModel } from '../../game/contracts';

/** Weapon ids, in loadout slot order (slot 1 first). */
export const WEAPON_IDS = ['m4a1', 'mp5', 'm24', 'm249'] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];

/**
 * What every `src/weapons/models/<id>.gun.ts` default-exports. The weapon
 * system discovers these files with `import.meta.glob`, so adding a file is
 * all it takes to give a weapon its model.
 */
export interface GunModule {
  readonly weaponId: WeaponId;
  /** Asset ids (textures, glTF) to preload before `build`. */
  readonly assets?: readonly string[];
  /** Build a fresh model. Called once for the player and once per bot that carries it. */
  build(assets: Assets): GunModel;
}

/** What `src/weapons/models/arms.ts` exports as `buildArms`. */
export type BuildArms = (assets: Assets) => ArmsRig;
