import gun, { R870_LAYOUT } from '../../../src/weapons/models/r870.gun';
import { describeGun } from './m1911-helpers';

// 870 Police with an 18 inch barrel: 0.97 m overall. It has a bead and no rear sight, so the
// "sight radius" is from the back of the receiver's flat top to the bead.
describeGun(gun, R870_LAYOUT, {
  length: 0.975,
  sightRadius: 0.59,
  maxTriangles: 20000,
  behindPort: 'part_pump',
  frontSight: 'bead',
  rearSight: false,
  shouldered: true,
});
