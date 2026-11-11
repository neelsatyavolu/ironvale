import * as THREE from 'three/webgpu';
import { MeshBuilder } from './builder';
import type { Kit } from './kit';
import { logoGeometry, type Materials } from './materials';
import { RAIL, YARD } from './plan';

const GAUGE = 1.435;
const SLEEPER_SPACING = 0.62;
const RAIL_TOP = 0.19;
const DECK = 1.2;
const WAGON_WIDTH = 2.9;
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Where the wagons stand. `z` is the wagon centre. */
export const WAGONS = {
  flatA: { x: RAIL.trackA, z: -8, length: 14 },
  flatB: { x: RAIL.trackB, z: -21, length: 14 },
  boxcar: { x: RAIL.trackB, z: 14, length: 13.2 },
} as const;

/** Two tracks on ballast, running on as flush rails across the quay apron, with buffer stops. */
export function buildTracks(kit: Kit, m: Materials): void {
  const length = RAIL.south - RAIL.north;
  const mid = (RAIL.south + RAIL.north) / 2;
  const sleeper = new THREE.BoxGeometry(2.5, 0.14, 0.25);
  for (const track of [RAIL.trackA, RAIL.trackB]) {
    for (const side of [-1, 1]) {
      const x = track + (side * GAUGE) / 2;
      kit.box(m.rawSteel, 0.07, 0.13, length, x, RAIL_TOP - 0.13, mid, { color: 0x6a5f57 });
      kit.box(m.rawSteel, 0.14, 0.02, length, x, RAIL_TOP - 0.15, mid, { color: 0x4d443e });
      // Polished running surface.
      kit.box(m.rawSteel, 0.05, 0.004, length, x, RAIL_TOP, mid, { color: 0xc2c4c6 });
      // Across the apron the rails are set into the concrete.
      kit.box(m.rawSteel, 0.07, 0.012, YARD.apron - YARD.quay - 6, x, 0, (YARD.apron + YARD.quay + 6) / 2, { color: 0x8d8a86 });
    }
    for (let z = RAIL.north + 0.3; z < RAIL.south; z += SLEEPER_SPACING) {
      const skew = kit.range(-0.015, 0.015);
      kit.add(m.wood, sleeper, kit.transform(track + kit.range(-0.03, 0.03), -0.028, z, skew), 0x3f3832);
    }
    buildBufferStop(kit, m, track, RAIL.south - 0.6, 1);
    buildBufferStop(kit, m, track, YARD.quay + 6.4, -1);
  }
  sleeper.dispose();
}

function buildBufferStop(kit: Kit, m: Materials, x: number, z: number, facing: number): void {
  const red = 0x4f2622;
  for (const side of [-1, 1]) {
    const rx = x + (side * GAUGE) / 2;
    kit.beam(m.steel, V(rx, 0.1, z - facing * 1.6), V(rx, 1.05, z), 0.1, 0.14, red);
    kit.box(m.steel, 0.1, 1.05, 0.14, rx, 0.1, z, { color: red });
  }
  kit.box(m.steel, 2.5, 0.3, 0.22, x, 0.85, z, { color: red });
  kit.box(m.hazard, 2.3, 0.26, 0.04, x, 0.87, z - facing * 0.13);
  kit.collide(2.5, 1.2, 1.7, x, 0, z - facing * 0.75, 'metal');
}

/** Two-axle bogie with side frames, baked into `steel` and `dark`. Centre at local (0, 0, z). */
function addBogie(dark: MeshBuilder, z: number): void {
  const wheel = new THREE.CylinderGeometry(0.46, 0.46, 0.13, 18).rotateZ(Math.PI / 2);
  const axle = new THREE.CylinderGeometry(0.08, 0.08, GAUGE + 0.5, 8).rotateZ(Math.PI / 2);
  for (const dz of [-0.9, 0.9]) {
    for (const side of [-1, 1]) dark.add(wheel, new THREE.Matrix4().makeTranslation((side * GAUGE) / 2, 0.46 + RAIL_TOP, z + dz));
    dark.add(axle, new THREE.Matrix4().makeTranslation(0, 0.46 + RAIL_TOP, z + dz));
  }
  for (const side of [-1, 1]) {
    dark.box(0.12, 0.3, 2.5, side * (GAUGE / 2 + 0.22), 0.62, z);
    dark.box(0.2, 0.26, 0.5, side * (GAUGE / 2 + 0.22), 0.5, z);
  }
  dark.box(GAUGE + 0.6, 0.2, 0.4, 0, 0.78, z);
  wheel.dispose();
  axle.dispose();
}

