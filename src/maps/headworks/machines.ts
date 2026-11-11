import * as THREE from 'three/webgpu';
import type { SignText } from './decals';
import { door, louvre, plate } from './fittings';
import { faceOf, inner, longSides } from './frame';
import { V, type Kit } from './kit';
import { COAT, type Materials } from './materials';
import { BLOCKS, isTwin, type Block } from './plan';

const T = (x: number, y: number, z: number): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(x, y, z);

const slabOf = (kit: Kit, material: THREE.Material, b: Block, bevel: number, color?: number): void =>
  kit.slab(material, b.x0, b.x1, b.y, b.y + b.h, b.z0, b.z1, bevel, color);

/**
 * Walk-in kiosk for switchgear, dosing sets or a generator: a coated steel
 * housing on a plinth with a capped roof, double doors on the long sides and
 * louvres on the ends.
 */
function buildKiosk(kit: Kit, m: Materials, b: Block): void {
  const generator = b.id.includes('generator');
  const dosing = b.id.includes('dosing');
  const coat = generator ? COAT.tealDark : dosing ? COAT.cream : isTwin(b) ? 0x6f8582 : COAT.grey;
  slabOf(kit, m.concrete, { ...b, h: 0.16 }, 0.03, 0xdcd9d1);
  slabOf(kit, m.paint, inner(b, 0.07, 0.16, b.h - 0.1), 0.03, coat);
  slabOf(kit, m.paint, { ...b, y: b.y + b.h - 0.1, h: 0.1 }, 0.03, generator ? COAT.black : 0x9aa3a6);
  const [long0, long1, end0, end1] = longSides(b);
  for (const side of [long0, long1]) {
    const face = faceOf(inner(b, 0.07, 0, b.h), side);
    const pairs = Math.max(1, Math.round(face.width / 2.6));
    for (let p = 0; p < pairs; p++) {
      const centre = -face.width / 2 + ((p + 0.5) / pairs) * face.width;
      for (const s of [-1, 1]) door(kit, m, face, centre + s * 0.46, 0.9, 0.24, b.h - 0.24, coat, s > 0 && !generator ? 3 : 0);
      louvre(kit, m, face, centre - 0.46, 0.62, 0.6, 0.42, coat);
    }
    plate(kit, m, face, 'DANGER  400 V', face.width / 2 - 0.5, b.h - 0.52, 0.72, 0.02);
  }
  for (const side of [end0, end1]) {
    const face = faceOf(inner(b, 0.07, 0, b.h), side);
    louvre(kit, m, face, 0, b.h * 0.56, Math.min(1.5, face.width - 0.6), b.h * 0.42, coat);
  }
  if (generator) {
    // Exhaust: a lagged stack with a rain flap, and the filler on the roof.
    const x = b.x0 + 0.8;
    const z = (b.z0 + b.z1) / 2;
    kit.tube(m.stainless, V(x, b.h, z), V(x, b.h + 1.3, z), 0.11, undefined, 12);
    kit.add(m.stainless, new THREE.CylinderGeometry(0.16, 0.16, 0.02, 12), T(x + 0.03, b.h + 1.36, z).multiply(new THREE.Matrix4().makeRotationZ(0.35)));
    kit.cast(m.paint, 0.5, 0.14, 0.5, T(b.x1 - 0.9, b.h + 0.07, z), 0.03, COAT.black);
  }
}

