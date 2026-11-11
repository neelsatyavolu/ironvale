import * as THREE from 'three/webgpu';
import { tiledBox } from '../../world/geometry';
import type { Kit } from './kit';
import { logoGeometry, type Materials } from './materials';
import { DOORS, WAREHOUSE as W } from './plan';
import type { Props } from './props';

const SHEET = 0xb9bdbb;
const ROOF_SHEET = 0x8d9391;
const FRAME = 0x55626a;
const PLINTH = 1.2;
const SHEET_TILE = 2;
const WALL_TILE = 2.71;
/** Height of the open sides: everything below this is clear between columns. */
const OPEN_HEIGHT = 5.6;
const RIDGE_X = (W.west + W.east) / 2;
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Open-sided portal-frame shed: frame, roof, gables with cargo doors, and the two closed bays on the yard side. */
export function buildWarehouseShell(kit: Kit, m: Materials): void {
  const length = W.south - W.north;
  const midZ = (W.north + W.south) / 2;
  const frames = Math.round(length / W.bay);

  // Portal frames.
  for (let i = 0; i <= frames; i++) {
    const z = W.north + i * W.bay;
    kit.box(m.steel, 0.3, W.eaves, 0.3, W.east - 0.15, 0, z, { color: FRAME });
    kit.box(m.steel, 0.3, W.eaves, 0.3, W.west + 0.4, 0, z, { color: FRAME });
    kit.beam(m.steel, V(W.west + 0.4, W.eaves - 0.2, z), V(RIDGE_X, W.ridge - 0.25, z), 0.2, 0.42, FRAME);
    kit.beam(m.steel, V(RIDGE_X, W.ridge - 0.25, z), V(W.east - 0.15, W.eaves - 0.2, z), 0.2, 0.42, FRAME);
    // Haunch braces at the knees.
    kit.beam(m.steel, V(W.east - 0.2, W.eaves - 1.5, z), V(W.east - 2.2, W.eaves + 0.25, z), 0.14, 0.14, FRAME);
    kit.beam(m.steel, V(W.west + 0.45, W.eaves - 1.5, z), V(W.west + 2.45, W.eaves + 0.25, z), 0.14, 0.14, FRAME);
    kit.collide(0.42, W.eaves, 0.42, W.east - 0.15, 0, z, 'metal');
    kit.box(m.hazard, 0.46, 1.1, 0.46, W.east - 0.15, 0, z);
  }
  // Purlins and eaves beams.
  for (const side of [-1, 1]) {
    for (let k = 1; k <= 5; k++) {
      const t = k / 6;
      const x = RIDGE_X + side * (1 - t) * (W.east - RIDGE_X);
      const y = W.eaves + t * (W.ridge - W.eaves) - 0.08;
      kit.box(m.steel, 0.07, 0.16, length, x, y, midZ, { color: 0x8a9092 });
    }
  }
  kit.box(m.steel, 0.2, 0.3, length, W.east - 0.15, W.eaves - 0.3, midZ, { color: FRAME });

  // Roof sheets, ribs running down the slope.
  const slope = Math.hypot(W.east - RIDGE_X, W.ridge - W.eaves) + 0.5;
  const pitch = Math.atan2(W.ridge - W.eaves, W.east - RIDGE_X);
  const sheet = tiledBox(length + 0.8, 0.06, slope, SHEET_TILE);
  for (const side of [-1, 1]) {
    const matrix = new THREE.Matrix4()
      .makeRotationZ(-side * pitch)
      .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
      .setPosition(RIDGE_X + (side * (W.east - RIDGE_X + 0.4)) / 2, (W.eaves + W.ridge) / 2 + 0.02, midZ);
    kit.add(m.cladding, sheet, matrix, ROOF_SHEET);
    kit.collideRamp(V(RIDGE_X + side * 12.2, W.eaves, midZ), V(RIDGE_X, W.ridge, midZ), length, 0.2, 'metal');
  }
  sheet.dispose();
  kit.box(m.steel, 0.5, 0.08, length + 0.8, RIDGE_X, W.ridge + 0.04, midZ, { color: 0x7a8082 });

  /** Vertical sheet in the plane z = const. */
  const cladZ = (x0: number, x1: number, y0: number, y1: number, z: number): void => {
    kit.box(m.cladding, x1 - x0, y1 - y0, 0.07, (x0 + x1) / 2, y0, z, { tile: SHEET_TILE, color: SHEET });
  };
  /** Vertical sheet in the plane x = const. */
  const cladX = (z0: number, z1: number, y0: number, y1: number, x: number): void => {
    kit.box(m.cladding, 0.07, y1 - y0, z1 - z0, x, y0, (z0 + z1) / 2, { tile: SHEET_TILE, color: SHEET });
  };

  // West wall: solid, on a concrete plinth.
  kit.box(m.wall, 0.25, PLINTH, length, W.west + 0.125, 0, midZ, { tile: WALL_TILE });
  cladX(W.north, W.south, PLINTH, W.eaves, W.west + 0.1);
  kit.collide(0.3, W.eaves, length, W.west + 0.15, 0, midZ, 'metal');

  // Gables. Each has the cargo door; the north one also has a staff door and a row of high vents.
  const door = W.door;
  const staff = { ...DOORS.staff, height: 2.1 };
  const vents: readonly [number, number][] = [
    [-40.2, -38.6],
    [-37.2, -35.6],
    [-24.4, -22.8],
  ];
  for (const z of [W.north, W.south]) {
    const north = z === W.north;
    const outward = north ? -1 : 1;
    const faceZ = z + outward * 0.02;
    const solid = (x0: number, x1: number): void => {
      kit.box(m.wall, x1 - x0, PLINTH, 0.25, (x0 + x1) / 2, 0, z, { tile: WALL_TILE });
      kit.collide(x1 - x0, W.eaves, 0.3, (x0 + x1) / 2, 0, z, 'metal');
    };
    solid(W.west, door.west);
    if (north) {
      solid(door.east, staff.west);
      solid(staff.east, W.east);
      kit.box(m.steel, 0.06, staff.height, 0.9, staff.east + 0.02, 0, z - 0.5, { color: 0x3d5f7a });
      kit.collide(0.08, staff.height, 0.9, staff.east + 0.02, 0, z - 0.5, 'metal');
    } else {
      solid(door.east, W.east);
    }
    // Sheeting in three bands so the vent slots can be left out of the middle one.
    const lower = 5.75;
    const upper = 6.85;
    cladZ(W.west, door.west, PLINTH, lower, faceZ);
    if (north) {
      cladZ(door.east, staff.west, PLINTH, lower, faceZ);
      cladZ(staff.west, staff.east, staff.height, lower, faceZ);
      cladZ(staff.east, W.east, PLINTH, lower, faceZ);
    } else {
      cladZ(door.east, W.east, PLINTH, lower, faceZ);
    }
    cladZ(door.west, door.east, door.height, lower, faceZ);
    cladZ(W.west, W.east, upper, W.eaves, faceZ);
    let cursor: number = W.west;
    for (const [v0, v1] of north ? vents : []) {
      cladZ(cursor, v0, lower, upper, faceZ);
      cursor = v1;
    }
    cladZ(cursor, W.east, lower, upper, faceZ);
    kit.collide(door.east - door.west, W.eaves - door.height, 0.3, RIDGE_X, door.height, z, 'metal');

    // Gable triangle above the eaves.
    const gable = new THREE.Shape();
    gable.moveTo(W.west, W.eaves);
    gable.lineTo(W.east, W.eaves);
    gable.lineTo(RIDGE_X, W.ridge);
    gable.closePath();
    const triangle = new THREE.ExtrudeGeometry(gable, { depth: 0.07, bevelEnabled: false });
    const uv = triangle.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / SHEET_TILE, uv.getY(i) / SHEET_TILE);
    kit.add(m.cladding, triangle, new THREE.Matrix4().makeTranslation(0, 0, faceZ - 0.035), SHEET);
    triangle.dispose();

    // Door frame, jamb guards and the company name over the door.
    for (const x of [door.west, door.east]) {
      kit.box(m.steel, 0.22, door.height + 0.2, 0.3, x, 0, z, { color: 0xb98a12 });
      kit.box(m.hazard, 0.4, 1.3, 0.5, x, 0, z, { surface: 'concrete' });
    }
    kit.box(m.steel, door.east - door.west + 0.44, 0.24, 0.3, RIDGE_X, door.height, z, { color: 0xb98a12 });
    const sign = logoGeometry('IRONVALE FREIGHT', 5.6);
    const facing = new THREE.Matrix4().makeRotationY(north ? Math.PI : 0).setPosition(RIDGE_X, 6.3, z + outward * 0.07);
    kit.add(m.lettering, sign, facing, 0x26333b);
    sign.dispose();
  }
  // South door: roller shutter stopped part-way.
  kit.box(m.cladding, door.east - door.west - 0.2, 1.9, 0.06, RIDGE_X, door.height - 1.9, W.south - 0.12, { tile: 0.8, color: 0x8a8f90 });
  kit.box(m.hazard, door.east - door.west - 0.2, 0.14, 0.1, RIDGE_X, door.height - 2.0, W.south - 0.12);

  // Yard side: sheeting above the open bays, and two bays walled in for cover.
  cladX(W.north, W.south, OPEN_HEIGHT, W.eaves, W.east - 0.02);
  for (const bay of [2, 6]) {
    const z0 = W.north + bay * W.bay + 0.15;
    const z1 = z0 + W.bay - 0.3;
    kit.box(m.wall, 0.25, PLINTH, z1 - z0, W.east - 0.15, 0, (z0 + z1) / 2, { tile: WALL_TILE });
    cladX(z0, z1, PLINTH, OPEN_HEIGHT, W.east - 0.1);
    kit.collide(0.3, OPEN_HEIGHT, z1 - z0, W.east - 0.15, 0, (z0 + z1) / 2, 'metal');
  }
}

