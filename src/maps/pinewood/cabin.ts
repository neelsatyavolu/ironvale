import * as THREE from 'three/webgpu';
import { boxProjectUvs, type Kit, type Vec3 } from './kit';
import { CABIN } from './layout';
import type { PinewoodMaterials } from './materials';

const HX = CABIN.width / 2;
const HZ = CABIN.depth / 2;
/** Wall thickness, eaves height and ridge height. */
const T = 0.45;
const EAVES = 2.5;
const RIDGE = 4.1;
const OVERHANG = 0.35;
const PITCH = Math.atan((RIDGE - EAVES) / HZ);
const WX = HX - T / 2;
const WZ = HZ - T / 2;
/** Inner faces of the long walls. */
const IX = HX - T;

/** Local position of the lantern hanging from the middle tie beam. */
export const CABIN_LAMP: Vec3 = [0.1, 2.02, 0.35];

/** Stone wall segment between two x (or z) coordinates, from the floor up to `height`. */
function wallX(kit: Kit, m: PinewoodMaterials, x0: number, x1: number, z: number, height: number, y0 = 0): void {
  kit.box(m.stone, [x1 - x0, height - y0, T], [(x0 + x1) / 2, (y0 + height) / 2, z], { surface: 'concrete' });
}
function wallZ(kit: Kit, m: PinewoodMaterials, z0: number, z1: number, x: number, height: number, y0 = 0): void {
  kit.box(m.stone, [T, height - y0, z1 - z0], [x, (y0 + height) / 2, (z0 + z1) / 2], { surface: 'concrete' });
}

function walls(kit: Kit, m: PinewoodMaterials): void {
  // East wall with the door (z 0.2 to 1.2).
  wallZ(kit, m, -HZ, 0.2, WX, EAVES);
  wallZ(kit, m, 1.2, HZ, WX, EAVES);
  wallZ(kit, m, 0.2, 1.2, WX, EAVES, 2.18);
  kit.box(m.planksDark, [T + 0.1, 0.1, 1.3], [WX, 2.13, 0.7]);
  // What is left of the east gable.
  wallZ(kit, m, -1.5, 0.5, WX, 3.15, EAVES);
  wallZ(kit, m, -0.7, 0.2, WX, 3.55, 3.15);

  // West wall: whole along the south, broken down toward the collapsed north corner.
  wallZ(kit, m, -1.5, HZ, -WX, EAVES);
  wallZ(kit, m, -2.05, -1.5, -WX, 1.55);
  wallZ(kit, m, -HZ, -2.05, -WX, 0.75);
  const gable = new THREE.Shape();
  gable.moveTo(HZ, EAVES);
  gable.lineTo(0, RIDGE);
  gable.lineTo(-0.9, 3.56);
  gable.lineTo(-1.05, 3.0);
  gable.lineTo(-1.5, 2.85);
  gable.lineTo(-1.5, EAVES);
  gable.closePath();
  const prism = new THREE.ExtrudeGeometry(gable, { depth: T, bevelEnabled: false });
  prism.rotateY(-Math.PI / 2);
  prism.translate(-WX + T / 2, 0, 0);
  kit.geo(m.stone, boxProjectUvs(prism, 2), new THREE.Matrix4(), 'concrete');

  // South wall with a window (x -1.9 to -0.9).
  wallX(kit, m, -IX, -1.9, WZ, EAVES);
  wallX(kit, m, -0.9, IX, WZ, EAVES);
  wallX(kit, m, -1.9, -0.9, WZ, 0.95);
  wallX(kit, m, -1.9, -0.9, WZ, EAVES, 1.95);

  // North wall: a walk-through breach at the west end, then a window (x 0.9 to 1.9).
  wallX(kit, m, -1.5, -1.0, -WZ, 1.3);
  wallX(kit, m, -1.0, -0.4, -WZ, 2.0);
  wallX(kit, m, -0.4, 0.9, -WZ, EAVES);
  wallX(kit, m, 1.9, IX, -WZ, EAVES);
  wallX(kit, m, 0.9, 1.9, -WZ, 0.95);
  wallX(kit, m, 0.9, 1.9, -WZ, EAVES, 1.95);

  // Window sills and lintels, and a shutter hanging by one hinge.
  for (const [x, z] of [
    [-1.4, WZ],
    [1.4, -WZ],
  ] as const) {
    kit.box(m.planksDark, [1.2, 0.07, T + 0.14], [x, 0.95, z]);
    kit.box(m.planksDark, [1.2, 0.1, T + 0.06], [x, 2.0, z]);
  }
  kit.box(m.planks, [0.5, 0.95, 0.04], [-2.2, 1.38, HZ + 0.05], { rot: [0, 0, 0.16], tile: 1.4 });

  // Chimney outside the west wall, fireplace inside.
  kit.box(m.stone, [0.95, 5.0, 1.35], [-HX - 0.4, 2.5, 0.9], { surface: 'concrete' });
  kit.box(m.stone, [1.1, 0.16, 1.5], [-HX - 0.4, 5.08, 0.9]);
  for (const side of [-1, 1]) kit.box(m.stone, [0.4, 1.25, 0.32], [-IX + 0.2, 0.625, 0.9 + side * 0.56], { surface: 'concrete' });
  kit.box(m.planksDark, [0.42, 0.13, 1.7], [-IX + 0.21, 1.32, 0.9]);
  kit.box(m.stone, [0.75, 0.1, 1.5], [-IX + 0.37, 0.15, 0.9]);
  kit.box(m.char, [0.3, 0.9, 0.8], [-IX + 0.02, 0.6, 0.9]);
}

