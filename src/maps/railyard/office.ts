import * as THREE from 'three/webgpu';
import type { Kit } from './kit';
import { logoGeometry, type Materials } from './materials';
import { DOORS, OFFICE as O } from './plan';

const SHELL = 0xc3c8c4;
const TRIM = 0x2f4a5c;
const WALL = 0.1;
const LINING = 0.014;
const SILL = 1.0;
const HEAD = 2.1;
const DOOR = DOORS.office;
const WINDOWS: readonly [[number, number], [number, number]] = [
  [10.8, 12.6],
  [14.6, 16.4],
];

/** Site office: a sheet-clad cabin with a door at each end and two windows over the tracks. */
export function buildOffice(kit: Kit, m: Materials): void {
  const midX = (O.west + O.east) / 2;
  const midZ = (O.north + O.south) / 2;
  const width = O.east - O.west;
  const length = O.south - O.north;

  /** Wall panel in the plane x = const, with a collider. */
  const panelX = (x: number, z0: number, z1: number, y0: number, y1: number): void => {
    kit.box(m.cladding, WALL, y1 - y0, z1 - z0, x, y0, (z0 + z1) / 2, { tile: 2, color: SHELL, surface: 'metal' });
  };
  const panelZ = (z: number, x0: number, x1: number, y0: number, y1: number): void => {
    kit.box(m.cladding, x1 - x0, y1 - y0, WALL, (x0 + x1) / 2, y0, z, { tile: 2, color: SHELL, surface: 'metal' });
  };

  // Floor on skids, a step above the yard, and a flat roof with a fascia.
  kit.box(m.matte, width, 0.06, length, midX, 0, midZ, { color: 0x4a4f52, surface: 'wood' });
  kit.box(m.steel, width + 0.3, 0.14, length + 0.3, midX, O.height, midZ, { color: 0x8d9391 });
  kit.box(m.steel, width + 0.36, 0.2, length + 0.36, midX, O.height - 0.12, midZ, { color: TRIM });
  kit.collide(width + 0.3, 0.26, length + 0.3, midX, O.height - 0.12, midZ, 'metal');
  kit.box(m.matte, width - 0.2, 0.02, length - 0.2, midX, O.height - 0.14, midZ, { color: 0xb9bbb6 });

  // East wall is solid. West wall has the two windows.
  panelX(O.east - WALL / 2, O.north, O.south, 0, O.height - 0.12);
  const westX = O.west + WALL / 2;
  panelX(westX, O.north, O.south, 0, SILL);
  panelX(westX, O.north, O.south, HEAD, O.height - 0.12);
  let cursor: number = O.north;
  for (const [w0, w1] of WINDOWS) {
    panelX(westX, cursor, w0, SILL, HEAD);
    kit.box(m.glass, 0.02, HEAD - SILL, w1 - w0, westX, SILL, (w0 + w1) / 2);
    for (const z of [w0, w1]) kit.box(m.steel, 0.14, HEAD - SILL + 0.1, 0.06, westX, SILL - 0.05, z, { color: TRIM });
    for (const y of [SILL - 0.05, HEAD]) kit.box(m.steel, 0.16, 0.06, w1 - w0 + 0.1, westX, y, (w0 + w1) / 2, { color: TRIM });
    cursor = w1;
  }
  panelX(westX, cursor, O.south, SILL, HEAD);

  // End walls with a doorway each; the doors stand open against the outside wall.
  for (const z of [O.north, O.south]) {
    const outward = z === O.north ? -1 : 1;
    const wallZ = z - outward * (WALL / 2);
    panelZ(wallZ, O.west, DOOR.west, 0, O.height - 0.12);
    panelZ(wallZ, DOOR.east, O.east, 0, O.height - 0.12);
    panelZ(wallZ, DOOR.west, DOOR.east, HEAD, O.height - 0.12);
    kit.box(m.steel, 0.05, HEAD, 0.92, DOOR.east + 0.04, 0.06, z + outward * 0.5, { color: TRIM, surface: 'metal' });
    kit.box(m.matte, 1.3, 0.05, 0.9, (DOOR.west + DOOR.east) / 2, 0, z + outward * 0.5, { color: 0x3a3d3f });
    // Bulkhead lamp over the door.
    kit.box(m.matte, 0.3, 0.12, 0.12, (DOOR.west + DOOR.east) / 2, HEAD + 0.22, z + outward * 0.08, { color: 0x1d1f21 });
    kit.box(m.lamp, 0.24, 0.08, 0.02, (DOOR.west + DOOR.east) / 2, HEAD + 0.24, z + outward * 0.15, { color: 0xffe0a8 });
  }

  const sign = logoGeometry('SITE OFFICE', 2.6);
  kit.add(m.lettering, sign, new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(O.west - 0.01, HEAD + 0.28, midZ), 0x24333d);
  sign.dispose();

  buildLining(kit, m);
  buildFurniture(kit, m);
  buildOfficeClutter(kit, m);
  // Air-conditioning unit and a mast on the roof.
  kit.box(m.steel, 1.1, 0.7, 0.8, O.east - 1.2, O.height + 0.14, O.north + 1.6, { color: 0xa9adab });
  kit.post(m.rawSteel, 0.03, 2.4, O.east - 0.6, O.height + 0.14, O.south - 0.8, 0x8a8d8e, 6);
}

