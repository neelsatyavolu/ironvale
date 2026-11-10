import type { GunModule } from './api';
import { assembleGun, type GunLayout } from './lib/guns-a-assemble';
import { applyFinishes, type FinishTweak } from './lib/guns-a-materials';

/**
 * Remington 870 Police with an 18 inch barrel and a synthetic pistol-grip
 * stock. Model: "Remington 870 Police Magnum 12 Gauge Shotgun" by 8sianDude
 * (CC BY 4.0), processed by scripts/process-gun-r870.mjs. 0.97 m long; the
 * grip centre is the origin. The pump node carries the fore-end, action bars
 * and bolt, which are linked in the real gun, so moving it opens the action.
 */
export const R870_ASSET = 'mdl-gun-r870';

export const R870_LAYOUT: GunLayout = {
  parts: { pump: 'part_pump', trigger: 'part_trigger' },
  cycleTravel: 0.09,
  eyeRelief: 0.3,
  ejectionTiltDeg: 15,
  grips: {
    // Right palm on the right of the pistol grip, low enough that the thumb stays under the stock
    // and out of the sight picture.
    trigger: { position: [0.017, -0.012, 0.014], fingers: [0, -0.35, -1], thumb: [0, 1, 0] },
    // Left hand cupping the fore-end from below; it travels with the pump.
    support: { position: [-0.01, 0.016, -0.4], fingers: [0.55, 0.1, -0.8], thumb: [-0.75, 0.3, -0.55], on: 'pump' },
  },
};

const FINISHES: Readonly<Record<string, FinishTweak>> = {
  // Parkerized steel a shade darker than the texture with tighter highlights, against a matte polymer stock and fore-end.
  R870: { metalTint: 0xc8ccd4, metalRoughness: 0.78, plainRoughness: 1.4, minRoughness: 0.28, wear: 0.25 },
};

const gun: GunModule = {
  weaponId: 'r870',
  assets: [R870_ASSET],
  build(assets) {
    const scene = assets.model(R870_ASSET);
    applyFinishes(scene, FINISHES);
    return assembleGun(scene, R870_LAYOUT);
  },
};

export default gun;
