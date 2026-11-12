import * as THREE from 'three/webgpu';
import { STAIN } from './fittings';
import { V, type Kit } from './kit';
import { COAT, type Materials } from './materials';
import { BLOCKS, DRUMS, HALF_X, RAMPS, TANK } from './plan';

const YELLOW = 0xd9a514;
const WHITE = 0xe8e6de;

/** Flat rectangle on the ground, turned by `yaw`, with UVs 0 - 1 or in metres. */
function patch(kit: Kit, material: THREE.Material, x: number, z: number, width: number, depth: number, y: number, color?: number, yaw = 0, metres = false): void {
  const geometry = new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2);
  if (metres) {
    const uv = geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * width, uv.getY(i) * depth);
  }
  kit.add(material, geometry, new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z), color);
  geometry.dispose();
}

/** Linear drain: a grating in a concrete channel, with the dirt that collects along it. */
function channel(kit: Kit, m: Materials, x0: number, z0: number, x1: number, z1: number): void {
  const length = Math.hypot(x1 - x0, z1 - z0);
  const yaw = Math.atan2(-(z1 - z0), x1 - x0);
  const [cx, cz] = [(x0 + x1) / 2, (z0 + z1) / 2];
  patch(kit, m.paving, cx, cz, length + 0.2, 0.62, 0.006, 0xcfcfc9, yaw);
  patch(kit, m.grating, cx, cz, length, 0.3, 0.012, undefined, yaw, true);
  patch(kit, m.stain, cx, cz, length * 1.05, 2.4, 0.016, STAIN.damp, yaw);
}

/** Square gully with a cast grate and a damp halo. */
function gully(kit: Kit, m: Materials, x: number, z: number): void {
  patch(kit, m.matte, x, z, 0.56, 0.56, 0.008, 0x2b2c2d);
  patch(kit, m.grating, x, z, 0.46, 0.46, 0.013, undefined, 0, true);
  patch(kit, m.stain, x, z, 3.2, 2.6, 0.017, STAIN.damp, kit.range(0, 3));
}

function manhole(kit: Kit, m: Materials, x: number, z: number): void {
  const lid = new THREE.CylinderGeometry(0.36, 0.36, 0.02, 20);
  kit.add(m.matte, lid, new THREE.Matrix4().makeTranslation(x, 0.006, z), 0x34363a);
  lid.dispose();
  const rim = new THREE.TorusGeometry(0.39, 0.025, 5, 22).rotateX(Math.PI / 2);
  kit.add(m.galvanised, rim, new THREE.Matrix4().makeTranslation(x, 0.01, z), 0x777b7e);
  rim.dispose();
}