/** Painted board lining on the inside of every wall, and a suspended ceiling grid. */
function buildLining(kit: Kit, m: Materials): void {
  const paint = 0xbdbaae;
  const top = O.height - 0.14;
  const inner = WALL + LINING / 2;
  const boardX = (x: number, z0: number, z1: number, y0: number, y1: number): void => {
    kit.box(m.matte, LINING, y1 - y0, z1 - z0, x, y0, (z0 + z1) / 2, { color: paint });
  };
  const boardZ = (z: number, x0: number, x1: number, y0: number, y1: number): void => {
    kit.box(m.matte, x1 - x0, y1 - y0, LINING, (x0 + x1) / 2, y0, z, { color: paint });
  };
  boardX(O.east - inner, O.north + WALL, O.south - WALL, 0.06, top);
  const westX = O.west + inner;
  boardX(westX, O.north + WALL, O.south - WALL, 0.06, SILL - 0.05);
  boardX(westX, O.north + WALL, O.south - WALL, HEAD + 0.06, top);
  let cursor: number = O.north + WALL;
  for (const [w0, w1] of WINDOWS) {
    boardX(westX, cursor, w0 - 0.05, SILL - 0.05, HEAD + 0.06);
    cursor = w1 + 0.05;
  }
  boardX(westX, cursor, O.south - WALL, SILL - 0.05, HEAD + 0.06);
  for (const z of [O.north + inner, O.south - inner]) {
    boardZ(z, O.west + WALL, DOOR.west - 0.04, 0.06, top);
    boardZ(z, DOOR.east + 0.04, O.east - WALL, 0.06, top);
    boardZ(z, DOOR.west - 0.04, DOOR.east + 0.04, HEAD + 0.04, top);
    // Door frame.
    for (const x of [DOOR.west - 0.02, DOOR.east + 0.02]) kit.box(m.steel, 0.05, HEAD, 0.14, x, 0.06, z, { color: TRIM });
  }
  // Skirting on the long walls and the grid of a suspended ceiling.
  for (const x of [O.east - WALL - 0.03, O.west + WALL + 0.03]) {
    kit.box(m.matte, 0.02, 0.1, O.south - O.north - 0.24, x, 0.06, (O.north + O.south) / 2, { color: 0x2a2d2f });
  }
  const grid = 0xd3d1c6;
  for (let x = O.west + 0.6; x < O.east - 0.2; x += 0.6) kit.box(m.matte, 0.025, 0.012, O.south - O.north - 0.2, x, top - 0.012, (O.north + O.south) / 2, { color: grid });
  for (let z = O.north + 0.65; z < O.south - 0.2; z += 1.2) kit.box(m.matte, O.east - O.west - 0.2, 0.012, 0.025, (O.west + O.east) / 2, top - 0.012, z, { color: grid });
}

