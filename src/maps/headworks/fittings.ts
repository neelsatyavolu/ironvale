import * as THREE from 'three/webgpu';
import { signGeometry, type SignText } from './decals';
import type { Face } from './frame';
import type { Kit } from './kit';
import { COAT, type Materials } from './materials';
import { pipeRun } from './parts';

/**
 * Things fixed to a face of a wall or a housing: doors, louvres, sign plates,
 * outlets with the stains under them, downpipes and ladders.
 */

const INDICATORS = [0x58ff7a, 0xffb02e, 0xff4634] as const;
export const STAIN = { algae: 0x2a2d24, scale: 0xdcddd4, rust: 0x5e3b22, damp: 0x4a4a44 } as const;

export function plate(kit: Kit, m: Materials, face: Face, text: SignText, u: number, y: number, width: number, out = 0.012): void {
  const geometry = signGeometry(text, width);
  kit.add(m.sign, geometry, face.at(u, y, out));
  geometry.dispose();
}

/** Bank of fixed louvre blades in a frame, `width` by `height`, centred at (u, y) on a face. */
export function louvre(kit: Kit, m: Materials, face: Face, u: number, y: number, width: number, height: number, color: number): void {
  kit.cast(m.paint, width, height, 0.03, face.at(u, y, 0.012), 0.008, COAT.black);
  const blades = Math.max(3, Math.round(height / 0.07));
  const tilt = new THREE.Matrix4().makeRotationX(0.6);
  for (let i = 0; i < blades; i++) {
    const by = y - height / 2 + ((i + 0.5) / blades) * height;
    kit.add(m.paint, new THREE.BoxGeometry(width - 0.04, 0.012, 0.06), face.at(u, by, 0.04).multiply(tilt), color);
  }
  for (const s of [-1, 1]) kit.cast(m.paint, 0.03, height + 0.03, 0.06, face.at(u + (s * width) / 2, y, 0.03), 0.005, color);
}

/** Door leaf with a rebate round it, hinges, a handle and an optional row of indicator lamps above. */
export function door(kit: Kit, m: Materials, face: Face, u: number, width: number, bottom: number, top: number, color: number, lamps: number): void {
  const mid = (bottom + top) / 2;
  kit.cast(m.paint, width + 0.04, top - bottom + 0.04, 0.012, face.at(u, mid, 0.004), 0.004, COAT.black);
  kit.cast(m.paint, width - 0.02, top - bottom - 0.02, 0.03, face.at(u, mid, 0.014), 0.01, color);
  kit.cast(m.stainless, 0.03, 0.16, 0.035, face.at(u + width / 2 - 0.09, mid, 0.04), 0.006);
  for (const hy of [bottom + 0.2, top - 0.2]) kit.cast(m.galvanised, 0.03, 0.1, 0.03, face.at(u - width / 2 + 0.01, hy, 0.03), 0.004);
  for (let i = 0; i < lamps; i++) {
    kit.add(m.lamp, new THREE.CylinderGeometry(0.022, 0.022, 0.02, 10).rotateX(Math.PI / 2), face.at(u - 0.12 + i * 0.12, top - 0.2, 0.04), INDICATORS[i % 3]);
    kit.cast(m.paint, 0.07, 0.07, 0.01, face.at(u - 0.12 + i * 0.12, top - 0.2, 0.031), 0.003, COAT.black);
  }
}


/** Lettering sprayed straight onto a wall through a stencil. */
export function stencil(kit: Kit, m: Materials, face: Face, text: SignText, u: number, y: number, width: number, color = 0x3b3f42): void {
  const geometry = signGeometry(text, width, true);
  kit.add(m.sign, geometry, face.at(u, y, 0.008), color);
  geometry.dispose();
}

/** Run-off streak hanging `drop` metres below (u, top) on a face. */
export function streak(kit: Kit, m: Materials, face: Face, u: number, top: number, width: number, drop: number, color: number, out = 0.012): void {
  const geometry = new THREE.PlaneGeometry(width, drop);
  kit.add(m.runOff, geometry, face.at(u, top - drop / 2, out), color);
  geometry.dispose();
}

