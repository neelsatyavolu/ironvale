/**
 * Plain side view of one gun with no markers, for the weapon picker's pictures.
 * `/?view=weapons/models/side&gun=m4a1&yaw=90&pitch=0`; see scripts/dev/gun-pictures.mjs.
 */
import type { Viewable } from '../../dev/viewer';
import { viewModelAssets, buildGunModel } from '../view/registry';
import { WEAPON_IDS, type WeaponId } from './api';

const requested = new URLSearchParams(location.search).get('gun');
const id: WeaponId = WEAPON_IDS.find((weapon) => weapon === requested) ?? 'm4a1';

const side: Viewable = {
  assets: viewModelAssets(),
  create: (assets) => buildGunModel(id, assets).root,
};

export default side;
