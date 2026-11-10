import gun, { MP5_LAYOUT } from '../../../src/weapons/models/mp5.gun';
import { describeGun } from './m1911-helpers';

// 0.68 m long with the sliding stock pulled out, like the real gun; its sight radius is 340 mm.
describeGun(gun, MP5_LAYOUT, {
  length: 0.68,
  sightRadius: 0.34,
  maxTriangles: 8000,
  behindPort: 'part_bolt',
  frontSight: 'post',
  rearSight: true,
  shouldered: true,
});