function roof(kit: Kit, m: PinewoodMaterials): void {
  const eaveZ = HZ + OVERHANG;
  const eaveY = EAVES - OVERHANG * Math.tan(PITCH) + 0.1;
  const ridgeY = RIDGE + 0.1;
  const rafterXs = [-3.5, -2.6, -1.7, -0.8, 0.1, 1.0, 1.9, 2.8, 3.5];
  for (const x of rafterXs) {
    // South rafters: the two at the east end have snapped halfway.
    const southTop: Vec3 = x > 2.5 ? [x, (eaveY + ridgeY) / 2 + 0.1, eaveZ / 2] : [x, ridgeY, 0];
    kit.beam(m.planksDark, [x, eaveY, eaveZ], southTop, 0.09, 0.14);
    // North rafters are gone over the collapsed corner.
    if (x > -1.5) kit.beam(m.planksDark, [x, eaveY, -eaveZ], x > 3 ? [x, 3.2, -1.45] : [x, ridgeY, 0], 0.09, 0.14);
  }
  kit.beam(m.planksDark, [-HX, ridgeY - 0.02, 0], [2.3, ridgeY - 0.02, 0], 0.12, 0.16);
  for (const x of [-1.7, 0.1, 1.9]) kit.beam(m.planksDark, [x, EAVES + 0.07, -HZ], [x, EAVES + 0.07, HZ], 0.13, 0.13);
  // Fallen rafters lean in the breach.
  kit.beam(m.planksDark, [-2.9, 0.08, -3.6], [-2.2, 1.5, -1.3], 0.09, 0.14);
  kit.beam(m.planksDark, [-3.6, 0.06, -1.1], [-1.2, 0.1, -3.9], 0.09, 0.14);

  // Board and shingle decking: most of the south slope, part of the north.
  const slope = eaveZ / Math.cos(PITCH);
  const midY = (eaveY + ridgeY) / 2 + 0.11;
  const deck = (x0: number, x1: number, side: 1 | -1, from = 0, to = 1): void => {
    const length = slope * (to - from);
    const along = (from + to) / 2;
    kit.box(m.roof, [x1 - x0, 0.05, length], [(x0 + x1) / 2, ridgeY + 0.11 - (ridgeY - eaveY) * along, side * eaveZ * along], {
      rot: [side * PITCH, 0, 0],
      surface: 'wood',
      tile: 1.6,
    });
  };
  deck(-HX - 0.25, 1.35, 1);
  deck(1.35, 2.2, 1, 0, 0.55);
  deck(-0.75, 2.35, -1);
  deck(-1.5, -0.75, -1, 0, 0.45);
  // A loose board slid down the south slope.
  kit.box(m.roof, [0.3, 0.04, 1.6], [1.85, midY - 0.45, eaveZ * 0.72], { rot: [PITCH, 0.2, 0], tile: 1.6 });
}

