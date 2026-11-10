import * as THREE from 'three/webgpu';
import type { Clutter } from './clutter';
import type { Kit } from './kit';
import type { Materials } from './materials';
import { DOORS, WAREHOUSE as W, YARD } from './plan';

const FRAME = 0x55626a;
const GALVANISED = 0x9a9d9c;
const YELLOW = 0xd2a012;
const WALL_TOP = 3.5;
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** The things that stop a shed wall being a bare sheet: rails, rainwater goods, cabinets, signs and floor paint. */
export function dressWarehouse(kit: Kit, m: Materials, c: Clutter): void {
  const length = W.south - W.north;
  const midZ = (W.north + W.south) / 2;
  const door = W.door;

  // Sheeting rails on the inside of the west wall and the gables.
  for (const y of [2.6, 4.3, 6.0]) kit.box(m.steel, 0.08, 0.16, length - 0.6, W.west + 0.24, y, midZ, { color: FRAME });
  for (const z of [W.north + 0.14, W.south - 0.14]) {
    for (const y of [5.95, 6.95]) kit.box(m.steel, W.east - W.west - 0.8, 0.14, 0.08, (W.west + W.east) / 2, y, z, { color: FRAME });
    for (const y of [2.6, 4.3]) {
      kit.box(m.steel, door.west - W.west - 0.9, 0.14, 0.08, (W.west + door.west) / 2 + 0.15, y, z, { color: FRAME });
      kit.box(m.steel, W.east - door.east - 0.9, 0.14, 0.08, (W.east + door.east) / 2 - 0.15, y, z, { color: FRAME });
    }
  }

  // Gutter along the yard-side eaves, and downpipes at every other column.
  kit.box(m.steel, 0.18, 0.13, length + 0.6, W.east + 0.16, W.eaves - 0.16, midZ, { color: 0x4a5258 });
  for (let z = W.north + 0.25; z <= W.south; z += W.bay * 2) c.downpipe(W.east + 0.16, z, W.eaves - 0.1);
  c.downpipe(W.east + 0.16, W.south - 0.25, W.eaves - 0.1);

  // Fire points on the yard-side columns and under the mezzanine; switchgear on both gables.
  c.firePoint(W.east - 0.32, W.north + W.bay * 3, -1, 0);
  c.firePoint(W.east - 0.32, W.north + W.bay * 7, -1, 0);
  c.firePoint(W.west + 0.3, 17.6, 1, 0);
  c.cabinet(-23.4, W.north - 0.15, 0, -1, 6.4);
  c.cabinet(-38.4, W.south + 0.15, 0, 1, 6.4);
  c.cabinet(W.west + 0.3, -1.5, 1, 0, 2.8);

  // Signs by the cargo doors and on the half-open shutter.
  c.plate(door.west - 2.3, 2.7, W.north - 0.08, 0, -1, 'HARD HATS', 1.6, YELLOW, 0x141516);
  c.plate(door.east + 2.3, 2.7, W.south + 0.08, 0, 1, 'HARD HATS', 1.6, YELLOW, 0x141516);
  c.plate((door.west + door.east) / 2, 4.4, W.south - 0.08, 0, 1, 'KEEP CLEAR', 3.2, 0x8a8f90, 0x8f1f18);
  c.plate(W.west + 0.3, 2.2, -18, 1, 0, 'DANGER', 1.3, 0x8f1f18, 0xe6e3da);

  // Floor paint: the main aisle, hatched thresholds and a walkway to the staff door.
  const paint = (x0: number, z0: number, x1: number, z1: number, width: number, color = YELLOW): void => {
    const run = Math.hypot(x1 - x0, z1 - z0);
    kit.box(m.paint, width, 0.002, run, (x0 + x1) / 2, 0.004, (z0 + z1) / 2, { yaw: Math.atan2(x1 - x0, z1 - z0), color });
  };
  for (const x of [door.west - 0.3, door.east + 0.3]) paint(x, W.north + 0.4, x, W.south - 0.4, 0.12);
  for (const z0 of [W.north + 0.3, W.south - 3.3]) {
    for (let x = door.west; x < door.east - 0.5; x += 1.1) paint(x, z0, x + 1.1, z0 + 3, 0.12);
    for (const z of [z0, z0 + 3]) paint(door.west - 0.3, z, door.east + 0.3, z, 0.12);
  }
  for (let z = W.north + 0.6; z < -4; z += 1.0) paint(DOORS.staff.west - 0.3, z, DOORS.staff.east + 0.3, z, 0.4, 0xd6d4cb);
}

/** Three strands of wire on cranked arms along the top of a wall from (ax, az) to (bx, bz). `inward` leans the arms. */
function wireRun(kit: Kit, m: Materials, ax: number, az: number, bx: number, bz: number, inwardX: number, inwardZ: number): void {
  const run = Math.hypot(bx - ax, bz - az);
  const posts = Math.max(1, Math.round(run / 3));
  for (let i = 0; i <= posts; i++) {
    const t = i / posts;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    kit.beam(m.rawSteel, V(x, WALL_TOP - 0.1, z), V(x + inwardX * 0.32, WALL_TOP + 0.5, z + inwardZ * 0.32), 0.035, 0.035, GALVANISED);
  }
  for (const [reach, rise] of [[0.1, 0.18], [0.2, 0.33], [0.3, 0.48]] as const) {
    const lift = WALL_TOP - 0.1 + rise;
    kit.beam(m.rawSteel, V(ax + inwardX * reach, lift, az + inwardZ * reach), V(bx + inwardX * reach, lift, bz + inwardZ * reach), 0.012, 0.012, GALVANISED);
  }
}

