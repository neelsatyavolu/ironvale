import * as THREE from 'three/webgpu';
import { MeshBuilder } from './builder';
import type { Kit } from './kit';
import type { Materials } from './materials';
import { CONTAINER, TRAILER } from './plan';

const CHASSIS = 0x2c3136;
const RUBBER = 0x131415;
const WHEEL_RADIUS = 0.52;
const RIM = 0x62666a;

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

  // Two main beams, cross members and the bolsters the container locks onto.
  for (const side of [-1, 1]) steel.box(0.14, 0.34, half * 2, side * 0.5, deck - 0.17, 0);
  for (let s = -half + 0.6; s < half; s += 1.45) steel.box(1.0, 0.12, 0.1, 0, deck - 0.2, s);
  for (const end of [-half + 0.12, -half + 3.2, half - 3.2, half - 0.12]) steel.box(CONTAINER.width, 0.16, 0.22, 0, deck - 0.08, end);
  steel.box(1.3, 0.04, 1.6, 0, deck - 0.36, -half + 1.4);

  // Tandem axles with twin tyres, mudguards and the rear under-run bar.
  const tyre = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.6, 18).rotateZ(Math.PI / 2);
  const hubCap = new THREE.CylinderGeometry(0.2, 0.2, 0.63, 12).rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(0.33, 0.33, 0.56, 16).rotateZ(Math.PI / 2);
  for (const axle of [half - 2.2, half - 3.55]) {
    for (const side of [-1, 1]) {
      dark.add(tyre, new THREE.Matrix4().makeTranslation(side * 0.92, WHEEL_RADIUS, axle), RUBBER);
      steel.add(hubCap, new THREE.Matrix4().makeTranslation(side * 0.92, WHEEL_RADIUS, axle));
      dark.add(rim, new THREE.Matrix4().makeTranslation(side * 0.95, WHEEL_RADIUS, axle), RIM);
      steel.box(0.64, 0.03, 1.2, side * 0.92, WHEEL_RADIUS * 2 + 0.08, axle);
    }
    steel.box(1.3, 0.14, 0.14, 0, WHEEL_RADIUS, axle);
    steel.box(0.12, deck - 0.34 - WHEEL_RADIUS, 0.5, -0.5, (deck - 0.34 + WHEEL_RADIUS) / 2, axle);
    steel.box(0.12, deck - 0.34 - WHEEL_RADIUS, 0.5, 0.5, (deck - 0.34 + WHEEL_RADIUS) / 2, axle);
  }
  tyre.dispose();
  hubCap.dispose();
  rim.dispose();
  for (const side of [-1, 1]) dark.box(0.6, 0.5, 0.02, side * 0.92, 0.5, half - 1.5, RUBBER);
  steel.box(CONTAINER.width - 0.1, 0.12, 0.1, 0, 0.56, half - 0.1);
  for (const side of [-1, 1]) steel.box(0.08, deck - 0.9, 0.08, side * 0.5, (deck - 0.34 + 0.56) / 2, half - 0.1);

  // Landing legs with sand shoes and their cross brace.
  for (const side of [-1, 1]) {
    steel.box(0.13, deck - 0.34, 0.13, side * 0.62, (deck - 0.34) / 2, -half + 3.2);
    steel.box(0.34, 0.03, 0.34, side * 0.62, 0.015, -half + 3.2);
  }
  steel.box(1.3, 0.06, 0.06, 0, 0.5, -half + 3.2);

  const at = kit.transform(x, 0, z, yaw);
  const steelGeometry = steel.build();
  const darkGeometry = dark.build();
  kit.add(m.steel, steelGeometry, at, CHASSIS);
  kit.add(m.matte, darkGeometry, at);
  steelGeometry.dispose();
  darkGeometry.dispose();

  // Tail lights and a chevron board on the under-run bar.
  const local = (lx: number, ly: number, lz: number): THREE.Matrix4 => at.clone().multiply(new THREE.Matrix4().makeTranslation(lx, ly, lz));
  const lens = new THREE.BoxGeometry(0.2, 0.09, 0.02);
  for (const side of [-1, 1]) kit.add(m.matte, lens, local(side * 1.0, 0.72, half - 0.04), 0x5c1512);
  lens.dispose();
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
