import * as THREE from 'three/webgpu';
import { MeshBuilder } from './builder';
import type { Kit } from './kit';
import type { Materials } from './materials';
import { CONTAINER, TRAILER } from './plan';
import { addWheel, rod } from './shapes';

const CHASSIS = 0x2c3136;
const RUBBER = 0x131415;
const WHEEL_RADIUS = 0.52;

/**
 * Skeletal container trailer standing on its landing legs. Local +Z is the
 * rear. The container it carries comes from the container plan; this adds the
 * chassis under it. Shots pass under the frame between the legs and the
 * wheels; nobody can walk through.
 */
export function buildTrailer(kit: Kit, m: Materials): void {
  const { x, z, yaw, deck } = TRAILER;
  const half = CONTAINER.length40 / 2;
  const steel = new MeshBuilder();
  const dark = new MeshBuilder();
  // Parts that keep their own colour instead of the chassis paint: rims, hubs, twist locks.
  const bright = new MeshBuilder();

  // Two main beams, cross members and the bolsters the container locks onto.
  for (const side of [-1, 1]) steel.box(0.14, 0.34, half * 2, side * 0.5, deck - 0.17, 0);
  for (let s = -half + 0.6; s < half; s += 1.45) steel.box(1.0, 0.12, 0.1, 0, deck - 0.2, s);
  for (const end of [-half + 0.12, -half + 3.2, half - 3.2, half - 0.12]) steel.box(CONTAINER.width, 0.16, 0.22, 0, deck - 0.08, end);
  steel.box(1.3, 0.04, 1.6, 0, deck - 0.36, -half + 1.4);

  // Tandem axles on twin tyres, each pair under a mudguard with turned-down ends, and the rear under-run bar.
  for (const axle of [half - 2.2, half - 3.55]) {
    for (const side of [-1, 1]) {
      for (const offset of [0.76, 1.07]) {
        addWheel(dark, bright, [side * offset, WHEEL_RADIUS, axle], WHEEL_RADIUS, 0.29, side, { tyre: RUBBER, rim: 0x777a7c, hub: 0x5c2a22 });
      }
      steel.box(0.66, 0.025, 0.86, side * 0.92, WHEEL_RADIUS * 2 + 0.08, axle);
      for (const end of [-1, 1]) steel.box(0.66, 0.025, 0.3, side * 0.92, WHEEL_RADIUS * 2 - 0.005, axle + end * 0.55, 0xffffff, [end * 0.62, 0, 0]);
    }
    rod(steel, [-0.7, WHEEL_RADIUS, axle], [0.7, WHEEL_RADIUS, axle], 0.07, 0xffffff, 8);
    // Spring hangers and the air bag between axle and frame.
    for (const side of [-1, 1]) {
      steel.box(0.12, deck - 0.34 - WHEEL_RADIUS, 0.5, side * 0.5, (deck - 0.34 + WHEEL_RADIUS) / 2, axle);
      rod(dark, [side * 0.34, WHEEL_RADIUS + 0.07, axle + 0.3], [side * 0.34, deck - 0.36, axle + 0.3], 0.1, RUBBER, 10);
    }
  }
  for (const side of [-1, 1]) dark.box(0.62, 0.48, 0.015, side * 0.92, 0.47, half - 1.52, RUBBER);
  steel.box(CONTAINER.width - 0.1, 0.12, 0.1, 0, 0.56, half - 0.1);
  for (const side of [-1, 1]) steel.box(0.08, deck - 0.9, 0.08, side * 0.5, (deck - 0.34 + 0.56) / 2, half - 0.1);
  // Light bar across the rear, twist locks at the bolster ends.
  steel.box(CONTAINER.width - 0.2, 0.14, 0.05, 0, 0.78, half - 0.06);
  for (const end of [-half + 0.12, half - 0.12]) {
    for (const side of [-1, 1]) bright.box(0.16, 0.1, 0.16, side * (CONTAINER.width / 2 - 0.1), deck + 0.03, end, 0x4a4d50);
  }
  // Coiled air and electric lines hanging on the front bulkhead.
  steel.box(1.3, 0.5, 0.05, 0, deck - 0.1, -half + 0.03);
  for (const [lx, color] of [[-0.22, 0x7a1512], [0, 0x17191b], [0.22, 0x2b4e6b]] as const) {
    rod(dark, [lx, deck - 0.02, -half - 0.02], [lx + 0.05, deck - 0.5, -half - 0.05], 0.022, color, 6);
  }

  // Landing legs with sand shoes and their cross brace.
  for (const side of [-1, 1]) {
    steel.box(0.13, deck - 0.34, 0.13, side * 0.62, (deck - 0.34) / 2, -half + 3.2);
    steel.box(0.34, 0.03, 0.34, side * 0.62, 0.015, -half + 3.2);
  }
  steel.box(1.3, 0.06, 0.06, 0, 0.5, -half + 3.2);
  // Winding gear: gearbox on the near leg and its crank handle.
  steel.box(0.16, 0.2, 0.14, 0.76, 0.62, -half + 3.2);
  rod(steel, [0.84, 0.62, -half + 3.2], [1.06, 0.62, -half + 3.2], 0.014, 0xffffff, 6);
  rod(steel, [1.06, 0.62, -half + 3.2], [1.06, 0.4, -half + 3.2], 0.014, 0xffffff, 6);

  const at = kit.transform(x, 0, z, yaw);
  const steelGeometry = steel.build();
  const darkGeometry = dark.build();
  const brightGeometry = bright.build();
  kit.add(m.steel, steelGeometry, at, CHASSIS);
  kit.add(m.matte, darkGeometry, at);
  kit.add(m.steel, brightGeometry, at);
  brightGeometry.dispose();
  steelGeometry.dispose();
  darkGeometry.dispose();

  // Tail lights and a chevron board on the under-run bar.
  const local = (lx: number, ly: number, lz: number): THREE.Matrix4 => at.clone().multiply(new THREE.Matrix4().makeTranslation(lx, ly, lz));
  const lens = new THREE.BoxGeometry(0.11, 0.09, 0.02);
  for (const side of [-1, 1]) {
    // Stop and tail (lit dull red), indicator and reversing lenses.
    kit.add(m.lamp, lens, local(side * 1.03, 0.85, half - 0.03), 0x5a0d08);
    kit.add(m.matte, lens, local(side * 0.9, 0.85, half - 0.03), 0xa35a12);
    kit.add(m.matte, lens, local(side * 0.77, 0.85, half - 0.03), 0xc9c8c0);
  }
  lens.dispose();
  const marker = new THREE.BoxGeometry(0.02, 0.035, 0.08);
  for (const side of [-1, 1]) {
    for (let s = -half + 1.5; s < half - 4.5; s += 2.4) kit.add(m.lamp, marker, local(side * 0.585, deck - 0.2, s), 0x3d2204);
  }
  marker.dispose();
  const plate = new THREE.BoxGeometry(0.48, 0.11, 0.012);
  kit.add(m.matte, plate, local(0, 0.86, half - 0.03), 0xd9d6cc);
  plate.dispose();
  const board = new THREE.BoxGeometry(1.4, 0.2, 0.012);
  kit.add(m.hazard, board, local(0, 0.56, half - 0.035));
  board.dispose();

  // Colliders: frame, wheel sets and legs. Local offsets are turned into world space by hand.
  const place = (lx: number, lz: number): [number, number] => [x + lx * Math.cos(yaw) + lz * Math.sin(yaw), z - lx * Math.sin(yaw) + lz * Math.cos(yaw)];
  kit.collide(1.3, 0.45, half * 2, x, deck - 0.45, z, 'metal', yaw);
  const [wx, wz] = place(0, half - 2.9);
  kit.collide(CONTAINER.width, deck - 0.3, 2.6, wx, 0, wz, 'metal', yaw);
  const [lx, lz] = place(0, -half + 3.2);
  kit.collide(1.5, deck - 0.3, 0.3, lx, 0, lz, 'metal', yaw);
}
