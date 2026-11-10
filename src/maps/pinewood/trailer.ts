import * as THREE from 'three/webgpu';
import type { Kit } from './kit';
import type { PinewoodMaterials } from './materials';

const BED_Y = 0.78;
const BED_HALF_WIDTH = 0.85;
const FRONT = -1.6;
const BACK = 1.8;
const WHEEL_RADIUS = 0.37;
const WHEEL_X = 1.02;
const WHEEL_Z = 0.25;

/**
 * Rusty single-axle logging trailer left on the trail with a load still on it.
 * The origin is on the ground under the axle; the drawbar points to -Z.
 */
export function buildTrailer(kit: Kit, m: PinewoodMaterials, random: () => number): void {
  const length = BACK - FRONT;
  const midZ = (FRONT + BACK) / 2;

  // Wheels and axle.
  const tyreProfile = [
    [0.22, -0.1],
    [0.33, -0.115],
    [WHEEL_RADIUS, -0.07],
    [WHEEL_RADIUS, 0.07],
    [0.33, 0.115],
    [0.22, 0.1],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  for (const side of [-1, 1]) {
    const tyre = new THREE.LatheGeometry(tyreProfile, 18);
    tyre.rotateZ(Math.PI / 2);
    const at = new THREE.Matrix4().makeTranslation(side * WHEEL_X, WHEEL_RADIUS - 0.02, WHEEL_Z);
    kit.geo(m.rubber, tyre, at);
    const hub = new THREE.CylinderGeometry(0.225, 0.225, 0.15, 12);
    hub.rotateZ(Math.PI / 2);
    kit.geo(m.rust, hub, at);
    kit.collider([0.26, WHEEL_RADIUS * 2, WHEEL_RADIUS * 2], [side * WHEEL_X, WHEEL_RADIUS, WHEEL_Z], 'metal');
    // Mudguard.
    kit.box(m.rust, [0.3, 0.025, 0.7], [side * WHEEL_X, BED_Y + 0.06, WHEEL_Z]);
    for (const end of [-1, 1]) {
      kit.box(m.rust, [0.3, 0.025, 0.3], [side * WHEEL_X, BED_Y - 0.03, WHEEL_Z + end * 0.47], { rot: [end * 0.7, 0, 0] });
    }
  }
  kit.pole(m.rust, [-WHEEL_X, WHEEL_RADIUS - 0.02, WHEEL_Z], [WHEEL_X, WHEEL_RADIUS - 0.02, WHEEL_Z], 0.035, 6);

  // Chassis and bed.
  for (const x of [-0.6, 0.6]) kit.box(m.rust, [0.07, 0.11, length], [x, BED_Y - 0.11, midZ]);
  for (const z of [FRONT + 0.05, -0.5, 0.7, BACK - 0.05]) kit.box(m.rust, [BED_HALF_WIDTH * 2, 0.08, 0.06], [0, BED_Y - 0.09, z]);
  kit.box(m.planks, [BED_HALF_WIDTH * 2, 0.05, length], [0, BED_Y - 0.025, midZ], { tile: 1.5 });
  kit.collider([BED_HALF_WIDTH * 2, 0.34, length], [0, BED_Y - 0.17, midZ], 'wood');

  // Stake sides: steel posts, two rows of boards, a board front, the tailgate dropped.
  for (const side of [-1, 1]) {
    for (const z of [FRONT + 0.05, -0.45, 0.7, BACK - 0.05]) {
      kit.box(m.rust, [0.05, 0.75, 0.05], [side * (BED_HALF_WIDTH + 0.01), BED_Y + 0.2, z]);
    }
    for (const y of [BED_Y + 0.14, BED_Y + 0.4]) {
      kit.box(m.planksDark, [0.035, 0.2, length], [side * (BED_HALF_WIDTH - 0.03), y, midZ], { tile: 1.5 });
    }
    kit.collider([0.07, 0.55, length], [side * BED_HALF_WIDTH, BED_Y + 0.275, midZ], 'wood');
  }
  kit.box(m.planksDark, [BED_HALF_WIDTH * 2, 0.48, 0.035], [0, BED_Y + 0.26, FRONT + 0.02], { surface: 'wood', tile: 1.5 });
  kit.box(m.planksDark, [BED_HALF_WIDTH * 2, 0.48, 0.035], [0, BED_Y - 0.27, BACK + 0.04], { rot: [-0.12, 0, 0], tile: 1.5 });

  // A-frame drawbar, coupling and jockey leg.
  for (const x of [-0.6, 0.6]) kit.beam(m.rust, [x, BED_Y - 0.12, FRONT], [0, BED_Y - 0.2, FRONT - 1.45], 0.06, 0.08);
  kit.box(m.iron, [0.1, 0.09, 0.22], [0, BED_Y - 0.2, FRONT - 1.52]);
  kit.pole(m.rust, [0, BED_Y - 0.16, FRONT - 1.15], [0, 0.03, FRONT - 1.15], 0.028, 6);
  kit.box(m.rust, [0.16, 0.02, 0.16], [0, 0.02, FRONT - 1.15]);
  kit.collider([0.9, 0.3, 1.5], [0, BED_Y - 0.22, FRONT - 0.75], 'metal');

  // The load: a pyramid of logs with sawn ends.
  const rows: readonly (readonly number[])[] = [[-0.57, -0.19, 0.19, 0.57], [-0.38, 0, 0.38], [-0.17, 0.2]];
  rows.forEach((row, level) => {
    for (const x of row) {
      const radius = 0.165 + random() * 0.03;
      const y = BED_Y + 0.19 + level * 0.32;
      const shift = (random() - 0.5) * 0.3;
      const z0 = FRONT + 0.15 + shift;
      const z1 = BACK - 0.2 + shift;
      kit.pole(m.bark, [x, y, z0], [x, y, z1], radius, 9, undefined, radius * 0.9);
      const near = new THREE.CircleGeometry(radius * 0.88, 9);
      kit.geo(m.cutWood, near, new THREE.Matrix4().makeTranslation(x, y, z1 + 0.004));
      const far = new THREE.CircleGeometry(radius * 0.98, 9);
      far.rotateY(Math.PI);
      kit.geo(m.cutWood, far, new THREE.Matrix4().makeTranslation(x, y, z0 - 0.004));
    }
  });
  kit.collider([1.5, 0.95, length - 0.2], [0, BED_Y + 0.475, midZ], 'wood');
}
