// gun-export (PLAN.md 3.5): builds each GunModule in Chrome, procedural parts included, and writes
// the finished GunModel scene graph for asset-bake, plus a JSON naming the anchor nodes. The page
// writes glTF JSON with embedded data URIs (GLTFExporter's binary mode appends images in promise
// completion order, so its bytes vary run to run); run.mjs packs it into a GLB with gltf-transform.
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { Object3D } from 'three/webgpu';
import type { Assets } from '../../../../src/core/assets';
import { WEAPON_IDS, type WeaponId } from '../../../../src/weapons/models/api';
import { buildGunModel, viewModelAssets } from '../../../../src/weapons/view/registry';
import { json, writeFile } from './io';

export const GUN_IDS: readonly WeaponId[] = WEAPON_IDS;

/** Gives an anchor a stable, unique name so it survives GLB export and can be found again. */
function label(node: Object3D | undefined, role: string): string | null {
  if (!node) return null;
  if (!node.name) node.name = `anchor.${role}`;
  return node.name;
}

export async function exportGun(id: WeaponId, assets: Assets, dir: string): Promise<{ nodes: number }> {
  await assets.preload(viewModelAssets());
  const model = buildGunModel(id, assets);
  const anchors = {
    muzzle: label(model.muzzle, 'muzzle'),
    ejection: label(model.ejection, 'ejection'),
    sight: label(model.sight, 'sight'),
    gripTrigger: label(model.grips.trigger, 'grip.trigger'),
    gripSupport: label(model.grips.support, 'grip.support'),
    bolt: label(model.parts.bolt, 'bolt'),
    slide: label(model.parts.slide, 'slide'),
    magazine: label(model.parts.magazine, 'magazine'),
    trigger: label(model.parts.trigger, 'trigger'),
    chargingHandle: label(model.parts.chargingHandle, 'chargingHandle'),
    cover: label(model.parts.cover, 'cover'),
  };
  model.root.updateMatrixWorld(true);
  const gltf = (await new GLTFExporter().parseAsync(model.root as never, { binary: false, onlyVisible: false })) as { nodes?: unknown[] };
  await writeFile(`${dir}/${id}.gltf`, JSON.stringify(gltf));
  await writeFile(`${dir}/${id}.json`, json({ id, cycleTravel: model.cycleTravel, anchors }));
  return { nodes: gltf.nodes?.length ?? 0 };
}
