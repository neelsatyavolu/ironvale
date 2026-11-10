import type { GunModule } from './api';
import { assembleGun, type GunLayout } from './lib/guns-a-assemble';
import { applyFinishes, type FinishTweak } from './lib/guns-a-materials';

/**
 * M1911 pistol. Model: "M1911 pistol" by e.belous (CC BY 4.0), processed by
 * scripts/process-gun-m1911.mjs. 0.22 m long with the hammer cocked; the grip
 * centre is the origin. The slide, magazine and trigger are separate nodes.
 */
export const M1911_ASSET = 'mdl-gun-m1911';

export const M1911_LAYOUT: GunLayout = {
  parts: { slide: 'part_slide', magazine: 'part_magazine', trigger: 'part_trigger' },
  cycleTravel: 0.05,
  eyeRelief: 0.4,
  ejectionTiltDeg: 30,
  grips: {
    // Right palm on the right grip panel, fingers wrapping forward.
    trigger: { position: [0.017, -0.01, 0.012], fingers: [0, -0.2, -1], thumb: [0, 1, 0] },
    // Left palm on the left panel, cupping the trigger hand a little lower and further forward.
    support: { position: [-0.021, -0.012, -0.006], fingers: [0.25, -0.2, -1], thumb: [0, 1, -0.25] },
  },
};

const FINISHES: Readonly<Record<string, FinishTweak>> = {
  // Slide, barrel and small parts: worn blued steel.
  set1: { metalTint: 0xa9afbb, minRoughness: 0.26, wear: 0.3 },
  // Frame, magazine and the wooden grip panels.
  set2: { metalTint: 0xa9afbb, minRoughness: 0.28, wear: 0.3 },
};

const gun: GunModule = {
  weaponId: 'm1911',
  assets: [M1911_ASSET],
  build(assets) {
    const scene = assets.model(M1911_ASSET);
    applyFinishes(scene, FINISHES);
    return assembleGun(scene, M1911_LAYOUT);
  },
};

export default gun;