/** Wire along the perimeter walls, the gate's sign and lamp, and the row markers at the south end of the stacks. */
export function dressPerimeter(kit: Kit, m: Materials, c: Clutter): void {
  const south = YARD.south + 0.15;
  wireRun(kit, m, YARD.west, south, -4.2, south, 0, -1);
  wireRun(kit, m, 4.2, south, YARD.east, south, 0, -1);
  wireRun(kit, m, YARD.west - 0.15, W.south + 0.3, YARD.west - 0.15, YARD.south, 1, 0);
  wireRun(kit, m, YARD.west - 0.15, YARD.quay + 0.3, YARD.west - 0.15, W.north - 0.3, 1, 0);

  c.plate(0.3, 2.35, YARD.south + 0.08, 0, -1, 'GATE 2', 2.2, 0x2f4a43, 0xe6e3da);
  c.plate(-11.5, 2.3, YARD.south - 0.02, 0, -1, 'KEEP CLEAR', 1.8, YELLOW, 0x141516);
  buildGatehouse(kit, m);
  c.plate(YARD.west + 0.02, 2.3, 30, 1, 0, 'DANGER', 1.4, 0x8f1f18, 0xe6e3da);

  // Row markers where the lanes open onto the staging area.
  c.signPost(-11.3, 33.5, 0, 1, 'ROW A');
  c.signPost(-2.05, 33.5, 0, 1, 'ROW B');
  c.signPost(8.1, 33.5, 0, 1, 'ROW C');
  c.signPost(16.3, 33.2, 0, 1, 'ROW D');
  c.signPost(-11.3, -28.6, 0, -1, 'ROW A');
  c.signPost(8.1, -28.6, 0, -1, 'ROW C');
  c.signPost(-17.9, -29.2, 0, -1, 'BERTH 4', 0x2f4a5c, 0xe6e3da);
}

/** Gatekeeper's cabin beside the gate, lit from inside, and a raised boom across the roadway. Not enterable. */
function buildGatehouse(kit: Kit, m: Materials): void {
  const cabin = { x: -6.9, z: 48.25, size: 2.6, height: 2.5 } as const;
  const trim = 0x2f4a5c;
  const half = cabin.size / 2;
  kit.box(m.wall, cabin.size + 0.3, 0.12, cabin.size + 0.3, cabin.x, 0, cabin.z, { tile: 2.71 });
  kit.box(m.cladding, cabin.size, cabin.height, cabin.size, cabin.x, 0.12, cabin.z, { tile: 2, color: 0xc3c8c4 });
  kit.box(m.steel, cabin.size + 0.5, 0.12, cabin.size + 0.5, cabin.x, cabin.height + 0.12, cabin.z, { color: trim });
  kit.collide(cabin.size, cabin.height + 0.24, cabin.size, cabin.x, 0, cabin.z, 'metal');
  // Lit windows with blinds on the faces toward the yard and the gate; a door on the gate side.
  const glow = 0x8a6a40;
  for (const [nx, nz] of [[0, -1], [1, 0]] as const) {
    const wx = cabin.x + nx * (half + 0.012) - nz * (nx === 0 ? 0 : 0.5);
    const wz = cabin.z + nz * (half + 0.012) + (nx === 0 ? 0 : -0.5);
    const yaw = Math.atan2(nx, nz);
    const width = nx === 0 ? 1.7 : 0.9;
    kit.box(m.lamp, width, 0.85, 0.01, wx, 1.25, wz, { yaw, color: glow });
    kit.box(m.steel, width + 0.14, 0.07, 0.05, wx, 1.2, wz, { yaw, color: trim });
    kit.box(m.steel, width + 0.14, 0.07, 0.05, wx, 2.1, wz, { yaw, color: trim });
    for (let y = 1.34; y < 2.08; y += 0.085) kit.box(m.matte, width, 0.02, 0.022, wx, y, wz, { yaw, color: 0x8f8d84 });
  }
  kit.box(m.steel, 0.04, 2.0, 0.85, cabin.x + half + 0.02, 0.14, cabin.z + 0.62, { color: trim });
  kit.box(m.rawSteel, 0.03, 0.03, 0.12, cabin.x + half + 0.06, 1.1, cabin.z + 0.32, { color: GALVANISED });
  kit.box(m.matte, 0.3, 0.12, 0.12, cabin.x + half + 0.06, 2.3, cabin.z + 0.62, { color: 0x1d1f21 });
  kit.box(m.lamp, 0.02, 0.08, 0.24, cabin.x + half + 0.13, 2.32, cabin.z + 0.62, { color: 0xffe0a8 });
  kit.box(m.steel, 0.5, 0.36, 0.7, cabin.x - 0.4, cabin.height + 0.24, cabin.z + 0.3, { color: 0xa9adab });

  // Boom: cabinet, counterweight and the arm standing open.
  const pivot = V(-4.35, 1.0, 48.5);
  kit.box(m.steel, 0.4, 1.1, 0.4, pivot.x, 0, pivot.z, { color: 0xc8641c, surface: 'metal' });
  const tip = V(pivot.x + Math.cos(1.25) * 6.2, pivot.y + Math.sin(1.25) * 6.2, pivot.z - 0.26);
  kit.beam(m.hazard, V(pivot.x, pivot.y, pivot.z - 0.26), tip, 0.1, 0.07);
  kit.beam(m.steel, V(pivot.x, pivot.y, pivot.z - 0.26), V(pivot.x - Math.cos(1.25) * 0.9, pivot.y - Math.sin(1.25) * 0.9, pivot.z - 0.26), 0.16, 0.12, 0x2a2c2e);
}
