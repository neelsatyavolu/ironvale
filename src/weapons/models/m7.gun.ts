import type { GunModule } from './api';
import { assembleGun } from './lib/guns-c-build';
import { M7_LAYOUT, M7_OPTIC } from './lib/guns-c-layout';
import { buildHoloSight } from './lib/guns-c-optic';
import { m7Finish } from './lib/m7-materials';

/**
 * M7 rifle (SIG MCX-SPEAR pattern, 6.8 x 51 mm): coyote finish, long M-LOK
 * handguard, folding stock, 20-round box magazine, suppressor and a
 * holographic sight. It is not a model of a real M7: the base is "Low-Poly Sig
 * MCX" by TastyTony, CC BY 4.0, a 5.56 mm MCX, which
 * scripts/process-gun-m7.mjs reshapes (shorter front end, suppressor, straight
 * magazine, left-side charging handle). The receiver and magazine well keep
 * the smaller MCX proportions. The sight is modelled in code
 * (lib/guns-c-optic.ts) and the finishes are set in lib/m7-materials.ts.
 * 0.99 m long with the suppressor; the grip centre is the origin.
 *
 * Moving parts, each resting at the identity under a holder at its pivot:
 * bolt carrier (seen through the ejection port) and the rear charging handle
 * (slide back along +Z by `cycleTravel`), magazine with its top rounds (drop
 * along -Y) and trigger (hinged at its pin, about X). The left-side charging
 * handle is fixed.
 */
const gun: GunModule = {
  weaponId: 'm7',
  assets: [M7_LAYOUT.asset],
  build(assets) {
    const model = assembleGun(assets.model(M7_LAYOUT.asset), M7_LAYOUT, m7Finish);
    const sight = buildHoloSight();
    sight.position.set(0, M7_OPTIC.railTop, M7_OPTIC.window);
    model.root.add(sight);
    return model;
  },
};

export default gun;
