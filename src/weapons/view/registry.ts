import type { Assets } from '../../core/assets';
import type { ArmsRig, GunModel } from '../../game/contracts';
import { WEAPON_IDS, type BuildArms, type GunModule, type WeaponId } from '../models/api';
import { buildFallbackGun } from './fallback';

/**
 * Finds the gun modules and the first-person arms that other files provide.
 * Anything missing or broken is replaced or skipped, never fatal: a weapon
 * without a model gets the primitive stand-in, and no arms means no arms.
 */
const gunFiles = import.meta.glob<{ default?: GunModule }>('../models/*.gun.ts', { eager: true });
const armsFiles = import.meta.glob<{ buildArms?: BuildArms; ARMS_ASSETS?: readonly string[]; assets?: readonly string[] }>(
  '../models/arms.ts',
  { eager: true },
);
const manifests = import.meta.glob<{ assets?: readonly { id: string }[] }>('../../../assets/*.json', {
  eager: true,
  import: 'default',
});

const knownAssets = new Set(Object.values(manifests).flatMap((file) => (file.assets ?? []).map((entry) => entry.id)));

const gunModules = new Map<WeaponId, GunModule>();
for (const [path, file] of Object.entries(gunFiles)) {
  const module = file.default;
  if (!module || !WEAPON_IDS.includes(module.weaponId) || typeof module.build !== 'function') {
    console.warn(`Ignoring ${path}: it does not default-export a GunModule`);
    continue;
  }
  gunModules.set(module.weaponId, module);
}

const armsFile = Object.values(armsFiles)[0];

function usable(ids: readonly string[] | undefined): boolean {
  return (ids ?? []).every((id) => knownAssets.has(id));
}

function armsAssetIds(): readonly string[] {
  return armsFile?.ARMS_ASSETS ?? armsFile?.assets ?? [];
}

/** true when there is an arms module and everything it needs is in a manifest. */
function armsReady(): boolean {
  return typeof armsFile?.buildArms === 'function' && usable(armsAssetIds());
}

/** Asset ids to preload for every gun module and the arms. Ids missing from the manifests are left out. */
export function viewModelAssets(): readonly string[] {
  const ids: string[] = [];
  for (const module of gunModules.values()) {
    if (usable(module.assets)) ids.push(...(module.assets ?? []));
    else console.warn(`Gun model "${module.weaponId}" lists assets that are in no manifest; using the stand-in`);
  }
  if (armsReady()) ids.push(...armsAssetIds());
  return ids;
}

function complete(model: GunModel): boolean {
  return Boolean(model.root && model.muzzle && model.ejection && model.sight && model.grips?.trigger && model.grips.support);
}

/** The weapon's model from its module, or the stand-in when there is none or it fails. */
export function buildGunModel(id: WeaponId, assets: Assets): GunModel {
  const module = gunModules.get(id);
  if (module && usable(module.assets)) {
    try {
      const model = module.build(assets);
      if (complete(model)) return model;
      console.warn(`Gun model "${id}" is missing anchors; using the stand-in`);
    } catch (error) {
      console.warn(`Gun model "${id}" failed to build; using the stand-in`, error);
    }
  }
  return buildFallbackGun(id);
}

/** First-person arms, or null when `models/arms.ts` is absent or fails. */
export function buildArmsRig(assets: Assets): ArmsRig | null {
  const build = armsFile?.buildArms;
  if (typeof build !== 'function' || !armsReady()) return null;
  try {
    return build(assets);
  } catch (error) {
    console.warn('First-person arms failed to build; continuing without them', error);
    return null;
  }
}
