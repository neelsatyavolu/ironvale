import * as THREE from 'three/webgpu';
import { V, type Kit } from './kit';
import { COAT, type Materials } from './materials';
import { HALF_X, HALF_Z } from './plan';

/** A run along a wall face: from (x0, z0) to (x1, z1) at height y, the wall facing along (nx, nz). */
type Run = readonly [x0: number, z0: number, x1: number, z1: number, y: number, nx: number, nz: number];

/** Cable tray runs of the west half, each on the wall that carries a row of lamps. */
const TRAYS: readonly Run[] = [
  [-HALF_X, -38, -HALF_X, 38, 4.15, 1, 0],
  [-34, -9.5, -34, 9.5, 4.35, 1, 0],
  [-19.8, -19, -4.7, -19, 4.15, 0, 1],
  [-38.3, -23, -27.2, -23, 4.15, 0, -1],
  [-29.8, 20, -23.5, 20, 4.15, 0, -1],
  [-46, HALF_Z, -28.5, HALF_Z, 4.15, 0, -1],
];

/** Hose reels on walls near the wash-down points: [x, z, nx, nz]. */
const REELS: readonly (readonly [number, number, number, number])[] = [
  [-34, -8, 1, 0],
  [-HALF_X, 24, 1, 0],
  [-9, -19, 0, 1],
  [-33, -23, 0, -1],
];

/** Junction boxes with a conduit drop to the ground: [x, z, nx, nz]. */
const BOXES: readonly (readonly [number, number, number, number])[] = [
  [-34, 1.5, 1, 0],
  [-HALF_X, -22, 1, 0],
  [-HALF_X, 6, 1, 0],
  [-17, -19, 0, 1],
  [-40, HALF_Z, 0, -1],
];

const TRAY_OUT = 0.26;

/** Perforated tray on cantilever brackets carrying a few black cables, with a clip band every couple of metres. */
function tray(kit: Kit, m: Materials, [x0, z0, x1, z1, y, nx, nz]: Run): void {
  const out = (d: number, x: number, z: number, h: number): THREE.Vector3 => V(x + nx * d, h, z + nz * d);
  const length = Math.hypot(x1 - x0, z1 - z0);
  const [ux, uz] = [(x1 - x0) / length, (z1 - z0) / length];
  kit.beam(m.galvanised, out(TRAY_OUT / 2 + 0.03, x0, z0, y), out(TRAY_OUT / 2 + 0.03, x1, z1, y), TRAY_OUT, 0.015);
  for (const d of [0.03, TRAY_OUT + 0.03]) kit.beam(m.galvanised, out(d, x0, z0, y + 0.03), out(d, x1, z1, y + 0.03), 0.012, 0.06);
  // Cables do not lie dead straight: each is laid in short lengths that wander a little across the tray.
  const cables: readonly (readonly [number, number, number])[] = [
    [0.08, 0.022, COAT.black],
    [0.14, 0.016, 0x2a2c2e],
    [0.19, 0.02, COAT.black],
    [0.235, 0.012, 0x6f2f24],
  ];
  const steps = Math.max(1, Math.round(length / 3));
  cables.forEach(([d, r, color], index) => {
    for (let i = 0; i < steps; i++) {
      const drift = (k: number): number => d + Math.sin(k * 1.7 + index * 2.1) * 0.012;
      const [t0, t1] = [(i / steps) * length, ((i + 1) / steps) * length];
      kit.tube(m.matte, out(drift(i), x0 + ux * t0, z0 + uz * t0, y + 0.008 + r), out(drift(i + 1), x0 + ux * t1, z0 + uz * t1, y + 0.008 + r), r, color, 5);
    }
  });
  for (let t = 0.6; t < length; t += 2.4) {
    const [x, z] = [x0 + ux * t, z0 + uz * t];
    kit.beam(m.galvanised, out(0, x, z, y - 0.025), out(TRAY_OUT + 0.05, x, z, y - 0.025), 0.04, 0.035);
    kit.beam(m.galvanised, out(0.02, x, z, y - 0.2), out(TRAY_OUT, x, z, y - 0.04), 0.03, 0.03);
    kit.beam(m.galvanised, out(0.012, x, z, y - 0.24), out(0.012, x, z, y + 0.02), 0.05, 0.02);
  }
}

