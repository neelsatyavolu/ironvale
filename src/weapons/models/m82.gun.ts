import type { GunModule } from './api';
import { assembleGun } from './lib/guns-c-build';
import { M82_LAYOUT } from './lib/guns-c-layout';
import { tunedFinish, type FinishTweak } from './lib/guns-c-materials';

/**
 * Barrett M82A1 anti-materiel rifle (12.7 x 99 mm) with its arrowhead muzzle
 * brake and a variable-power scope on two rings. Model: "Barrett M82 .50 BMG
 * sniper rifle." by aid2901, CC BY 4.0, processed by scripts/process-gun-m82.mjs
 * (carry case and loose cartridges removed, occlusion maps dropped). 1.448 m
 * long; the grip centre is the origin.
 *
 * Moving parts, each resting at the identity under a holder at its pivot: the
 * bolt carrier with the charging handle on its right, which is the bolt part
 * (slides back along +Z by `cycleTravel`), magazine (drop along -Y) and
 * trigger (hinged at its pin, about X).
 */
const FINISH: FinishTweak = {
  tint: 0xffffff,
  metalLift: 0.02,
  polymerLift: 0.012,
  roughness: 0.8,
  roughnessBias: 0.08,
  scratchGloss: 0.3,
  minRoughness: 0.35,
  maxRoughness: 0.95,
  metalness: 1,
  wear: 0.2,
  noiseScale: 60,
  rub: 0.1,
  normalScale: 1,
};

const gun: GunModule = {
  weaponId: 'm82',
  assets: [M82_LAYOUT.asset],
  build: (assets) => assembleGun(assets.model(M82_LAYOUT.asset), M82_LAYOUT, (source) => tunedFinish(source, FINISH)),
};

export default gun;