/** Yellow steel post tucked against a corner to keep vehicles off it. */
function bollard(kit: Kit, m: Materials, x: number, z: number): void {
  kit.tube(m.paint, V(x, 0, z), V(x, 0.95, z), 0.075, YELLOW, 10);
  const cap = new THREE.SphereGeometry(0.075, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  kit.add(m.paint, cap, new THREE.Matrix4().makeTranslation(x, 0.95, z), YELLOW);
  cap.dispose();
  kit.tube(m.matte, V(x, 0.62, z), V(x, 0.74, z), 0.078, COAT.black, 10);
}

/**
 * Everything on the slab: drains and gullies, manholes, lane and hazard
 * paint, patched repairs, tyre marks on the roads and the stains that gather
 * round plant. Laid out for the west half and repeated, turned, for the east;
 * the scattered stains differ between the two.
 */
export function dressGround(kit: Kit, m: Materials): void {
  for (const s of [1, -1]) {
    const at = (x: number, z: number): readonly [number, number] => [s * x, s * z];
    const drain = (x0: number, z0: number, x1: number, z1: number): void => channel(kit, m, s * x0, s * z0, s * x1, s * z1);
    // Drains: along the foot of the Filter Walk basins, across the court mouths and through the slot.
    drain(-33, -34.4, -6, -34.4);
    drain(-33.2, -18.4, -21, -18.4);
    drain(-19.4, 13.9, -9, 13.9);
    drain(-29.6, 21.2, -12, 21.2);
    drain(-11.4, 27.6, -11.4, 40);
    for (const [x, z] of [
      [-44, -17],
      [-31, 2],
      [-9.5, 7],
      [-42, 20],
      [-6, 36],
      [-36, -30],
      [-2.2, -21],
    ] as const) {
      gully(kit, m, ...at(x, z));
    }
    for (const [x, z] of [
      [-33, -8],
      [-27, 12],
      [-8, -17.6],
      [-43, -33],
      [-36, 37],
      [-3, 31],
    ] as const) {
      manhole(kit, m, ...at(x, z));
    }

    // Road paint: edge lines along the Filter Walk, a stop bar and hatching outside the roller shutter.
    const line = (x: number, z: number, w: number, d: number, color = YELLOW, yaw = 0): void => patch(kit, m.line, s * x, s * z, w, d, 0.02, color, yaw);
    line(-26, -34.2, 41, 0.12);
    line(-26, -23.9, 41, 0.12);
    for (let x = -44; x < -8; x += 3) line(x, -29, 1.5, 0.1, WHITE);
    line(-7.2, -32.8, 0.3, 3.4, WHITE);
    for (let i = 0; i < 7; i++) line(-36.4 + i * 0.55, -24.6, 0.12, 2.2, YELLOW, 0.7);
    // Hazard bars at the foot of each ramp and a keep-clear box at the court doors.
    for (const ramp of RAMPS.filter((r) => !r.id.endsWith('-east'))) {
      const alongX = Math.sign(ramp.footX - ramp.topX);
      for (let i = 0; i < 3; i++) line(ramp.footX + alongX * (0.3 + i * 0.4), ramp.footZ, 0.16, ramp.width - 0.2);
    }
    for (const z of [-14, 6.25]) {
      line(-21.6, z, 0.1, 3.4);
      line(-22.8, z, 0.1, 3.4);
      line(-22.2, z - 1.7, 1.3, 0.1);
      line(-22.2, z + 1.7, 1.3, 0.1);
    }

    // Repairs: newer, darker pours let into the slab, each with its saw cut showing.
    for (const [x, z, w, d, yaw] of [
      [-30, -6.5, 3.2, 1.6, 0],
      [-13, 8.6, 1.2, 4.4, 0],
      [-43.5, 24, 2.4, 2.4, 0],
      [-7, 33.5, 5, 1.1, 0],
      [-24, -14.5, 1.4, 1.4, 0],
      [-40, -29, 2.6, 3.8, 0],
    ] as const) {
      patch(kit, m.matte, s * x, s * z, w + 0.06, d + 0.06, 0.004, 0x3f4042, yaw);
      // Vertex colour ends up linear: 0xa9 came out at 40% brightness and read as a black plate, not a newer pour.
      patch(kit, m.paving, s * x, s * z, w, d, 0.007, s > 0 ? 0xe4e5e1 : 0xf4f4ee, yaw);
    }

    // Tyre marks: straight runs on the road and the swing into the store's shutter.
    const tyres = (x: number, z: number, length: number, yaw: number): void => patch(kit, m.tyres, s * x, s * z, 2.1, length, 0.024, undefined, yaw + (s < 0 ? Math.PI : 0));
    tyres(-30, -30.6, 26, Math.PI / 2);
    tyres(-18, -27.4, 19, Math.PI / 2 + 0.05);
    tyres(-39, -27, 11, Math.PI / 2 - 0.35);
    tyres(-44, -22, 9, 0.12);
    tyres(-43.5, 30, 9, -0.1);
  }

  // Stains: under every kiosk, cabinet and pump, round each tank's foot and at random across the yard.
  for (const b of BLOCKS) {
    if (!['kiosk', 'cabinet', 'pumpset', 'manifold', 'pipes'].includes(b.role)) continue;
    const [w, d] = [b.x1 - b.x0, b.z1 - b.z0];
    patch(kit, m.stain, (b.x0 + b.x1) / 2 + kit.range(-0.4, 0.4), (b.z0 + b.z1) / 2 + kit.range(-0.4, 0.4), w + 2.2, d + 2.2, 0.018, b.role === 'pumpset' ? 0x15130f : STAIN.damp);
    if (b.role === 'kiosk') {
      for (const [x, z] of [
        [b.x0 - 0.13, b.z0 - 0.13],
        [b.x1 + 0.13, b.z1 + 0.13],
        [b.x0 - 0.13, b.z1 + 0.13],
        [b.x1 + 0.13, b.z0 - 0.13],
      ] as const) {
        bollard(kit, m, x, z);
      }
    }
  }
  for (const d of DRUMS.filter((drum) => drum.role === 'clarifier')) {
    const blots = 14;
    for (let i = 0; i < blots; i++) {
      const angle = ((i + kit.range(0, 1)) / blots) * Math.PI * 2;
      const reach = d.r + kit.range(0.3, 1.1);
      patch(kit, m.stain, d.x + Math.sin(angle) * reach, d.z + Math.cos(angle) * reach, kit.range(2, 4.5), kit.range(1.6, 3), 0.019, i % 4 === 0 ? STAIN.scale : STAIN.algae, angle);
    }
  }
  const scatter = Math.round(60 * (0.35 + 0.65 * kit.detail));
  for (let i = 0; i < scatter; i++) {
    const x = kit.range(-HALF_X + 1, HALF_X - 1);
    const z = kit.range(-40, 40);
    if (Math.hypot(x - TANK.x, z - TANK.z) < TANK.radius || Math.hypot(x + TANK.x, z + TANK.z) < TANK.radius) continue;
    const kind = i % 5;
    const size = kit.range(0.8, 3.4);
    patch(kit, m.stain, x, z, size * kit.range(1, 1.8), size, 0.02, kind === 0 ? 0x15130f : kind === 1 ? STAIN.scale : kind === 2 ? STAIN.rust : STAIN.damp, kit.range(0, 3));
  }
}