/** Mezzanine along the west wall with its stair, guard rails and the lights under the deck. */
export function buildMezzanine(kit: Kit, m: Materials): void {
  const z0 = W.mezzanine.north;
  const z1 = W.mezzanine.south;
  const x0 = W.mezzanine.west + 0.25;
  const x1 = W.mezzanine.east;
  const top = W.mezzanine.top;
  const midX = (x0 + x1) / 2;
  const midZ = (z0 + z1) / 2;
  const steel = 0x41535e;
  const rail = 0xb98a12;

  kit.box(m.floor, x1 - x0, 0.1, z1 - z0, midX, top - 0.1, midZ, { tile: 3 });
  kit.collide(x1 - x0, 0.3, z1 - z0, midX, top - 0.3, midZ, 'concrete');
  for (const x of [x1 - 0.12, midX]) kit.box(m.steel, 0.2, 0.36, z1 - z0, x, top - 0.46, midZ, { color: steel });
  for (let z = z0 + 0.1; z <= z1; z += 1.22) kit.box(m.steel, x1 - x0, 0.18, 0.08, midX, top - 0.28, z, { color: steel });
  for (let z = z0 + 0.12; z <= z1; z += (z1 - z0 - 0.24) / 5) {
    kit.box(m.steel, 0.2, top - 0.46, 0.2, x1 - 0.12, 0, z, { color: steel, surface: 'metal' });
    kit.box(m.hazard, 0.3, 0.9, 0.3, x1 - 0.12, 0, z);
  }

  // Guard rail: posts, two rails and a kick plate. One thin collider per run.
  const guard = (ax: number, az: number, bx: number, bz: number): void => {
    const run = Math.hypot(bx - ax, bz - az);
    const posts = Math.max(1, Math.round(run / 1.4));
    for (let i = 0; i <= posts; i++) {
      const t = i / posts;
      kit.box(m.steel, 0.05, 1.1, 0.05, ax + (bx - ax) * t, top, az + (bz - az) * t, { color: rail });
    }
    for (const y of [0.55, 1.08]) kit.beam(m.steel, V(ax, top + y, az), V(bx, top + y, bz), 0.05, 0.05, rail);
    kit.beam(m.steel, V(ax, top + 0.06, az), V(bx, top + 0.06, bz), 0.02, 0.12, rail);
    const yaw = Math.atan2(bx - ax, bz - az);
    kit.collide(0.08, 1.1, run, (ax + bx) / 2, top, (az + bz) / 2, 'metal', yaw);
  };
  const stairEast = x0 + 1.45;
  guard(x1 - 0.05, z0, x1 - 0.05, z1);
  guard(stairEast, z0 + 0.05, x1 - 0.05, z0 + 0.05);
  guard(x0, z1 - 0.05, x1 - 0.05, z1 - 0.05);

  // Stair against the west wall, rising south onto the deck. 18 risers of 0.17 m.
  const risers = 18;
  const going = 0.3;
  const foot = z0 - risers * going;
  const stairX = x0 + 0.72;
  for (let i = 0; i < risers; i++) {
    kit.box(m.steel, 1.2, 0.04, going + 0.02, stairX, (i + 1) * (top / risers) - 0.04, foot + (i + 0.5) * going, { color: 0x3b4449 });
  }
  for (const x of [stairX - 0.62, stairX + 0.62]) {
    kit.beam(m.steel, V(x, -0.05, foot - 0.1), V(x, top - 0.1, z0), 0.06, 0.26, steel);
  }
  const railX = stairX + 0.62;
  kit.beam(m.steel, V(railX, 1.05, foot), V(railX, top + 1.05, z0), 0.05, 0.05, rail);
  kit.beam(m.steel, V(railX, 0.55, foot), V(railX, top + 0.55, z0), 0.04, 0.04, rail);
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    kit.box(m.steel, 0.05, 1.05, 0.05, railX, t * top, foot + t * (z0 - foot), { color: rail });
  }
  kit.collideRamp(V(stairX, 0, foot), V(stairX, top, z0), 1.3, 0.3, 'metal');
  kit.collideRamp(V(railX, 1.05, foot), V(railX, top + 1.05, z0), 0.08, 1.05, 'metal');

  // Strip lights under the deck and a row of high-bay lamps over the main aisle.
  for (let z = z0 + 3; z < z1; z += 5.5) {
    kit.box(m.matte, 0.16, 0.06, 1.5, midX, top - 0.52, z, { color: 0x2a2c2e });
    kit.box(m.lamp, 0.1, 0.02, 1.4, midX, top - 0.54, z, { color: 0xfff1d6 });
  }
  for (const z of [-17, -6, 5, 15]) {
    kit.post(m.rawSteel, 0.012, W.ridge - 7.4, RIDGE_X, 7.1, z, 0x2a2c2e, 5);
    const shade = new THREE.CylinderGeometry(0.1, 0.34, 0.26, 16, 1, true);
    kit.add(m.matte, shade, new THREE.Matrix4().makeTranslation(RIDGE_X, 6.98, z), 0x1d1f21);
    shade.dispose();
    const lens = new THREE.CircleGeometry(0.3, 16).rotateX(Math.PI / 2);
    kit.add(m.lamp, lens, new THREE.Matrix4().makeTranslation(RIDGE_X, 6.87, z), 0xffe3b0);
    lens.dispose();
  }
}

