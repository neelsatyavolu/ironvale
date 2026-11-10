import * as THREE from 'three/webgpu';
import type { Surface } from '../../world/types';
import type { Kit } from './kit';
import type { Materials } from './materials';
import { RAIL, WAREHOUSE, YARD } from './plan';

const WALL_HEIGHT = 3.4;
const WALL_TILE = 2.71;
const FENCE_HEIGHT = 3;
/** Height of the unseen barrier that stops anyone leaving over the edge. */
const LIMIT_HEIGHT = 16;
const GATE = { west: -3.6, east: 3.6 } as const;
const IDENTITY = new THREE.Matrix4();
const BALLAST_LIFT = 0.03;

/** Flat quad at height `y` with UVs taken from world position, so neighbouring pieces tile as one. */
function groundQuad(x0: number, x1: number, z0: number, z1: number, tile: number, y = 0): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const corners = [
    [x0, z1],
    [x1, z1],
    [x1, z0],
    [x0, z1],
    [x1, z0],
    [x0, z0],
  ] as const;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap(([x, z]) => [x, y, z]), 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(corners.flatMap(() => [0, 1, 0]), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(corners.flatMap(([x, z]) => [x / tile, -z / tile]), 2));
  return geometry;
}

function ground(
  kit: Kit,
  material: THREE.Material,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  tile: number,
  surface: Surface,
  lift = 0,
): void {
  const quad = groundQuad(x0, x1, z0, z1, tile, lift);
  kit.add(material, quad, IDENTITY);
  quad.dispose();
  kit.collide(x1 - x0, 1, z1 - z0, (x0 + x1) / 2, -1, (z0 + z1) / 2, surface);
}

/** Paving: wet asphalt yard, concrete quay apron, dry warehouse slab and the ballast bed. */
export function buildGround(kit: Kit, m: Materials): void {
  const outer = { west: -52, east: 54, south: 58 };
  ground(kit, m.quay, outer.west, outer.east, YARD.quay, YARD.apron, 3, 'concrete');
  ground(kit, m.floor, WAREHOUSE.west, WAREHOUSE.east, WAREHOUSE.north, WAREHOUSE.south, 3, 'concrete');
  // The ballast is drawn level with the sleeper tops; the collider stays flush with the yard.
  ground(kit, m.ballast, RAIL.bedWest, RAIL.bedEast, YARD.apron, outer.south, 2, 'gravel', BALLAST_LIFT);
  ground(kit, m.asphalt, outer.west, WAREHOUSE.east, YARD.apron, WAREHOUSE.north, 3, 'asphalt');
  ground(kit, m.asphalt, outer.west, WAREHOUSE.west, WAREHOUSE.north, WAREHOUSE.south, 3, 'asphalt');
  ground(kit, m.asphalt, outer.west, WAREHOUSE.east, WAREHOUSE.south, outer.south, 3, 'asphalt');
  ground(kit, m.asphalt, WAREHOUSE.east, RAIL.bedWest, YARD.apron, outer.south, 3, 'asphalt');
  ground(kit, m.asphalt, RAIL.bedEast, outer.east, YARD.apron, outer.south, 3, 'asphalt');

  // Concrete edging either side of the ballast, flush with the yard.
  for (const x of [RAIL.bedWest, RAIL.bedEast]) {
    kit.box(m.wall, 0.3, 0.05, 80, x, -0.02, 10, { tile: WALL_TILE });
  }
}

