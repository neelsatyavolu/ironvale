/**
 * M24 sniper rifle. Mesh: "R700V2" by Domevans, CC BY 4.0 (a Remington 700 in
 * the M24 configuration: heavy barrel, olive stock and rail), processed by
 * scripts/process-gun-m24.mjs. The scope and its rings, the bipod, sling
 * swivel, barrel fittings and detachable magazine (M24A2 pattern) are built
 * in code, and the finishes are extended there too (lib/m24-*.ts).
 * Measurements are in the processed file's space (metres, barrel -Z, bore on
 * x = 0, origin at the wrist of the stock).
 */
import type { GunModule } from './api';
import { addMagazine, type MagazineSpec } from './lib/guns-b-magazine';
import { buildRifle, originIn, type RifleSpec } from './lib/guns-b-rig';
import { addDetails } from './lib/m24-details';

/** Bore axis height above the origin, and the crown's distance down the barrel. */
export const M24_BORE = { y: 0.057, muzzleZ: -0.781 } as const;

const MAGAZINE: MagazineSpec = { top: [0, 0.022, -0.116], length: 0.066, width: 0.025, height: 0.056, stockBottom: 0.0065 };
/** Top of the receiver rail, barrel radius at the crown, and the undersides the bipod and rear swivel mount on. */
const FITTINGS = {
  railTop: 0.0799,
  muzzleRadius: 0.0104,
  bipodAt: [0, 0.027, -0.428],
  swivelAt: [0, -0.0875, 0.235],
} as const;
const round = (value: number): number => Math.round(value * 1e5) / 1e5;

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
    addMagazine(mesh, MAGAZINE);
    // The scope is built around the two lens discs of the source mesh.
    const ocular = originIn(mesh, 'lens_ocular');
    const objective = originIn(mesh, 'lens_objective');
    addDetails(mesh, {
      scope: { axisY: round(ocular.y), ocularZ: round(ocular.z), objectiveZ: round(objective.z), railTop: FITTINGS.railTop },
      furniture: { bore: M24_BORE, muzzleRadius: FITTINGS.muzzleRadius, bipodAt: FITTINGS.bipodAt, swivelAt: FITTINGS.swivelAt },
    });
  },
};

const m24: GunModule = {
  weaponId: 'm24',
  assets: [SPEC.assetId],
  build: (assets) => buildRifle(assets, SPEC),
};

export default m24;