/** Underframe shared by both wagon types: bogies, centre sill, buffers and couplers. */
function addUnderframe(dark: MeshBuilder, length: number): void {
  const half = length / 2;
  addBogie(dark, -half + 2.3);
  addBogie(dark, half - 2.3);
  dark.box(0.5, 0.3, length - 0.4, 0, DECK - 0.38, 0);
  for (const end of [-1, 1]) {
    dark.box(WAGON_WIDTH - 0.2, 0.34, 0.16, 0, DECK - 0.36, end * (half - 0.08));
    for (const side of [-1, 1]) {
      const buffer = new THREE.CylinderGeometry(0.19, 0.19, 0.12, 12).rotateX(Math.PI / 2);
      dark.add(buffer, new THREE.Matrix4().makeTranslation(side * 0.88, DECK - 0.36, end * (half + 0.42)));
      buffer.dispose();
      dark.box(0.1, 0.1, 0.4, side * 0.88, DECK - 0.36, end * (half + 0.2));
    }
    dark.box(0.2, 0.22, 0.5, 0, DECK - 0.42, end * (half + 0.2));
  }
}

function wagonColliders(kit: Kit, x: number, z: number, length: number, bodyHeight: number): void {
  kit.collide(WAGON_WIDTH, bodyHeight + 0.4, length, x, DECK - 0.4, z, 'metal');
  for (const end of [-1, 1]) kit.collide(2.3, DECK - 0.4, 2.8, x, 0, z + end * (length / 2 - 2.3), 'metal');
}

/** Flat wagon with a timber deck and stanchions. Loads are added by the caller. */
export function buildFlatcar(kit: Kit, m: Materials, x: number, z: number, length: number, paint: number): void {
  const dark = new MeshBuilder();
  const body = new MeshBuilder();
  addUnderframe(dark, length);
  for (const side of [-1, 1]) {
    body.box(0.14, 0.36, length, side * (WAGON_WIDTH / 2 - 0.07), DECK - 0.2, 0);
    for (let s = -length / 2 + 0.9; s < length / 2; s += 2.05) body.box(0.1, 0.75, 0.1, side * (WAGON_WIDTH / 2 - 0.05), DECK + 0.35, s);
  }
  const at = kit.transform(x, 0, z);
  const darkGeometry = dark.build();
  const bodyGeometry = body.build();
  kit.add(m.steel, darkGeometry, at, 0x26282a);
  kit.add(m.steel, bodyGeometry, at, paint);
  darkGeometry.dispose();
  bodyGeometry.dispose();
  // Deck planks laid across the wagon.
  for (let s = -length / 2 + 0.12; s < length / 2; s += 0.24) {
    kit.box(m.wood, WAGON_WIDTH - 0.3, 0.06, 0.22, x, DECK - 0.06, z + s, { color: 0x8f867c });
  }
  wagonColliders(kit, x, z, length, 0);
}

