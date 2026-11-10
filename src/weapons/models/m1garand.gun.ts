/**
 * M1 Garand. Mesh: "M1 Garand ( US Rifle, Caliber .30, M1)" by Sky_Hunter,
 * CC BY 4.0, processed by scripts/process-gun-m1garand.mjs. All measurements
 * below are in the processed file's space (metres, barrel -Z, origin at the
 * wrist of the stock).
 */
import * as THREE from 'three/webgpu';
import type { GunModule } from './api';
import { buildRifle, type RifleSpec } from './lib/guns-b-rig';
import { gunMaterials } from './materials';

/** Centre of the rear aperture (middle of its disc) and top of the front blade. */
export const GARAND_SIGHTS = {
  rear: [-0.0001, 0.09765, -0.1165],
  front: [-0.0002, 0.0966, -0.8285],
} as const;

/**
 * The stock is a one-sided shell, so with the bolt back the inside of the walnut shows through the
 * open action. A parkerized box lines the magazine well, standing in for the receiver's innards;
 * the clip sits inside it with its top round showing.
 */
const WELL_LINER = { size: [0.041, 0.0365, 0.116], at: [-0.001, 0.0348, -0.188] } as const;
let wellLiner: THREE.BufferGeometry | null = null;

function addWellLiner(mesh: THREE.Object3D): void {
  wellLiner ??= new THREE.BoxGeometry(...WELL_LINER.size);
  const liner = new THREE.Mesh(wellLiner, gunMaterials.parkerized());
  liner.name = 'well-liner';
  liner.position.set(...WELL_LINER.at);
  mesh.add(liner);
}

const SPEC: RifleSpec = {
  weaponId: 'm1garand',
  assetId: 'mdl-gun-m1garand',
  sightLine: () => ({
    rear: new THREE.Vector3(...GARAND_SIGHTS.rear),
    front: new THREE.Vector3(...GARAND_SIGHTS.front),
  }),
  eyeRelief: 0.26,
  muzzle: [0, 0.0678, -0.86],
  ejection: { at: [0.012, 0.079, -0.195], toward: [0.72, 0.6, -0.35] },
  // Right hand around the wrist of the stock, palm on its right side, fingers raked down with the wrist.
  triggerGrip: { at: [0.017, -0.004, 0.004], fingers: [0, -0.5, -1], thumb: [0, 1, 0] },
  // Left hand cupping the stock from below, ahead of the receiver: fingers across to the right side, thumb along the left.
  // The palm sits a little under the wood and the fingers run level, so the curled fingertips stop on the side of
  // the stock: the line of sight clears the handguard by only a centimetre.
  supportGrip: { at: [-0.011, 0.012, -0.42], fingers: [1, 0.05, -0.15], thumb: [-0.15, 0.2, -1] },
  // The en-bloc clip sits in a flipped parent frame, so the usual magazine-out motion lifts it out of the top.
  parts: { bolt: 'bolt', magazine: 'clip', trigger: 'trigger' },
  // Operating rod stroke. The bolt rides back under the rear sight bridge.
  cycleTravel: 0.078,
  dress: addWellLiner,
};

const garand: GunModule = {
  weaponId: 'm1garand',
  assets: [SPEC.assetId],
  build: (assets) => buildRifle(assets, SPEC),
};

export default garand;
