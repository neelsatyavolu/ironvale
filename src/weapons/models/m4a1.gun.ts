import type { GunModule } from './api';
import { assembleGun } from './lib/guns-c-build';
import { M4A1_LAYOUT, M4A1_OPTIC } from './lib/guns-c-layout';
import { tunedFinish, type FinishTweak } from './lib/guns-c-materials';
import { buildHoloSight } from './lib/guns-c-optic';

/**
 * M4A1 carbine with a quad-rail handguard, fixed front sight, collapsible
 * stock and a holographic sight. Model: "M4A1 Carbine" by MrM0lten, CC BY 4.0,
 * processed by scripts/process-gun-m4a1.mjs (carry handle removed); the sight
 * is modelled in code (lib/guns-c-optic.ts) and sits on the flat-top rail.
 * 0.84 m long with the stock out; the grip centre is the origin.
 *
 * Moving parts, each resting at the identity under a holder at its pivot:
 * bolt carrier (seen through the ejection port) and charging handle (slide
 * back along +Z by `cycleTravel`), magazine (drop along -Y) and trigger
 * (hinged at its pin, about X).
 */
const METAL: FinishTweak = {
  tint: 0xffffff,
  metalLift: 0.02,
  polymerLift: 0.012,
  roughness: 0.6,
  roughnessBias: 0,
  scratchGloss: 0.4,
  minRoughness: 0.3,
  maxRoughness: 0.95,
  metalness: 1,
  wear: 0.22,
  noiseScale: 60,
  rub: 0.15,
  normalScale: 1,
};
/** The source file gives each texture set a flat roughness, so the finish is set per material here. */
const FINISH: Readonly<Record<string, FinishTweak>> = {
  m4a1_metal: METAL,
  // Glass-filled polymer stock on a steel buffer tube.
  m4a1_stock: { ...METAL, roughness: 0.74, scratchGloss: 0.25, rub: 0.05 },
  // Grey anodised aluminium magazine, painted lighter than the rifle in the source.
  m4a1_magazine: { ...METAL, tint: 0xa8a8a8, roughness: 0.55 },
};

const gun: GunModule = {
  weaponId: 'm4a1',
  assets: [M4A1_LAYOUT.asset],
  build(assets) {
    const model = assembleGun(assets.model(M4A1_LAYOUT.asset), M4A1_LAYOUT, (source) => tunedFinish(source, FINISH[source.name] ?? METAL));
    const sight = buildHoloSight();
    sight.position.set(0, M4A1_OPTIC.railTop, M4A1_OPTIC.window);
    model.root.add(sight);
    return model;
  },
};

export default gun;
