import gun, { M1911_LAYOUT } from '../../../src/weapons/models/m1911.gun';
import { describeGun } from './m1911-helpers';

// M1911A1: 216 mm long (a little more with the hammer cocked), 165 mm sight radius.
describeGun(gun, M1911_LAYOUT, {
  length: 0.216,
  sightRadius: 0.165,
  maxTriangles: 15000,
  behindPort: 'part_frame',
  frontSight: 'post',
  rearSight: true,
  shouldered: false,
});
