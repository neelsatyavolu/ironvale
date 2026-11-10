/**
 * M24 sniper rifle. Mesh: "R700V2" by Domevans, CC BY 4.0 (a Remington 700 in
 * the M24 configuration: heavy barrel, olive stock, rail and scope), processed
 * by scripts/process-gun-m24.mjs. The detachable magazine (M24A2 pattern) is
 * built in code. Measurements are in the processed file's space (metres,
 * barrel -Z, bore on x = 0, origin at the wrist of the stock).
 */
import * as THREE from 'three/webgpu';
import type { GunModule } from './api';
import { addMagazine, type MagazineSpec } from './lib/guns-b-magazine';
import { buildRifle, originIn, type RifleSpec } from './lib/guns-b-rig';
import { lensMaterial } from './materials';

/** Bore axis height above the origin, and the crown's distance down the barrel. */
export const M24_BORE = { y: 0.057, muzzleZ: -0.781 } as const;

const MAGAZINE: MagazineSpec = { top: [0, 0.022, -0.116], length: 0.066, width: 0.025, height: 0.056, stockBottom: 0.0065 };

let lenses: { readonly ocular: THREE.Material; readonly objective: THREE.Material } | null = null;

/** One pair of lens materials for every copy of the gun. */
function lensMaterials(): { readonly ocular: THREE.Material; readonly objective: THREE.Material } {
  if (lenses) return lenses;
  // The eyepiece is close to opaque so the shooter does not look down a hollow tube.
  const ocular = lensMaterial(0x0b1016);
  ocular.opacity = 0.96;
  ocular.name = 'lens-ocular';
  const objective = lensMaterial(0x2a3f55);
  objective.opacity = 0.8;
  objective.name = 'lens-objective';
  lenses = { ocular, objective };
  return lenses;
}

function setMaterial(mesh: THREE.Object3D, name: string, material: THREE.Material): void {
  const node = mesh.getObjectByName(name);
  if (node instanceof THREE.Mesh) node.material = material;
}

const SPEC: RifleSpec = {
  weaponId: 'm24',
  assetId: 'mdl-gun-m24',
  // The line of sight is the scope's optical axis, through the centres of both lenses.
  sightLine: (mesh) => ({ rear: originIn(mesh, 'lens_ocular'), front: originIn(mesh, 'lens_objective') }),
  eyeRelief: 0.09,
  muzzle: [0, M24_BORE.y, M24_BORE.muzzleZ],
  // Port on the right of the receiver, between the scope rings; cases leave up, out and a little back.
  ejection: { at: [0.012, 0.064, -0.13], toward: [0.75, 0.62, 0.2] },
  // Right hand around the wrist of the stock, palm on its right side, fingers raked down with the wrist.
  triggerGrip: { at: [0.02, -0.006, 0.012], fingers: [0, -0.5, -1], thumb: [0, 1, 0] },
  // Left hand cupping the fore-end from below, ahead of the magazine. Palm a little under the stock so the
  // curled fingertips stay on its side, below the scope.
  supportGrip: { at: [-0.009, 0.006, -0.3], fingers: [1, 0.05, -0.15], thumb: [-0.15, 0.2, -1] },
  parts: { bolt: 'bolt', magazine: 'magazine', trigger: 'trigger' },
  // Short-action bolt throw.
  cycleTravel: 0.09,
  dress(mesh) {
    const { ocular, objective } = lensMaterials();
    setMaterial(mesh, 'lens_ocular', ocular);
    setMaterial(mesh, 'lens_objective', objective);
    addMagazine(mesh, MAGAZINE);
  },
};

const m24: GunModule = {
  weaponId: 'm24',
  assets: [SPEC.assetId],
  build: (assets) => buildRifle(assets, SPEC),
};

export default m24;
