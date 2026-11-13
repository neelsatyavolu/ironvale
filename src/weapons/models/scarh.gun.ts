import type { GunModule } from './api';
import { assembleGun } from './lib/guns-c-build';
import { SCARH_LAYOUT, SCARH_OPTIC } from './lib/guns-c-layout';
import { tunedFinish, type FinishTweak } from './lib/guns-c-materials';
import { buildHoloSight } from './lib/guns-c-optic';

/**
 * SCAR-H battle rifle (7.62 x 51 mm) in a digital camouflage finish with black
 * furniture, a suppressor, a folding stock and a holographic sight. Model:
 * "FN SCAR-H" by Alex_Z, CC BY 4.0, processed by scripts/process-gun-scarh.mjs
 * (its own sight, rear flip-up sight and foregrip removed, textures converted
 * to metal/roughness). The sight is modelled in code (lib/guns-c-optic.ts) and
 * sits on the top rail. 0.99 m long with the suppressor; the grip centre is the origin.
 *
 * Moving parts, each resting at the identity under a holder at its pivot:
 * the left-side charging handle, which is fixed to the bolt carrier and so is
 * the bolt part (slides back along +Z by `cycleTravel`), magazine (drop along
 * -Y) and trigger (hinged at its pin, about X).
 */
const FINISH: FinishTweak = {
  tint: 0xffffff,
  metalLift: 0.02,
  polymerLift: 0.012,
  roughness: 0.75,
  roughnessBias: 0.1,
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
  weaponId: 'scarh',
  assets: [SCARH_LAYOUT.asset],
  build(assets) {
    const model = assembleGun(assets.model(SCARH_LAYOUT.asset), SCARH_LAYOUT, (source) => tunedFinish(source, FINISH));
    const sight = buildHoloSight();
    sight.position.set(0, SCARH_OPTIC.railTop, SCARH_OPTIC.window);
    model.root.add(sight);
    return model;
  },
};

export default gun;