/** Row of floor-standing electrical cabinets under a shallow canopy, each with its door, vent, label and lamps. */
function buildCabinets(kit: Kit, m: Materials, b: Block): void {
  slabOf(kit, m.concrete, { ...b, h: 0.12 }, 0.03, 0xdcd9d1);
  const [front, back] = longSides(b);
  const body = inner(b, 0.05, 0.12, b.h - 0.06);
  slabOf(kit, m.paint, body, 0.02, isTwin(b) ? 0xb7b9b0 : COAT.cream);
  slabOf(kit, m.galvanised, { ...b, y: b.y + b.h - 0.06, h: 0.06 }, 0.015);
  const labels: readonly SignText[] = ['MCC-2', 'P-101', 'P-102', 'DANGER  400 V'];
  for (const side of [front, back]) {
    const face = faceOf(body, side);
    const count = Math.max(1, Math.round(face.width / 0.9));
    const pitch = face.width / count;
    for (let i = 0; i < count; i++) {
      const u = -face.width / 2 + (i + 0.5) * pitch;
      door(kit, m, face, u, pitch - 0.08, 0.1, body.h - 0.1, i % 4 === 3 ? COAT.grey : COAT.cream, 1 + ((i * 7) % 3));
      louvre(kit, m, face, u, 0.34, pitch - 0.3, 0.22, COAT.cream);
      if (i % 2 === 0) plate(kit, m, face, labels[(i / 2) % labels.length] as SignText, u, body.h - 0.42, Math.min(0.5, pitch - 0.2), 0.034);
    }
  }
  // Conduits drop from the canopy into the ground at one end.
  const end = faceOf(body, longSides(b)[2]);
  for (const u of [-0.2, -0.05, 0.1]) kit.tube(m.galvanised, end.point(u, 0, 0.04), end.point(u, body.h - 0.05, 0.04), 0.016, undefined, 6);
}

/** Low precast block: lifting eyes cast into the top and a band of warning paint. Crouch cover. */
function buildBarrier(kit: Kit, m: Materials, b: Block, index: number): void {
  slabOf(kit, m.concrete, b, 0.09, index % 2 === 0 ? 0xe8e6e0 : 0xd6d4cd);
  const [front, back] = longSides(b);
  for (const side of [front, back]) {
    const face = faceOf(b, side);
    kit.cast(m.hazard, face.width - 0.24, 0.2, 0.008, face.at(0, b.h - 0.3, 0.003), 0.002);
  }
  const alongX = b.x1 - b.x0 > b.z1 - b.z0;
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const reach = (alongX ? b.x1 - b.x0 : b.z1 - b.z0) / 2 - 0.35;
  for (const s of [-1, 1]) {
    const eye = new THREE.TorusGeometry(0.06, 0.012, 5, 10, Math.PI);
    kit.add(m.galvanised, eye, new THREE.Matrix4().makeRotationY(alongX ? Math.PI / 2 : 0).setPosition(cx + (alongX ? s * reach : 0), b.h - 0.005, cz + (alongX ? 0 : s * reach)));
    eye.dispose();
  }
}

/** Sampling station on a plinth: a stainless cabinet with a gauge, a tap and a drain pot. Crouch cover. */
function buildStation(kit: Kit, m: Materials, b: Block): void {
  slabOf(kit, m.concrete, { ...b, h: 0.42 }, 0.06, 0xe2e0d9);
  const body = inner(b, 0.12, 0.42, b.h);
  // Painted, not bare: a polished box this size throws the sun straight into the lane.
  slabOf(kit, m.paint, body, 0.02, COAT.tealDark);
  const [front] = longSides(b);
  const face = faceOf(body, front);
  door(kit, m, face, -face.width / 4, face.width / 2 - 0.1, 0.06, body.h - 0.06, 0xb8bcbf, 2);
  const gauge = new THREE.CylinderGeometry(0.07, 0.07, 0.04, 14).rotateX(Math.PI / 2);
  kit.add(m.matte, gauge, face.at(face.width / 4, body.h * 0.62, 0.03), 0xe8e8e4);
  kit.add(m.galvanised, new THREE.TorusGeometry(0.07, 0.01, 5, 14), face.at(face.width / 4, body.h * 0.62, 0.05));
  kit.tube(m.stainless, face.point(face.width / 4, body.h * 0.3, 0), face.point(face.width / 4, body.h * 0.3, 0.12), 0.014, undefined, 6);
  kit.tube(m.stainless, face.point(face.width / 4, body.h * 0.3, 0.12), face.point(face.width / 4, body.h * 0.18, 0.12), 0.014, undefined, 6);
}

/** Housings, cabinets and low blocks from the plan. The pipework plant is in plant.ts. */
export function buildMachines(kit: Kit, m: Materials): void {
  let barriers = 0;
  for (const b of BLOCKS) {
    if (b.role === 'kiosk') buildKiosk(kit, m, b);
    else if (b.role === 'cabinet') buildCabinets(kit, m, b);
    else if (b.role === 'barrier') buildBarrier(kit, m, b, barriers++);
    else if (b.role === 'plinth') buildStation(kit, m, b);
  }
}