/** The small things that make the cabin look worked in. None of it has colliders except the cooler. */
function buildOfficeClutter(kit: Kit, m: Materials): void {
  const east = O.east - WALL - LINING;
  const west = O.west + WALL + LINING;
  // Notes and magnets on the whiteboard, and a marker tray.
  const notes = [0xd9c84a, 0xc8641c, 0x4a8ab0, 0xd9c84a, 0x7ab06a] as const;
  notes.forEach((tint, i) => {
    kit.box(m.matte, 0.006, 0.12, 0.12, east - 0.025, 1.4 + (i % 2) * 0.32 + kit.range(-0.03, 0.03), O.north + 3.25 + i * 0.26, { color: tint });
  });
  kit.box(m.steel, 0.05, 0.02, 1.5, east - 0.04, 1.23, O.north + 3.8, { color: 0x8a8d8e });
  // Yard plan: a blue print with the berth name, pinned over the cork board.
  kit.box(m.matte, 0.006, 0.5, 0.78, east - 0.03, 1.4, O.north + 7.4, { color: 0x27476b });
  const plan = logoGeometry('BERTH 4', 0.6);
  kit.add(m.lettering, plan, new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(east - 0.04, 1.78, O.north + 7.4), 0xd6dde4);
  plan.dispose();
  // Keyboards, paper and mugs on the desks; a waste bin under the first.
  const deskX = O.east - 0.55;
  for (const z of [O.north + 2.2, O.north + 5.4]) {
    kit.box(m.matte, 0.15, 0.018, 0.43, deskX - 0.12, 0.78, z, { color: 0x1a1c1e });
    kit.box(m.matte, 0.21, 0.004, 0.3, deskX - 0.1, 0.78, z + 0.55, { yaw: 0.2, color: 0xdedcd2 });
    kit.box(m.matte, 0.21, 0.004, 0.3, deskX - 0.16, 0.784, z + 0.5, { yaw: -0.3, color: 0xcfcdc4 });
    kit.post(m.matte, 0.04, 0.09, deskX - 0.05, 0.78, z - 0.55, 0x8f1f18, 10);
  }
  kit.post(m.matte, 0.14, 0.3, deskX - 0.1, 0.06, O.north + 3.25, 0x24282b, 10);
  // Kettle and mugs on the filing cabinet.
  kit.post(m.rawSteel, 0.075, 0.2, O.east - 0.4, 1.26, O.north + 0.42, 0xb9bcbd, 12);
  for (const dz of [0.2, 0.31]) kit.post(m.matte, 0.036, 0.085, O.east - 0.34, 1.26, O.north + 0.42 + dz, 0xd9d8d0, 10);
  // Water cooler in the north-west corner.
  kit.box(m.matte, 0.32, 1.0, 0.32, west + 0.2, 0.06, O.north + 0.42, { color: 0xcfd2cf, surface: 'wood' });
  kit.post(m.glass, 0.13, 0.38, west + 0.2, 1.06, O.north + 0.42, undefined, 12);
  // Hard hats on hooks over the jackets, a clock over the north door and a first-aid box.
  const hat = new THREE.SphereGeometry(0.13, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  [0xd9b21c, 0xe6e3da, 0xc8641c].forEach((tint, i) => {
    kit.add(m.matte, hat, new THREE.Matrix4().makeTranslation(west + 0.15, 1.92, O.south - 0.75 - i * 0.42), tint);
    kit.box(m.matte, 0.3, 0.02, 0.3, west + 0.15, 1.9, O.south - 0.75 - i * 0.42, { color: tint });
  });
  hat.dispose();
  kit.box(m.wood, 0.1, 0.03, 1.4, west + 0.05, 1.87, O.south - 1.15, { color: 0xc4ad88 });
  const face = new THREE.CylinderGeometry(0.15, 0.15, 0.03, 20).rotateX(Math.PI / 2);
  kit.add(m.matte, face, new THREE.Matrix4().makeTranslation(O.east - 1.6, 2.28, O.north + WALL + LINING + 0.016), 0xe6e3da);
  face.dispose();
  kit.box(m.matte, 0.012, 0.11, 0.004, O.east - 1.6, 2.28, O.north + WALL + LINING + 0.034, { color: 0x141516 });
  kit.box(m.matte, 0.09, 0.012, 0.004, O.east - 1.56, 2.275, O.north + WALL + LINING + 0.034, { color: 0x141516 });
  kit.box(m.matte, 0.34, 0.26, 0.1, O.east - 2.6, 1.5, O.north + WALL + LINING + 0.05, { color: 0x2d6a3e });
  // Radio chargers with their lights on the shelf end, and mud walked in at both doors.
  for (let i = 0; i < 3; i++) {
    kit.box(m.matte, 0.1, 0.16, 0.07, east - 0.14, 1.58, O.north + 5.75 + i * 0.11, { color: 0x121416 });
    kit.box(m.lamp, 0.006, 0.012, 0.012, east - 0.192, 1.66, O.north + 5.75 + i * 0.11, { color: i === 1 ? 0x4a0a05 : 0x0a3a12 });
  }
  // Between the windows: a year planner with its stickers, a safety notice and the light switch.
  const pier = (WINDOWS[0][1] + WINDOWS[1][0]) / 2;
  kit.box(m.matte, 0.008, 0.75, 1.15, west + 0.006, 1.2, pier - 0.25, { color: 0xe4e3dc });
  for (let i = 0; i < 12; i++) kit.box(m.matte, 0.004, 0.66, 0.008, west + 0.012, 1.24, pier - 0.78 + i * 0.096, { color: 0x8a8d8e });
  for (let i = 0; i < 9; i++) {
    const tint = kit.pick([0xa3261d, 0x2d6a3e, 0x27476b, 0xd9b21c] as const);
    kit.box(m.matte, 0.004, 0.045, 0.07, west + 0.014, 1.3 + kit.range(0, 0.55), pier - 0.74 + Math.floor(kit.range(0, 11)) * 0.096, { color: tint });
  }
  kit.box(m.steel, 0.008, 0.2, 0.62, west + 0.006, 2.2, pier - 0.25, { color: 0xd2a012 });
  const notice = logoGeometry('HARD HATS', 0.52);
  kit.add(m.lettering, notice, new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(west + 0.016, 2.3, pier - 0.25), 0x141516);
  notice.dispose();
  kit.box(m.matte, 0.012, 0.09, 0.09, west + 0.008, 1.3, pier + 0.75, { color: 0xdedcd2 });
  const mud = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  for (const z of [O.north + 0.9, O.south - 0.9]) {
    kit.add(m.stain, mud, kit.transform((DOOR.west + DOOR.east) / 2, 0.066, z).multiply(new THREE.Matrix4().makeScale(1.3, 1, 1.9)));
  }
  mud.dispose();
}

/** Desks along the east wall, lockers, a plan table and the ceiling lights. */
function buildFurniture(kit: Kit, m: Materials): void {
  const deskX = O.east - 0.55;
  for (const z of [O.north + 2.2, O.north + 5.4]) {
    kit.box(m.wood, 0.8, 0.04, 1.7, deskX, 0.74, z, { color: 0xc4ad88 });
    for (const dz of [-0.8, 0.8]) kit.box(m.steel, 0.7, 0.72, 0.04, deskX, 0.06, z + dz, { color: 0x3a3d3f });
    kit.box(m.matte, 0.05, 0.36, 0.58, deskX + 0.15, 0.9, z, { color: 0x121416 });
    kit.box(m.lamp, 0.005, 0.3, 0.52, deskX + 0.12, 0.93, z, { color: 0x0d1a26 });
    kit.box(m.matte, 0.14, 0.12, 0.2, deskX + 0.15, 0.78, z, { color: 0x121416 });
    kit.box(m.matte, 0.5, 0.08, 0.5, deskX - 0.95, 0.48, z + 0.2, { yaw: 0.4, color: 0x1f2326 });
    kit.box(m.matte, 0.08, 0.55, 0.46, deskX - 1.18, 0.5, z + 0.3, { yaw: 0.4, color: 0x1f2326 });
    kit.post(m.rawSteel, 0.03, 0.44, deskX - 0.95, 0.06, z + 0.2, 0x2a2c2e, 6);
    kit.collide(0.85, 0.78, 1.7, deskX, 0.06, z, 'wood');
    kit.collide(0.55, 1.0, 0.55, deskX - 1.0, 0.06, z + 0.22, 'wood');
  }
  // Lockers and a filing cabinet in the south-east corner.
  for (let i = 0; i < 3; i++) {
    kit.box(m.steel, 0.5, 1.85, 0.42, O.east - 0.4, 0.06, O.south - 0.45 - i * 0.44, { color: i === 1 ? 0x4c5f6b : 0x5a6d79 });
  }
  kit.collide(0.5, 1.85, 1.34, O.east - 0.4, 0.06, O.south - 0.89, 'metal');
  kit.box(m.steel, 0.5, 1.2, 0.6, O.east - 0.4, 0.06, O.north + 0.5, { color: 0x6f7577, surface: 'metal' });
  // Notice board and yard plan on the east wall.
  kit.box(m.matte, 0.02, 0.9, 1.5, O.east - WALL - LINING - 0.01, 1.25, O.north + 3.8, { color: 0xe4e3dc });
  kit.box(m.matte, 0.02, 0.7, 1.0, O.east - WALL - LINING - 0.01, 1.3, O.north + 7.4, { color: 0x6d5a3e });
  // Shelf of box files over the desks, a skirting strip and a door mat's worth of mud by each end.
  kit.box(m.wood, 0.28, 0.03, 3.4, O.east - WALL - 0.16, 1.55, O.north + 3.8, { color: 0xc4ad88 });
  const files = [0x2f4a5c, 0x7a2b25, 0x2d5a3a, 0x8a8f94, 0x1f2326] as const;
  for (let i = 0; i < 22; i++) {
    const tall = kit.range(0.26, 0.32);
    const tint = kit.pick(files);
    if (i % 7 === 5) continue;
    kit.box(m.matte, 0.24, tall, 0.07, O.east - WALL - 0.16, 1.58, O.north + 2.25 + i * 0.145, { color: tint });
  }
  // Coat hooks with two jackets by the south door.
  for (const [dz, tint] of [[0.5, 0xc8641c], [0.95, 0x2b3a2e]] as const) {
    kit.box(m.matte, 0.12, 0.75, 0.42, O.west + WALL + LINING + 0.07, 1.05, O.south - dz - 0.4, { color: tint });
  }
  // Ceiling light panels.
  for (const z of [O.north + 2.4, O.north + 6.8]) {
    kit.box(m.lamp, 0.3, 0.02, 1.2, (O.west + O.east) / 2 + 0.6, O.height - 0.17, z, { color: 0xfff0d6 });
  }
}
