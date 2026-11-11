import * as THREE from 'three/webgpu';
import { MeshBuilder } from './builder';
import type { Kit } from './kit';
import type { Materials } from './materials';
import { addChamferBox, addWheel, rod, strut } from './shapes';

const YELLOW = 0xd2a018;
const FRAME = 0x26282a;
const RUBBER = 0x131415;
const SEAT = 0x1b1c1e;
const FORK_STEEL = 0x4d5052;
const CHROME = 0xc9cdd0;
const TANK = 0x9aa0a2;

/**
 * Counterbalance forklift truck, 2.5 tonne class, parked with the forks down.
 * Forks point along local -Z. Built from chamfered pressings: chassis, rounded
 * counterweight with the gas bottle across it, engine hood and seat, overhead
 * guard, two-stage mast with ram, chains, carriage and load backrest, and
 * wheels with tyres, rims and nuts. The colliders are the ones the first,
 * box-built truck had, so cover and paths are unchanged.
 */
export function buildForklift(kit: Kit, m: Materials, x: number, z: number, yaw: number): void {
  const paint = new MeshBuilder();
  const dark = new MeshBuilder();
  const bare = new MeshBuilder();

  // Chassis, front fenders, hood, dash cowl and the counterweight.
  addChamferBox(paint, [1.08, 0.5, 1.42], [0, 0.63, 0.12], YELLOW, 0.05);
  addChamferBox(paint, [0.6, 0.3, 0.7], [0, 0.42, 0.95], FRAME, 0.04);
  for (const side of [-1, 1]) {
    addChamferBox(paint, [0.27, 0.09, 0.84], [side * 0.5, 0.78, -0.5], YELLOW, 0.035);
    addChamferBox(paint, [0.27, 0.3, 0.07], [side * 0.5, 0.66, -0.12], YELLOW, 0.025);
    paint.box(0.008, 0.11, 1.16, side * 0.542, 0.7, 0.14, FRAME);
    paint.box(0.3, 0.035, 0.3, side * 0.4, 0.45, 0.22, FRAME);
  }
  addChamferBox(paint, [0.96, 0.3, 0.8], [0, 1.02, 0.48], YELLOW, 0.07);
  addChamferBox(paint, [0.9, 0.46, 0.14], [0, 1.1, -0.4], YELLOW, 0.04, [-0.12, 0, 0]);
  addChamferBox(paint, [1.1, 0.64, 0.54], [0, 0.82, 1.09], YELLOW, 0.13);
  paint.box(1.0, 0.035, 0.5, 0, 0.895, -0.14, FRAME);
  // Louvres in the hood sides and a grab handle on the cowl.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) dark.box(0.012, 0.022, 0.42, side * 0.482, 0.95 + i * 0.045, 0.5, SEAT);
  }
  rod(bare, [-0.36, 1.34, -0.4], [-0.2, 1.34, -0.4], 0.012, CHROME, 6);

  // Seat, steering column and wheel, and the hydraulic levers.
  addChamferBox(dark, [0.46, 0.1, 0.44], [0, 1.22, 0.46], SEAT, 0.035);
  addChamferBox(dark, [0.46, 0.52, 0.1], [0, 1.5, 0.72], SEAT, 0.035, [-0.16, 0, 0]);
  rod(dark, [0, 1.0, -0.36], [0, 1.4, -0.14], 0.03, SEAT, 8);
  const steering = new THREE.TorusGeometry(0.16, 0.017, 6, 16).rotateX(-1.05);
  dark.add(steering, new THREE.Matrix4().makeTranslation(0, 1.41, -0.13), SEAT);
  steering.dispose();
  for (const lx of [0.26, 0.33, 0.4]) {
    rod(bare, [lx, 1.2, -0.38], [lx, 1.42, -0.34], 0.009, CHROME, 6);
    dark.box(0.03, 0.04, 0.03, lx, 1.44, -0.337, SEAT);
  }

  // Overhead guard: raked front posts, rear posts off the counterweight, side rails and cross bars.
  for (const side of [-1, 1]) {
    strut(paint, [side * 0.5, 0.84, -0.46], [side * 0.48, 2.12, -0.24], 0.055, FRAME);
    strut(paint, [side * 0.5, 1.1, 0.96], [side * 0.48, 2.12, 0.84], 0.055, FRAME);
    strut(paint, [side * 0.48, 2.12, -0.27], [side * 0.48, 2.12, 0.87], 0.055, FRAME, 0.06);
  }
  for (let i = 0; i <= 6; i++) paint.box(0.96, 0.035, 0.045, 0, 2.125, -0.24 + i * 0.18, FRAME);

  // Mast: outer and inner channels, cross ties, lift ram, chains and the two tilt rams.
  for (const side of [-1, 1]) {
    paint.box(0.09, 2.14, 0.13, side * 0.37, 1.14, -0.9, FRAME);
    paint.box(0.03, 2.14, 0.05, side * 0.4, 1.14, -0.82, FRAME);
    paint.box(0.065, 2.14, 0.1, side * 0.28, 1.25, -0.92, FRAME);
    dark.box(0.028, 1.7, 0.018, side * 0.1, 1.25, -0.985, SEAT);
    rod(bare, [side * 0.42, 0.74, -0.3], [side * 0.39, 1.12, -0.84], 0.028, CHROME, 8);
    rod(paint, [side * 0.42, 0.74, -0.3], [side * 0.405, 0.93, -0.57], 0.04, FRAME, 8);
  }
  for (const y of [0.42, 1.2, 2.17]) paint.box(0.83, 0.09, 0.09, 0, y, -0.9, FRAME);
  paint.box(0.6, 0.07, 0.08, 0, 2.3, -0.92, FRAME);
  rod(bare, [0, 0.3, -0.9], [0, 2.14, -0.9], 0.045, CHROME, 10);
  rod(paint, [0, 0.2, -0.9], [0, 1.1, -0.9], 0.06, FRAME, 10);

  // Carriage, load backrest and forks.
  for (const y of [0.3, 0.64]) paint.box(0.98, 0.11, 0.045, 0, y, -1.0, FRAME);
  for (const lx of [-0.47, 0.47]) paint.box(0.045, 1.2, 0.035, lx, 0.87, -1.01, FRAME);
  paint.box(0.98, 0.04, 0.035, 0, 1.47, -1.01, FRAME);
  for (let lx = -0.36; lx <= 0.37; lx += 0.18) paint.box(0.022, 0.78, 0.022, lx, 1.07, -1.01, FRAME);
  for (const side of [-1, 1]) {
    bare.box(0.1, 0.62, 0.042, side * 0.25, 0.36, -1.045, FORK_STEEL);
    bare.box(0.1, 0.042, 0.9, side * 0.25, 0.071, -1.44, FORK_STEEL);
    // Tapered tip.
    bare.box(0.1, 0.03, 0.16, side * 0.25, 0.062, -1.955, FORK_STEEL, [0.07, 0, 0]);
  }

  // Wheels: big drive tyres at the mast, smaller steer tyres under the counterweight.
  for (const side of [-1, 1]) {
    addWheel(dark, paint, [side * 0.5, 0.33, -0.5], 0.33, 0.26, side, { tyre: RUBBER, rim: YELLOW, hub: FRAME });
    addWheel(dark, paint, [side * 0.47, 0.26, 0.93], 0.26, 0.2, side, { tyre: RUBBER, rim: YELLOW, hub: FRAME });
  }

  // Gas bottle strapped across the counterweight, with its bracket and hose.
  const bottle = new THREE.CylinderGeometry(0.15, 0.15, 0.66, 16).rotateZ(Math.PI / 2);
  paint.add(bottle, new THREE.Matrix4().makeTranslation(0, 1.31, 1.08), TANK);
  bottle.dispose();
  const dome = new THREE.SphereGeometry(0.15, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  for (const side of [-1, 1]) {
    paint.add(dome, new THREE.Matrix4().makeRotationZ((-side * Math.PI) / 2).setPosition(side * 0.33, 1.31, 1.08), TANK);
    dark.box(0.035, 0.33, 0.34, side * 0.19, 1.3, 1.08, SEAT);
  }
  dome.dispose();
  rod(dark, [0.46, 1.31, 1.08], [0.44, 1.14, 0.82], 0.012, SEAT, 5);

  // Rear: red tail lights, a hazard band and the tow pin.
  for (const side of [-1, 1]) dark.box(0.13, 0.07, 0.02, side * 0.4, 1.0, 1.362, 0x5c1512);
  rod(bare, [0, 0.52, 1.37], [0, 0.7, 1.37], 0.02, FORK_STEEL, 6);

  const at = kit.transform(x, 0, z, yaw);
  const place = (material: THREE.Material, builder: MeshBuilder): void => {
    const geometry = builder.build();
    kit.add(material, geometry, at);
    geometry.dispose();
  };
  place(m.steel, paint);
  place(m.matte, dark);
  place(m.rawSteel, bare);

  const local = (lx: number, ly: number, lz: number): THREE.Matrix4 => at.clone().multiply(new THREE.Matrix4().makeTranslation(lx, ly, lz));
  const band = new THREE.BoxGeometry(0.86, 0.1, 0.012);
  kit.add(m.hazard, band, local(0, 0.66, 1.362));
  band.dispose();
  // Amber beacon on the guard and two work lamps on the front posts (off: dull lenses).
  const beacon = new THREE.CylinderGeometry(0.05, 0.055, 0.09, 10);
  kit.add(m.lamp, beacon, local(0.4, 2.19, 0.78), 0xff8a1a);
  beacon.dispose();
  const lens = new THREE.CylinderGeometry(0.055, 0.055, 0.05, 12).rotateX(Math.PI / 2);
  for (const side of [-1, 1]) {
    kit.add(m.matte, lens, local(side * 0.49, 1.92, -0.32), SEAT);
    kit.add(m.lamp, lens, local(side * 0.49, 1.92, -0.33).multiply(new THREE.Matrix4().makeScale(0.8, 0.8, 0.9)), 0x2c2a22);
  }
  lens.dispose();

  kit.collide(1.2, 2.15, 2.1, x - Math.sin(yaw) * -0.25, 0, z - Math.cos(yaw) * -0.25, 'metal', yaw);
  kit.collide(0.7, 0.14, 1.1, x - Math.sin(yaw) * 1.5, 0, z - Math.cos(yaw) * 1.5, 'metal', yaw);
}