/** Wall, fence and the unseen limits above them. */
export function buildPerimeter(kit: Kit, m: Materials): void {
  const wall = (x0: number, x1: number, z0: number, z1: number): void => {
    const width = Math.max(0.3, x1 - x0);
    const depth = Math.max(0.3, z1 - z0);
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    kit.box(m.wall, width, WALL_HEIGHT, depth, cx, 0, cz, { tile: WALL_TILE, surface: 'concrete' });
    // Coping stone and a run of pier caps so the top edge is not a razor line.
    kit.box(m.wall, width + 0.12, 0.1, depth + 0.12, cx, WALL_HEIGHT, cz, { tile: WALL_TILE });
    const along = Math.max(width, depth);
    for (let d = -along / 2; d <= along / 2 + 0.01; d += 6) {
      const px = width > depth ? cx + d : cx;
      const pz = width > depth ? cz : cz + d;
      kit.box(m.wall, 0.5, WALL_HEIGHT + 0.25, 0.5, px, 0, pz, { tile: WALL_TILE });
    }
  };

  // South wall with the vehicle gate, then the two stretches of west wall either side of the warehouse.
  wall(YARD.west - 0.3, GATE.west, YARD.south, YARD.south + 0.3);
  wall(GATE.east, YARD.east + 0.3, YARD.south, YARD.south + 0.3);
  wall(YARD.west - 0.3, YARD.west, WAREHOUSE.south, YARD.south);
  wall(YARD.west - 0.3, YARD.west, YARD.quay, WAREHOUSE.north);
  buildGate(kit, m);
  buildFence(kit, m);

  // Limits: nothing gets past these, whatever it climbs on.
  const span = YARD.south - YARD.quay;
  const mid = (YARD.south + YARD.quay) / 2;
  kit.collide(0.5, LIMIT_HEIGHT, span + 2, YARD.west - 0.55, 0, mid, 'concrete');
  kit.collide(0.5, LIMIT_HEIGHT, span + 2, YARD.east + 0.45, 0, mid, 'metal');
  kit.collide(90, LIMIT_HEIGHT, 0.5, 0, 0, YARD.south + 0.55, 'concrete');
  kit.collide(90, LIMIT_HEIGHT, 0.5, 0, 0, YARD.quay - 0.4, 'metal');
}

/** Closed sliding gate of sheet steel on a tube frame, with a track and a warning lamp. */
function buildGate(kit: Kit, m: Materials): void {
  const width = GATE.east - GATE.west;
  const z = YARD.south + 0.12;
  const paint = 0x2f4a43;
  kit.box(m.cladding, width + 0.6, 2.6, 0.05, 0.3, 0.18, z, { tile: 2, color: 0x6f8a80 });
  kit.box(m.steel, width + 0.8, 0.12, 0.1, 0.3, 0.12, z, { color: paint });
  kit.box(m.steel, width + 0.8, 0.12, 0.1, 0.3, 2.78, z, { color: paint });
  for (let x = GATE.west; x <= GATE.east + 0.7; x += 1.2) kit.box(m.steel, 0.1, 2.7, 0.1, x, 0.15, z - 0.02, { color: paint });
  kit.beam(m.steel, new THREE.Vector3(GATE.west, 0.3, z - 0.08), new THREE.Vector3(GATE.east, 2.7, z - 0.08), 0.07, 0.07, paint);
  kit.box(m.rawSteel, width * 2, 0.03, 0.08, GATE.east, 0, z, { color: 0x4a4744 });
  kit.box(m.hazard, 0.4, 1.4, 0.4, GATE.west - 0.5, 0, YARD.south - 0.35);
  kit.box(m.hazard, 0.4, 1.4, 0.4, GATE.east + 0.5, 0, YARD.south - 0.35);
  kit.collide(width + 1, WALL_HEIGHT, 0.3, 0.3, 0, YARD.south + 0.15, 'metal');
  kit.collide(0.4, 1.4, 0.4, GATE.west - 0.5, 0, YARD.south - 0.35, 'concrete');
  kit.collide(0.4, 1.4, 0.4, GATE.east + 0.5, 0, YARD.south - 0.35, 'concrete');
}