function interior(kit: Kit, m: PinewoodMaterials): void {
  // Plank floor over the western half; the rest is packed earth.
  kit.box(m.planks, [IX + 0.4, 0.1, CABIN.depth - T * 2], [(-IX + 0.4) / 2, 0.05, 0], { surface: 'wood', tile: 1.6 });
  kit.box(m.stone, [0.5, 0.08, 1.1], [WX, 0.04, 0.7]);

  // Table with a bench knocked over beside it.
  kit.box(m.planks, [1.3, 0.05, 0.75], [1.7, 0.77, -1.2], { tile: 1.3 });
  for (const [dx, dz] of [
    [-0.58, -0.3],
    [0.58, -0.3],
    [-0.58, 0.3],
    [0.58, 0.3],
  ] as const) {
    kit.box(m.planksDark, [0.07, 0.75, 0.07], [1.7 + dx, 0.375, -1.2 + dz]);
  }
  kit.collider([1.3, 0.8, 0.75], [1.7, 0.4, -1.2], 'wood');
  kit.box(m.planksDark, [1.1, 0.05, 0.28], [1.5, 0.16, -0.25], { rot: [1.25, 0.3, 0], tile: 1.3 });

  // Bunk along the south wall.
  kit.box(m.planksDark, [1.9, 0.06, 0.8], [-2.25, 0.5, 1.8], { tile: 1.4 });
  kit.box(m.planksDark, [1.9, 0.3, 0.05], [-2.25, 0.42, 1.42]);
  for (const dx of [-0.92, 0.92]) kit.box(m.planksDark, [0.07, 0.75, 0.8], [-2.25 + dx, 0.375, 1.8]);
  kit.collider([1.9, 0.6, 0.8], [-2.25, 0.3, 1.8], 'wood');

  // Crates in the south-east corner and a shelf on the north wall.
  kit.box(m.planks, [0.7, 0.6, 0.6], [2.75, 0.3, 1.8], { rot: [0, 0.2, 0], surface: 'wood', tile: 1.1 });
  kit.box(m.planksDark, [0.5, 0.45, 0.5], [2.7, 0.825, 1.78], { rot: [0, -0.3, 0], surface: 'wood', tile: 0.9 });
  kit.box(m.planksDark, [1.2, 0.04, 0.24], [0.25, 1.5, -HZ + T + 0.12]);

  // Lantern on a chain from the tie beam.
  const [lx, ly, lz] = CABIN_LAMP;
  kit.pole(m.iron, [lx, EAVES, lz], [lx, ly + 0.14, lz], 0.006, 4);
  kit.box(m.iron, [0.13, 0.03, 0.13], [lx, ly + 0.13, lz]);
  kit.box(m.iron, [0.13, 0.03, 0.13], [lx, ly - 0.1, lz]);
  kit.box(m.lampGlow, [0.09, 0.2, 0.09], [lx, ly + 0.015, lz]);
}

