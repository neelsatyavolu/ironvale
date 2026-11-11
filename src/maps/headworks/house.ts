import * as THREE from 'three/webgpu';
import { plate, streak, STAIN } from './fittings';
import { faceOf, type Side } from './frame';
import { V, type Kit } from './kit';
import { COAT, type Materials } from './materials';
import { BLOCKS, HOUSE, HOUSES, isTwin, type Block, type Zone } from './plan';

const SIGN_YELLOW = 0xd9a514;

/** Steel frame round a doorway, a kick strip, and the door leaf folded back against the wall outside. */
function doorway(kit: Kit, m: Materials, lintel: Block, house: Zone): void {
  const alongX = lintel.x1 - lintel.x0 > lintel.z1 - lintel.z0;
  const width = alongX ? lintel.x1 - lintel.x0 : lintel.z1 - lintel.z0;
  // Which side of the wall is outdoors: the one farther from the middle of the house.
  const cx = (house.x0 + house.x1) / 2;
  const cz = (house.z0 + house.z1) / 2;
  const outside: Side = alongX ? ((lintel.z0 + lintel.z1) / 2 < cz ? 'n' : 's') : (lintel.x0 + lintel.x1) / 2 < cx ? 'w' : 'e';
  const head = lintel.y;
  const wall: Block = { ...lintel, y: 0, h: lintel.y + lintel.h };
  const face = faceOf(wall, outside);
  const depth = HOUSE.wall;
  for (const s of [-1, 1]) {
    kit.cast(m.paint, 0.09, head, depth + 0.06, face.at((s * width) / 2 - s * 0.045, head / 2, -depth / 2), 0.012, COAT.door);
    kit.cast(m.hazard, 0.1, 1.2, 0.012, face.at((s * width) / 2 + s * 0.12, 0.62, 0.006), 0.002);
  }
  kit.cast(m.paint, width, 0.09, depth + 0.06, face.at(0, head - 0.045, -depth / 2), 0.012, COAT.door);
  kit.cast(m.galvanised, width - 0.18, 0.012, depth + 0.1, face.at(0, 0.006, -depth / 2), 0.002);
  // Leaf held open against the wall, on the side with more wall to lie on.
  const side = isTwin(lintel) ? -1 : 1;
  const hinge = (side * width) / 2;
  kit.cast(m.paint, width - 0.1, head - 0.08, 0.05, face.at(hinge + side * (width / 2 + 0.02), head / 2, 0.045), 0.012, COAT.door);
  kit.cast(m.stainless, 0.03, 0.2, 0.03, face.at(hinge + side * (width - 0.2), 1.05, 0.085), 0.006);
  plate(kit, m, face, isTwin(lintel) ? 'PUMP HOUSE B' : 'PUMP HOUSE A', 0, head + 0.55, 1.5, 0.014);
  streak(kit, m, face, kit.range(-0.6, 0.6), HOUSE.height, kit.range(0.5, 1), kit.range(0.8, 1.6), STAIN.damp);
}

/**
 * Pump houses: door frames and signs, roof beams, a sealed floor with marked
 * walkways and a drain, cable trays, and vents on the roof.
 */