/** Chain-link fence along the east side on a low concrete kerb. */
function buildFence(kit: Kit, m: Materials): void {
  const x = YARD.east;
  const z0 = YARD.quay;
  const z1 = YARD.south;
  const length = z1 - z0;
  const mid = (z0 + z1) / 2;
  kit.box(m.wall, 0.25, 0.35, length, x, 0, mid, { tile: WALL_TILE });

  const mesh = new THREE.PlaneGeometry(length, FENCE_HEIGHT - 0.35);
  const uv = mesh.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * length, uv.getY(i) * (FENCE_HEIGHT - 0.35));
  kit.add(m.chainlink, mesh, new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(x, 0.35 + (FENCE_HEIGHT - 0.35) / 2, mid));
  mesh.dispose();

  const galvanised = 0x9a9d9c;
  for (let z = z0; z <= z1 + 0.01; z += 3) {
    kit.post(m.rawSteel, 0.035, FENCE_HEIGHT + 0.1, x, 0, z, galvanised, 6);
    // Cranked arm carrying three strands of wire.
    kit.beam(m.rawSteel, new THREE.Vector3(x, FENCE_HEIGHT + 0.05, z), new THREE.Vector3(x - 0.3, FENCE_HEIGHT + 0.4, z), 0.03, 0.03, galvanised);
  }
  for (const [dx, dy] of [
    [-0.08, 0.14],
    [-0.18, 0.26],
    [-0.28, 0.38],
  ] as const) {
    kit.box(m.rawSteel, 0.012, 0.012, length, x + dx, FENCE_HEIGHT + dy, mid, { color: galvanised });
  }
  kit.box(m.rawSteel, 0.03, 0.03, length, x, FENCE_HEIGHT - 0.02, mid, { color: galvanised });
  kit.box(m.rawSteel, 0.03, 0.03, length, x, 1.6, mid, { color: galvanised });
  kit.collide(0.12, FENCE_HEIGHT, length, x, 0, mid, 'metal');
}

/** Quay edge: coping, face down to the water, bollards, a post-and-chain line, crane rails and the sea. */
export function buildQuay(kit: Kit, m: Materials): void {
  const edge = YARD.quay;
  const west = YARD.west - 10;
  const east = YARD.east + 12;
  const length = east - west;
  const mid = (west + east) / 2;

  // Quay face and yellow coping.
  kit.box(m.wall, length, 4, 0.5, mid, -4, edge - 0.25, { tile: WALL_TILE });
  kit.box(m.wall, length, 0.2, 0.5, mid, 0, edge + 0.25, { tile: WALL_TILE, color: 0xe0b23a, surface: 'concrete' });
  // Rubber fenders hanging on the face.
  for (let x = west + 4; x < east; x += 7) kit.box(m.matte, 0.9, 1.9, 0.35, x, -2.1, edge - 0.6, { color: 0x101112 });

  const black = 0x15171a;
  for (let x = YARD.west + 6; x < YARD.east; x += 12) {
    const base = new THREE.CylinderGeometry(0.2, 0.27, 0.5, 14);
    kit.add(m.steel, base, new THREE.Matrix4().makeTranslation(x, 0.25, edge + 1.1), black);
    base.dispose();
    const head = new THREE.CylinderGeometry(0.33, 0.26, 0.16, 14);
    kit.add(m.steel, head, new THREE.Matrix4().makeTranslation(x, 0.58, edge + 1.1), black);
    head.dispose();
    kit.collide(0.55, 0.66, 0.55, x, 0, edge + 1.1, 'metal');
  }

  // Post-and-chain line along the edge. The chain is two straight runs; sag would not read at this size.
  const safety = 0xb98a12;
  for (let x = YARD.west + 1.5; x <= YARD.east; x += 3) kit.post(m.steel, 0.04, 1.05, x, 0.2, edge + 0.25, safety, 8);
  for (const y of [0.72, 1.18]) kit.box(m.rawSteel, YARD.east - YARD.west - 1.5, 0.025, 0.025, 0.75, y, edge + 0.25, { color: 0x5b5d5e });

  // Crane rails set into the apron.
  for (const z of [edge + 2.6, edge + 13.4]) {
    kit.box(m.rawSteel, length, 0.02, 0.09, mid, 0, z, { color: 0x6b6763 });
    kit.box(m.matte, length, 0.008, 0.34, mid, 0, z, { color: 0x1c1b1a });
  }

  const sea = new THREE.PlaneGeometry(1500, 760).rotateX(-Math.PI / 2);
  kit.add(m.water, sea, new THREE.Matrix4().makeTranslation(0, -2.4, edge - 380));
  sea.dispose();
}