/** What the last occupant left: things on the table and shelf, a pot on the hearth, bedding, split wood. */
function clutter(kit: Kit, m: PinewoodMaterials): void {
  const lathe = (material: THREE.Material, profile: readonly (readonly [number, number])[], at: Vec3, tilt: Vec3 = [0, 0, 0]): void => {
    const geometry = new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 8);
    kit.geo(material, geometry, new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...tilt)).setPosition(...at));
  };
  const bottle: readonly (readonly [number, number])[] = [[0, 0], [0.036, 0], [0.038, 0.15], [0.014, 0.2], [0.014, 0.27], [0, 0.27]];
  const mug: readonly (readonly [number, number])[] = [[0, 0], [0.04, 0], [0.043, 0.09], [0.037, 0.09], [0.035, 0.01], [0, 0.01]];
  const pot: readonly (readonly [number, number])[] = [[0, 0], [0.13, 0], [0.16, 0.06], [0.16, 0.2], [0.145, 0.2], [0.14, 0.03], [0, 0.03]];

  // Table: two bottles (one on its side), a mug and a tin plate.
  lathe(m.glass, bottle, [1.42, 0.795, -1.32]);
  lathe(m.glass, bottle, [1.95, 0.832, -1.02], [Math.PI / 2, 0, 0.7]);
  lathe(m.iron, mug, [1.72, 0.795, -1.38]);
  lathe(m.iron, [[0, 0], [0.11, 0], [0.125, 0.015], [0, 0.012]], [1.55, 0.795, -1.02]);
  // Shelf: tins and a bottle.
  lathe(m.glass, bottle, [-0.18, 1.52, -HZ + T + 0.12]);
  for (const [x, r, h] of [[0.12, 0.05, 0.12], [0.3, 0.042, 0.1], [0.62, 0.055, 0.15]] as const) {
    lathe(m.rust, [[0, 0], [r, 0], [r, h], [0, h]], [x, 1.52, -HZ + T + 0.12]);
  }
  // Hearth: a blackened pot, and split wood stacked beside the fireplace.
  lathe(m.char, pot, [-IX + 0.55, 0.2, 0.75]);
  for (let i = 0; i < 7; i++) {
    const row = Math.floor(i / 3);
    const x = -IX + 0.28 + (i % 3) * 0.15 + row * 0.07;
    kit.pole(i % 2 === 0 ? m.cutWood : m.bark, [x, 0.17 + row * 0.13, 1.72], [x, 0.17 + row * 0.13, 2.12], 0.065, 5);
  }
  // Bunk: a folded blanket and a bedroll.
  kit.box(m.wool, [0.85, 0.07, 0.62], [-2.55, 0.565, 1.82], { rot: [0, 0.06, 0] });
  const roll = new THREE.CylinderGeometry(0.11, 0.11, 0.6, 10);
  roll.rotateX(Math.PI / 2);
  kit.geo(m.wool, roll, new THREE.Matrix4().makeTranslation(-1.55, 0.64, 1.8));
  // A fuel can by the door.
  kit.box(m.rust, [0.22, 0.32, 0.14], [2.85, 0.16, -0.35], { rot: [0, 0.4, 0] });
}

function outside(kit: Kit, m: PinewoodMaterials): void {
  // The door stands open against the outer wall.
  kit.box(m.planks, [0.05, 2.05, 0.95], [HX + 0.17, 1.03, -0.26], { rot: [0, 2.88, 0], surface: 'wood', tile: 1.2 });

  // Rain barrel by the door.
  const profile = [
    [0.0, 0],
    [0.27, 0],
    [0.33, 0.25],
    [0.35, 0.45],
    [0.33, 0.68],
    [0.28, 0.9],
    [0.25, 0.9],
    [0.25, 0.84],
    [0.0, 0.84],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const barrel = new THREE.LatheGeometry(profile, 14);
  const uv = barrel.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 1.2);
  kit.geo(m.planksDark, barrel, new THREE.Matrix4().makeTranslation(HX + 0.5, 0, 2.05));
  for (const y of [0.2, 0.7]) {
    const hoop = new THREE.TorusGeometry(y === 0.2 ? 0.325 : 0.33, 0.012, 4, 16);
    hoop.rotateX(Math.PI / 2);
    kit.geo(m.iron, hoop, new THREE.Matrix4().makeTranslation(HX + 0.5, y, 2.05));
  }
  kit.collider([0.62, 0.9, 0.62], [HX + 0.5, 0.45, 2.05], 'wood');
}

export interface CabinResult {
  /** Local-space box of the room, for the interior zone. */
  readonly room: THREE.Box3;
}

/** Ruined stone cabin: one room, a door to the east, a breach to the north-west, half a roof. */
export function buildCabin(kit: Kit, materials: PinewoodMaterials): CabinResult {
  walls(kit, materials);
  roof(kit, materials);
  interior(kit, materials);
  clutter(kit, materials);
  outside(kit, materials);
  return { room: new THREE.Box3(new THREE.Vector3(-IX, 0, -HZ + T), new THREE.Vector3(IX, RIDGE, HZ - T)) };
}