/** Wall-hung hose reel: a red drum of coiled hose on a bracket, the nozzle hooked beside it and a tap below. */
function reel(kit: Kit, m: Materials, x: number, z: number, nx: number, nz: number): void {
  const yaw = Math.atan2(nx, nz);
  const pose = new THREE.Matrix4().makeRotationY(yaw).setPosition(x + nx * 0.09, 1.25, z + nz * 0.09);
  const drum = new THREE.CylinderGeometry(0.27, 0.27, 0.025, 20).rotateX(Math.PI / 2);
  for (const d of [-0.055, 0.055]) kit.add(m.paint, drum.clone().translate(0, 0, d), pose, COAT.red);
  drum.dispose();
  for (let i = 0; i < 3; i++) {
    const coil = new THREE.TorusGeometry(0.16 + i * 0.035, 0.019, 6, 24).translate(0, 0, (i - 1) * 0.022);
    kit.add(m.matte, coil, pose, 0x23262a);
    coil.dispose();
  }
  kit.box(m.galvanised, 0.1, 0.5, 0.05, x + nx * 0.025, 1, z + nz * 0.025, undefined, yaw);
  // The loose end drops to a brass nozzle hung on a hook; a tap and its pipe feed the reel from below.
  const side = (d: number, o: number, y: number): THREE.Vector3 => V(x + nx * o + nz * d, y, z + nz * o - nx * d);
  kit.tube(m.matte, side(0.24, 0.09, 1.2), side(0.36, 0.06, 0.78), 0.019, 0x23262a, 6);
  kit.tube(m.paint, side(0.36, 0.06, 0.62), side(0.36, 0.06, 0.8), 0.024, COAT.yellow, 6);
  kit.tube(m.galvanised, side(-0.02, 0.04, 0.05), side(-0.02, 0.04, 0.98), 0.016, undefined, 6);
  kit.box(m.paint, 0.07, 0.07, 0.07, ...(side(-0.02, 0.05, 0.52).toArray() as [number, number, number]), COAT.red, yaw);
}

/** Grey junction box with a lid, gland and conduit, and a rust weep from its fixings. */
function junction(kit: Kit, m: Materials, x: number, z: number, nx: number, nz: number): void {
  const yaw = Math.atan2(nx, nz);
  kit.box(m.paint, 0.34, 0.44, 0.14, x + nx * 0.07, 1.35, z + nz * 0.07, COAT.grey, yaw);
  kit.box(m.paint, 0.3, 0.4, 0.02, x + nx * 0.15, 1.37, z + nz * 0.15, COAT.cream, yaw);
  kit.box(m.lamp, 0.025, 0.025, 0.012, x + nx * 0.162 + nz * 0.1, 1.7, z + nz * 0.162 - nx * 0.1, 0x38d060, yaw);
  kit.tube(m.galvanised, V(x + nx * 0.05, 1.79, z + nz * 0.05), V(x + nx * 0.05, 4.1, z + nz * 0.05), 0.014, undefined, 6);
  kit.tube(m.galvanised, V(x + nx * 0.05 + nz * 0.08, 0.02, z + nz * 0.05 - nx * 0.08), V(x + nx * 0.05 + nz * 0.08, 1.35, z + nz * 0.05 - nx * 0.08), 0.014, undefined, 6);
}

/**
 * Building services fixed to the walls: cable trays under the copings, hose
 * reels and junction boxes. All of it hangs within a hand's width of a wall
 * or above head height, so nothing here needs a collider or hides anyone.
 * Laid out for the west half and repeated, turned, for the east.
 */
export function dressServices(kit: Kit, m: Materials): void {
  for (const s of [1, -1]) {
    for (const [x0, z0, x1, z1, y, nx, nz] of TRAYS) tray(kit, m, [s * x0, s * z0, s * x1, s * z1, y, s * nx, s * nz]);
    for (const [x, z, nx, nz] of REELS) reel(kit, m, s * x, s * z, s * nx, s * nz);
    for (const [x, z, nx, nz] of BOXES) junction(kit, m, s * x, s * z, s * nx, s * nz);
  }
}