/**
 * Pipe stub through a wall with a flanged end, and what has run out of it:
 * dark growth down the wall, a paler scale line and a damp blot on the ground.
 */
export function outlet(kit: Kit, m: Materials, face: Face, u: number, y: number, r: number): void {
  pipeRun(kit, m.stainless, [face.point(u, y, -0.05), face.point(u, y, r * 1.5)], r, undefined, 0.1);
  streak(kit, m, face, u + kit.range(-0.05, 0.05), y - r * 0.6, r * kit.range(4.5, 7), y - r * 0.6, STAIN.algae);
  streak(kit, m, face, u + kit.range(-0.08, 0.08), y - r * 0.8, r * kit.range(1.5, 2.6), (y - r) * kit.range(0.5, 0.9), STAIN.scale, 0.016);
  const blot = new THREE.PlaneGeometry(r * 9, r * 7).rotateX(-Math.PI / 2);
  const foot = face.point(u, 0.02, r * 3);
  kit.add(m.stain, blot, new THREE.Matrix4().makeTranslation(foot.x, 0.022, foot.z), STAIN.damp);
  blot.dispose();
}

/** Rainwater pipe from `top` to a shoe at the foot of the wall, on brackets, with the splash it leaves. */
export function downpipe(kit: Kit, m: Materials, face: Face, u: number, top: number): void {
  kit.tube(m.galvanised, face.point(u, 0.18, 0.07), face.point(u, top, 0.07), 0.05, undefined, 10);
  kit.tube(m.galvanised, face.point(u, 0.18, 0.07), face.point(u, 0.06, 0.2), 0.05, undefined, 10);
  for (let y = 0.6; y < top; y += 1.5) kit.cast(m.galvanised, 0.16, 0.035, 0.09, face.at(u, y, 0.045), 0.004);
  kit.cast(m.galvanised, 0.2, 0.18, 0.16, face.at(u, top + 0.05, 0.08), 0.02);
  streak(kit, m, face, u + 0.1, 0.9, 0.5, 0.9, STAIN.rust, 0.008);
  const blot = new THREE.PlaneGeometry(1.1, 0.9).rotateX(-Math.PI / 2);
  const foot = face.point(u, 0.02, 0.5);
  kit.add(m.stain, blot, new THREE.Matrix4().makeTranslation(foot.x, 0.022, foot.z), STAIN.damp);
  blot.dispose();
}

/** Fixed access ladder with a safety hoop at the top, from `bottom` to `top`. */
export function ladder(kit: Kit, m: Materials, face: Face, u: number, bottom: number, top: number): void {
  for (const s of [-0.21, 0.21]) kit.tube(m.galvanised, face.point(u + s, bottom, 0.14), face.point(u + s, top + 1, 0.14), 0.02, undefined, 6);
  for (let y = bottom + 0.3; y < top + 0.9; y += 0.28) kit.tube(m.galvanised, face.point(u - 0.21, y, 0.14), face.point(u + 0.21, y, 0.14), 0.013, undefined, 5);
  for (let y = bottom + 0.4; y < top; y += 1.6) for (const s of [-0.21, 0.21]) kit.tube(m.galvanised, face.point(u + s, y, 0), face.point(u + s, y, 0.14), 0.012, undefined, 5);
  streak(kit, m, face, u, top - 0.1, 0.5, Math.min(1.4, top - bottom), STAIN.rust, 0.008);
}

/** Steel personnel door in a frame, with a bulkhead-height sign above it when `label` is given. */
export function steelDoor(kit: Kit, m: Materials, face: Face, u: number, label?: SignText): void {
  kit.cast(m.paint, 1.14, 2.2, 0.05, face.at(u, 1.1, 0.01), 0.01, COAT.black);
  door(kit, m, face, u, 0.98, 0.04, 2.1, COAT.door, 0);
  kit.cast(m.hazard, 1.0, 0.12, 0.012, face.at(u, 0.14, 0.036), 0.002);
  if (label) plate(kit, m, face, label, u, 2.42, 1.1, 0.02);
}