export function dressHouses(kit: Kit, m: Materials): void {
  for (const house of HOUSES) {
    const east = isTwin(house);
    const lintels = BLOCKS.filter((b) => b.id.startsWith('house-') && b.id.includes('lintel') && isTwin(b) === east);
    for (const lintel of lintels) doorway(kit, m, lintel, house);

    const [x0, x1, z0, z1] = [house.x0 + HOUSE.wall, house.x1 - HOUSE.wall, east ? house.z0 : house.z0 + HOUSE.wall, east ? house.z1 - HOUSE.wall : house.z1];
    const top = HOUSE.height;
    // Downstand roof beams across the short span and one spine beam.
    for (let x = x0 + 2.6; x < x1 - 1; x += 3.4) kit.slab(m.concrete, x - 0.16, x + 0.16, top - 0.5, top, z0, z1, 0.03, 0xe0ded7);
    kit.slab(m.concrete, x0, x1, top - 0.34, top, (z0 + z1) / 2 - 0.2, (z0 + z1) / 2 + 0.2, 0.03, 0xd8d6cf);

    // Sealed floor, a little greener than the yard slab, with walkways lined out in yellow.
    const floor = new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2);
    kit.add(m.paving, floor, new THREE.Matrix4().makeTranslation((x0 + x1) / 2, 0.008, (z0 + z1) / 2), 0xb4c4bc);
    floor.dispose();
    const line = (ax: number, az: number, bx: number, bz: number): void => {
      const geometry = new THREE.PlaneGeometry(Math.abs(bx - ax) + 0.1, Math.abs(bz - az) + 0.1).rotateX(-Math.PI / 2);
      kit.add(m.line, geometry, new THREE.Matrix4().makeTranslation((ax + bx) / 2, 0.012, (az + bz) / 2), SIGN_YELLOW);
      geometry.dispose();
    };
    const [lx0, lx1, lz0, lz1] = [x0 + 1.3, x1 - 1.3, z0 + 1.3, z1 - 1.3];
    line(lx0, lz0, lx1, lz0);
    line(lx0, lz1, lx1, lz1);
    line(lx0, lz0, lx0, lz1);
    line(lx1, lz0, lx1, lz1);
    // Drain channel across the floor under a grating.
    const drainZ = (z0 + z1) / 2 + (east ? 1.2 : -1.2);
    const drain = new THREE.PlaneGeometry(x1 - x0 - 1, 0.32).rotateX(-Math.PI / 2);
    const uv = drain.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (x1 - x0 - 1), uv.getY(i) * 0.32);
    kit.add(m.grating, drain, new THREE.Matrix4().makeTranslation((x0 + x1) / 2, 0.014, drainZ));
    drain.dispose();

    // Cable tray along the wall away from the perimeter, with drops to the cabinets.
    const trayZ = east ? z1 - 0.22 : z0 + 0.22;
    kit.beam(m.galvanised, V(x0 + 0.3, 3.5, trayZ), V(x1 - 0.3, 3.5, trayZ), 0.32, 0.05);
    for (const dz of [-0.1, -0.03, 0.04, 0.11]) kit.tube(m.matte, V(x0 + 0.3, 3.55, trayZ + dz), V(x1 - 0.3, 3.55, trayZ + dz), 0.017, COAT.black, 5);
    for (let x = x0 + 1.2; x < x1; x += 2.4) kit.cast(m.galvanised, 0.05, 0.3, 0.4, new THREE.Matrix4().makeTranslation(x, 3.33, trayZ), 0.006);
    // Fire point by the inner door: extinguisher and a red back plate.
    const fireX = east ? x1 - 0.04 : x0 + 0.04;
    const fireZ = (z0 + z1) / 2 + (east ? -4.6 : 4.6);
    kit.cast(m.paint, 0.02, 0.9, 0.5, new THREE.Matrix4().makeTranslation(fireX, 1.2, fireZ), 0.004, COAT.red);
    kit.tube(m.paint, V(fireX + (east ? -0.12 : 0.12), 0.85, fireZ), V(fireX + (east ? -0.12 : 0.12), 1.35, fireZ), 0.075, COAT.red, 10);

    // Roof: kerb round the edge, three vents and the stains they leave on the fascia.
    const roof = BLOCKS.find((b) => b.role === 'roof' && isTwin(b) === east) as Block;
    const roofTop = roof.y + roof.h;
    for (const [rx0, rx1, rz0, rz1] of [
      [roof.x0, roof.x1, roof.z0, roof.z0 + 0.25],
      [roof.x0, roof.x0 + 0.25, roof.z0, roof.z1],
      [roof.x1 - 0.25, roof.x1, roof.z0, roof.z1],
      [roof.x0, roof.x1, roof.z1 - 0.25, roof.z1],
    ] as const) {
      kit.slab(m.concrete, rx0, rx1, roofTop, roofTop + 0.22, rz0, rz1, 0.03, 0xe4e1d9);
    }
    for (const dx of [-5, 0, 5]) {
      const vx = (roof.x0 + roof.x1) / 2 + dx;
      const vz = (roof.z0 + roof.z1) / 2;
      kit.tube(m.galvanised, V(vx, roofTop, vz), V(vx, roofTop + 0.8, vz), 0.22, undefined, 14);
      const cap = new THREE.ConeGeometry(0.36, 0.22, 14);
      kit.add(m.galvanised, cap, new THREE.Matrix4().makeTranslation(vx, roofTop + 0.98, vz));
      cap.dispose();
    }
    for (const side of ['n', 's', 'e', 'w'] as const) {
      if ((side === 's' && !east) || (side === 'n' && east)) continue;
      const face = faceOf(roof, side);
      for (let k = 0; k < 4; k++) streak(kit, m, face, kit.range(-face.width / 2 + 0.6, face.width / 2 - 0.6), 0.02, kit.range(0.3, 0.8), kit.range(0.9, 2.4), k % 2 === 0 ? STAIN.damp : STAIN.algae, -0.288);
    }
  }
}
