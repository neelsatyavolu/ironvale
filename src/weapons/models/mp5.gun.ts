import type { GunModule } from './api';
import { assembleGun, type GunLayout } from './lib/guns-a-assemble';
import { applyFinishes, type FinishTweak } from './lib/guns-a-materials';

/**
 * MP5 submachine gun with a top rail and its sliding stock pulled out. Model:
 * "MP5 submachinegun" by Michael Karel (CC BY 4.0), processed by
 * scripts/process-gun-mp5.mjs. 0.68 m long; the grip centre is the origin.
 * The bolt (with the round seen through the ejection port), cocking handle,
 * magazine and trigger are separate nodes.
 */
export const MP5_ASSET = 'mdl-gun-mp5';

export const MP5_LAYOUT: GunLayout = {
  parts: { bolt: 'part_bolt', chargingHandle: 'part_charging', magazine: 'part_magazine', trigger: 'part_trigger' },
  cycleTravel: 0.045,
  eyeRelief: 0.25,
  ejectionTiltDeg: 20,
  grips: {
    // Right palm on the right of the pistol grip, high enough for the index finger to reach the trigger.
    trigger: { position: [0.0135, 0.03, 0.012], fingers: [0, -0.35, -1], thumb: [0, 1, 0] },
    // Left hand under the handguard, fingers wrapping up its right side.
    support: { position: [-0.012, 0.096, -0.255], fingers: [0.55, 0.2, -0.8], thumb: [-0.75, 0.3, -0.55] },
  },
};

const FINISHES: Readonly<Record<string, FinishTweak>> = {
  'MP-5_0': { minRoughness: 0.3, wear: 0.2 },
};

const gun: GunModule = {
  weaponId: 'mp5',
  assets: [MP5_ASSET],
  build(assets) {
    const scene = assets.model(MP5_ASSET);
    applyFinishes(scene, FINISHES);
    return assembleGun(scene, MP5_LAYOUT);
  },
};

export default gun;