export interface RackRun {
  readonly x: number;
  readonly north: number;
  readonly south: number;
}

/** Pallet racking inside the shed: the two rows that form the main aisle plus a short row by the stair. */
export const RACKS: readonly RackRun[] = [
  { x: -25.1, north: -20.2, south: -4.8 },
  { x: -25.1, north: 1.2, south: 15.2 },
  { x: -35.1, north: -21, south: -12.6 },
];

const RACK_DEPTH = 1.1;
const RACK_BAY = 2.8;
const RACK_LEVELS = [1.55, 3.1, 4.65] as const;
const RACK_HEIGHT = 5.6;

/** Uprights, beams and loads. Each run gets one box collider; shelf loads are decoration. */
export function buildRacking(kit: Kit, m: Materials, props: Props): void {
  const blue = 0x24456e;
  const orange = 0xa85a26;
  const cartons = [0x8c7352, 0x7d6748, 0x94805e, 0x756650] as const;
  for (const run of RACKS) {
    const bays = Math.round((run.south - run.north) / RACK_BAY);
    const bay = (run.south - run.north) / bays;
    for (let i = 0; i <= bays; i++) {
      const z = run.north + i * bay;
      for (const dx of [-RACK_DEPTH / 2, RACK_DEPTH / 2]) kit.box(m.steel, 0.09, RACK_HEIGHT, 0.07, run.x + dx, 0, z, { color: blue });
      for (let y = 0.3; y < RACK_HEIGHT - 0.6; y += 1.2) {
        kit.beam(m.steel, V(run.x - RACK_DEPTH / 2, y, z), V(run.x + RACK_DEPTH / 2, y + 0.6, z), 0.03, 0.03, blue);
        kit.beam(m.steel, V(run.x + RACK_DEPTH / 2, y + 0.6, z), V(run.x - RACK_DEPTH / 2, y + 1.2, z), 0.03, 0.03, blue);
      }
    }
    for (const y of RACK_LEVELS) {
      for (const dx of [-RACK_DEPTH / 2, RACK_DEPTH / 2]) {
        kit.box(m.steel, 0.05, 0.12, run.south - run.north, run.x + dx, y - 0.12, (run.north + run.south) / 2, { color: orange });
      }
    }
    // Loads: a pallet with cartons or a wrapped block in most positions.
    for (let i = 0; i < bays; i++) {
      for (const level of [0, ...RACK_LEVELS]) {
        for (const slot of [0.27, 0.73]) {
          const z = run.north + (i + slot) * bay;
          const roll = kit.random();
          const height = kit.range(0.6, 1.15);
          const tint = kit.pick(cartons);
          const skew = kit.range(-0.06, 0.06);
          // The top shelves thin out at low detail; the floor row always stays.
          if (roll < 0.22 || (level > 2 && roll > 0.22 + 0.78 * kit.detail)) continue;
          kit.add(m.wood, props.pallet, kit.transform(run.x, level, z, skew + Math.PI / 2));
          if (roll > 0.72) {
            kit.box(m.wrap, 1.0, height, 1.1, run.x, level + 0.145, z, { yaw: skew });
            kit.box(m.matte, 1.01, 0.03, 1.11, run.x, level + 0.145 + height * 0.5, z, { yaw: skew, color: 0x2b2d2e });
          } else {
            props.cartons(run.x, level + 0.145, z, skew, 0.96, height, 1.12, tint);
          }
        }
      }
    }
    kit.collide(RACK_DEPTH + 0.1, RACK_HEIGHT, run.south - run.north + 0.1, run.x, 0, (run.north + run.south) / 2, 'metal');
  }
}
