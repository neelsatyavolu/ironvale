import * as THREE from 'three/webgpu';
import type { GunModel } from '../../game/contracts';
import type { GunModule } from './api';
import { assembleGun } from './lib/guns-c-build';
import { M249_LAYOUT } from './lib/guns-c-layout';
import { tunedFinish, type FinishTweak } from './lib/guns-c-materials';

/**
 * M249 light machine gun (short-barrel Minimi Para pattern with a skeleton
 * stock, 100-round belt box and iron sights). Model: "LMG" by DJMaesen,
 * CC BY 4.0, processed by scripts/process-gun-m249.mjs. 1.02 m long; the grip
 * centre is the origin.
 *
 * Moving parts, each resting at the identity under a holder at its pivot:
 * bolt and cocking handle (slide back along +Z by `cycleTravel`), belt box with
 * its belt (`magazine`, drop along -Y), trigger (hinged at its pin, about X)
 * and the feed cover with the rear sight on it (`cover`, hinged at its front
 * edge: turn it about its own +X to open, about 1.1 rad for fully open).
 */
const FINISH: FinishTweak = {
  tint: 0xffffff,
  metalLift: 0.05,
  polymerLift: 0.012,
  roughness: 0.9,
  roughnessBias: 0.2,
  scratchGloss: 0.25,
  minRoughness: 0.22,
  maxRoughness: 0.95,
  metalness: 1,
  wear: 0.3,
  noiseScale: 55,
  rub: 0.25,
  normalScale: 1,
};

/**
 * The view model opens a feed cover by turning it about its own +X, which
 * lifts whatever is ahead of the hinge. This cover hinges at its front edge
 * and reaches back, so the animated node is turned half way round about Y
 * (its +X is then the gun's -X) and the mesh under it is turned back.
 */
function hingeCover(model: GunModel): GunModel {
  const mesh = model.parts.cover;
  const rest = mesh?.parent;
  if (!mesh || !rest) return model;
  const hinge = new THREE.Group();
  hinge.name = 'cover_hinge';
  hinge.rotation.y = Math.PI;
  mesh.rotation.y = Math.PI;
  rest.add(hinge);
  hinge.add(mesh);
  return { ...model, parts: { ...model.parts, cover: hinge } };
}

const gun: GunModule = {
  weaponId: 'm249',
  assets: [M249_LAYOUT.asset],
  build(assets) {
    return hingeCover(assembleGun(assets.model(M249_LAYOUT.asset), M249_LAYOUT, (source) => tunedFinish(source, FINISH)));
  },
};

export default gun;