/** Covered van: ribbed steel body, sliding door, arched roof and end ladders. */
export function buildBoxcar(kit: Kit, m: Materials, x: number, z: number, length: number, paint: number): void {
  const dark = new MeshBuilder();
  const ribs = new MeshBuilder();
  addUnderframe(dark, length);
  const height = 2.85;
  const halfW = WAGON_WIDTH / 2;
  for (const side of [-1, 1]) {
    for (let s = -length / 2 + 0.05; s <= length / 2; s += 1.1) ribs.box(0.07, height, 0.09, side * (halfW + 0.02), DECK + height / 2, s);
    ribs.box(0.06, 0.12, length, side * (halfW + 0.02), DECK + 0.06, 0);
    ribs.box(0.06, 0.12, length, side * (halfW + 0.02), DECK + height - 0.06, 0);
    // Door runner and the door itself, standing proud of the body.
    ribs.box(0.05, 0.08, 5.6, side * (halfW + 0.06), DECK + height - 0.2, 0.6);
    ribs.box(0.05, 0.06, 5.6, side * (halfW + 0.06), DECK + 0.04, 0.6);
    ribs.box(0.05, 1.1, 0.05, side * (halfW + 0.1), DECK + 1.2, -1.2);
  }
  for (const end of [-1, 1]) {
    for (let i = 0; i < 7; i++) ribs.box(0.5, 0.03, 0.03, -halfW + 0.45, DECK + 0.3 + i * 0.38, end * (length / 2 + 0.03));
    for (const dx of [-0.25, 0.25]) ribs.box(0.03, 2.5, 0.03, -halfW + 0.45 + dx, DECK + 1.4, end * (length / 2 + 0.03));
  }
  const at = kit.transform(x, 0, z);
  const darkGeometry = dark.build();
  const ribGeometry = ribs.build();
  kit.add(m.steel, darkGeometry, at, 0x26282a);
  kit.add(m.steel, ribGeometry, at, paint);
  darkGeometry.dispose();
  ribGeometry.dispose();

  kit.box(m.cladding, WAGON_WIDTH, height, length, x, DECK, z, { tile: 1.6, color: paint });
  for (const side of [-1, 1]) {
    kit.box(m.cladding, 0.06, height - 0.3, 2.7, x + side * (halfW + 0.05), DECK + 0.1, z - 0.2, { tile: 1.1, color: paint });
  }
  // Shallow arched roof from three flat strips.
  kit.box(m.steel, WAGON_WIDTH * 0.5, 0.06, length + 0.1, x, DECK + height + 0.2, z, { color: 0x4a4744 });
  for (const side of [-1, 1]) {
    const from = V(x + side * WAGON_WIDTH * 0.25, DECK + height + 0.23, z);
    const to = V(x + side * (halfW + 0.06), DECK + height, z);
    kit.add(m.steel, UNIT_BOX, roofStrip(from, to, length + 0.1), 0x4a4744);
  }
  const name = logoGeometry('TERNMARK', 3.6);
  for (const side of [-1, 1]) {
    const facing = new THREE.Matrix4().makeRotationY((side * Math.PI) / 2).setPosition(x + side * (halfW + 0.045), DECK + 2.1, z + side * -3.6);
    kit.add(m.lettering, name, facing, 0xd9d5c8);
  }
  name.dispose();
  wagonColliders(kit, x, z, length, height + 0.25);
}

/** Thin slab spanning from `from` to `to` across the wagon and `length` along it. */
function roofStrip(from: THREE.Vector3, to: THREE.Vector3, length: number): THREE.Matrix4 {
  const across = new THREE.Vector3().subVectors(to, from);
  const width = across.length();
  const angle = Math.atan2(across.y, across.x);
  const centre = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
  return new THREE.Matrix4()
    .makeRotationZ(angle)
    .scale(new THREE.Vector3(width, 0.06, length))
    .setPosition(centre);
}

/** Steel plate ramp from the east strip up onto the deck of the north flat wagon. */
export function buildWagonRamp(kit: Kit, m: Materials): void {
  const wagon = WAGONS.flatB;
  // Centred between two stanchions.
  const z = wagon.z + 1.08;
  const top = V(wagon.x + WAGON_WIDTH / 2 - 0.05, DECK, z);
  const foot = V(wagon.x + WAGON_WIDTH / 2 + 3.3, 0, z);
  kit.beam(m.steel, foot, top, 1.5, 0.05, 0x5b6063);
  for (const side of [-1, 1]) {
    kit.beam(m.steel, V(foot.x, 0, z + side * 0.72), V(top.x, DECK, z + side * 0.72), 0.06, 0.14, 0xb98a12);
  }
  for (let t = 0.12; t < 1; t += 0.11) {
    kit.box(m.steel, 0.04, 0.02, 1.4, foot.x + (top.x - foot.x) * t, DECK * t + 0.02, z, { color: 0x3f4447 });
  }
  kit.box(m.wood, 0.9, DECK * 0.5, 1.3, (foot.x + top.x) / 2 - 0.3, 0, z, { color: 0x8a7a66 });
  kit.collideRamp(foot, top, 1.5, 0.25, 'metal');
}
