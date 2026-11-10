import * as THREE from 'three/webgpu';
import { archedPanel, archInsert, archSurround } from './arch';
import { Frame, PLASTER_TILE, WALL_THICKNESS, type Kit } from './facade';
import { addGableRoof, addHouse, type GroundOpening, type HouseSpec } from './house';
import { CAFE, NET_STORE, PASSAGE, QUAY_NORTH, STREET_NORTH, STREET_SOUTH, TERRACE_EDGE, TERRACE_NORTH, TERRACE_Y } from './layout';
import { wallPieces } from './pieces';

const window = (u: number, kind: GroundOpening['kind'] = 'window'): GroundOpening => ({ u, w: 0.9, h: 1.15, kind, sill: 1.08 });

const FRONT = { z0: STREET_SOUTH, z1: QUAY_NORTH } as const;
const SECOND = { z0: TERRACE_EDGE, z1: STREET_NORTH, storeyHeight: TERRACE_Y, buried: { n: 1 } } as const;
const NORTH = { z0: TERRACE_NORTH - 10, z1: TERRACE_NORTH, base: TERRACE_Y, detail: ['s'] } as const;
const PASSAGE_HEIGHT = 2.9;
const PASSAGE_OPENING: GroundOpening = { u: (PASSAGE.x0 + PASSAGE.x1) / 2 - 3, w: PASSAGE.x1 - PASSAGE.x0, h: PASSAGE_HEIGHT, kind: 'open' };

const HOUSES: readonly HouseSpec[] = [
  // Front row, facing the quay.
  { ...FRONT, x0: -52, x1: -38, storeys: 2, wall: 0, paint: 1, detail: ['n', 's', 'e'], balconies: 0.3 },
  {
    ...FRONT,
    x0: NET_STORE.x0,
    x1: NET_STORE.x1,
    storeys: 2,
    wall: 2,
    paint: 0,
    detail: ['n', 's', 'w'],
    hollow: true,
    ground: {
      s: [{ u: 5.25, w: 2.6, h: 2.5, kind: 'open' }, window(1.6), window(8.9, 'shut')],
      n: [{ u: 7.5, w: 1.2, h: 2.15, kind: 'open' }, window(2.6)],
      w: [window(4)],
    },
  },
  { ...FRONT, x0: -25, x1: -16, storeys: 3, wall: 6, paint: 2, detail: ['n', 's', 'e'], balconies: 0.35, trim: true },
  {
    ...FRONT,
    x0: CAFE.x0,
    x1: CAFE.x1,
    storeys: 2,
    wall: 5,
    paint: 4,
    detail: ['n', 's', 'w'],
    hollow: true,
    balconies: 0.3,
    ground: {
      s: [
        { u: 4, w: 2.7, h: 2.8, kind: 'open' },
        { u: 10.6, w: 2.7, h: 2.8, kind: 'open' },
      ],
      n: [{ u: 9, w: 1.3, h: 2.2, kind: 'open' }, { u: 3.6, w: 1.1, h: 1.3, kind: 'window', sill: 0.95 }, { u: 12.6, w: 1.1, h: 1.3, kind: 'window', sill: 0.95 }],
      w: [{ u: 4, w: 1.1, h: 2.15, kind: 'open' }],
    },
  },
  {
    ...FRONT,
    x0: 3,
    x1: 13,
    storeys: 3,
    wall: 3,
    paint: 1,
    detail: ['n', 's'],
    collide: false,
    trim: true,
    balconies: 0.3,
    ground: { s: [PASSAGE_OPENING, window(2)], n: [PASSAGE_OPENING, window(2, 'shut')] },
  },
  { ...FRONT, x0: 13, x1: 23, storeys: 2, wall: 2, paint: 4, detail: ['n', 's'], balconies: 0.25 },
  { ...FRONT, x0: 23, x1: 33, storeys: 3, wall: 0, paint: 2, detail: ['n', 's', 'e'], balconies: 0.4, trim: true },
  { ...FRONT, x0: 36.5, x1: 52, storeys: 2, wall: 1, paint: 0, detail: ['n', 's', 'w'], balconies: 0.2 },

  // Second row, backed onto the terrace. Their first floor is the terrace's ground floor.
  { ...SECOND, x0: -52, x1: -42, storeys: 3, wall: 4, paint: 2, detail: ['s', 'n'], balconies: 0.2 },
  { ...SECOND, x0: -42, x1: -32, storeys: 2, wall: 3, paint: 3, detail: ['s', 'n', 'e'], ground: { e: [window(10.6)] } },
  { ...SECOND, x0: -29.5, x1: -20, storeys: 3, wall: 1, paint: 1, detail: ['s', 'n', 'w'], ground: { w: [window(10.6)] }, trim: true },
  { ...SECOND, x0: -20, x1: -12, storeys: 2, wall: 5, paint: 0, detail: ['s', 'n', 'e'], balconies: 0.3 },
  { ...SECOND, x0: 12, x1: 21, storeys: 3, wall: 6, paint: 4, detail: ['s', 'n', 'w'], balconies: 0.3, trim: true },
  { ...SECOND, x0: 21, x1: 30, storeys: 2, wall: 2, paint: 1, detail: ['s', 'n', 'e'], ground: { e: [] } },
  { ...SECOND, x0: 34, x1: 43, storeys: 2, wall: 0, paint: 2, detail: ['s', 'n', 'w'], ground: { w: [] } },
  { ...SECOND, x0: 43, x1: 52, storeys: 3, wall: 4, paint: 3, detail: ['s', 'n'], balconies: 0.25 },

  // North row: the backdrop behind the terrace.
  { ...NORTH, x0: -54, x1: -40, storeys: 3, wall: 5, paint: 0, balconies: 0.3 },
  { ...NORTH, x0: -40, x1: -28, storeys: 4, wall: 1, paint: 4, balconies: 0.2 },
  { ...NORTH, x0: -28, x1: -15, storeys: 3, wall: 2, paint: 1, balconies: 0.35, trim: true },
  { ...NORTH, x0: -15, x1: -9, storeys: 3, wall: 3, paint: 2 },
  { ...NORTH, x0: 13.5, x1: 26, storeys: 4, wall: 0, paint: 3, balconies: 0.3 },
  { ...NORTH, x0: 26, x1: 40, storeys: 3, wall: 6, paint: 0, trim: true, balconies: 0.3 },
  { ...NORTH, x0: 40, x1: 54, storeys: 3, wall: 4, paint: 2, balconies: 0.25 },

  // Town beyond the walls, seen over them.
  { x0: -63, x1: -53.4, z0: -12, z1: 5, storeys: 3, wall: 6, paint: 3, detail: ['e'], collide: false, ridge: 'z' },
  // A low boat shed, so the evening sun reaches the west end of the quay over the wave wall.
  { x0: -62, x1: -53.4, z0: 6, z1: 19, storeys: 1, wall: 2, paint: 1, detail: ['e', 's'], collide: false, ridge: 'z' },
  { x0: 53.4, x1: 63, z0: -13, z1: 4, storeys: 3, wall: 5, paint: 2, detail: ['w'], collide: false, ridge: 'z' },
  { x0: 53.4, x1: 62, z0: 5, z1: 18, storeys: 2, wall: 3, paint: 0, detail: ['w', 's'], collide: false, ridge: 'z' },
];

export function addBuildings(kit: Kit): void {
  for (const spec of HOUSES) addHouse(kit, spec);
  addPassage(kit);
  addCafeShell(kit);
  addNetStoreShell(kit);
  addChurch(kit);
}

/** Vaulted way through the terracotta house, from the square to the quay. */
function addPassage(kit: Kit): void {
  const { batch, colliders, mats } = kit;
  const plaster = mats.plaster[3]!;
  const { x0, x1 } = PASSAGE;
  const cx = (x0 + x1) / 2;
  const top = 3 * 3 + 0.35;
  batch.span(mats.plasterShade, x0 - 0.3, x0, 0, PASSAGE_HEIGHT, FRONT.z0 + WALL_THICKNESS, FRONT.z1 - WALL_THICKNESS, { tile: PLASTER_TILE });
  batch.span(mats.plasterShade, x1, x1 + 0.3, 0, PASSAGE_HEIGHT, FRONT.z0 + WALL_THICKNESS, FRONT.z1 - WALL_THICKNESS, { tile: PLASTER_TILE });
  batch.span(mats.plasterShade, x0, x1, PASSAGE_HEIGHT, PASSAGE_HEIGHT + 0.1, FRONT.z0, FRONT.z1, { tile: PLASTER_TILE });
  for (let z = FRONT.z0 + 1.2; z < FRONT.z1 - 0.6; z += 1.4) {
    batch.span(mats.planksShade, x0, x1, PASSAGE_HEIGHT - 0.2, PASSAGE_HEIGHT, z - 0.09, z + 0.09, { tile: 1.5, swap: true });
  }
  const insert = archInsert(x1 - x0, PASSAGE_HEIGHT, 3.1, 2.05, 0.7, WALL_THICKNESS);
  batch.place(plaster, insert, cx, 0, FRONT.z1 - WALL_THICKNESS / 2, 0, 1, PLASTER_TILE);
  batch.place(plaster, insert, cx, 0, FRONT.z0 + WALL_THICKNESS / 2, 0, 1, PLASTER_TILE);
  insert.dispose();
  const surround = archSurround(3.1, 2.05, 0.7, 0.22, 0.06);
  batch.place(mats.stoneLight, surround, cx, 0, FRONT.z1, 0, 1, 1.4);
  batch.place(mats.stoneLight, surround, cx, 0, FRONT.z0, Math.PI, 1, 1.4);
  surround.dispose();

  colliders.span(3, x0, 0, top, FRONT.z0, FRONT.z1, 'plaster');
  colliders.span(x1, 13, 0, top, FRONT.z0, FRONT.z1, 'plaster');
  colliders.span(x0, x1, PASSAGE_HEIGHT, top, FRONT.z0, FRONT.z1, 'plaster');
  for (const z of [FRONT.z0, FRONT.z1 - WALL_THICKNESS]) {
    colliders.span(x0, x0 + 0.2, 0, PASSAGE_HEIGHT, z, z + WALL_THICKNESS, 'plaster');
    colliders.span(x1 - 0.2, x1, 0, PASSAGE_HEIGHT, z, z + WALL_THICKNESS, 'plaster');
  }
}

/** Floor, ceiling and beams for a room behind hollow walls. */
function addRoom(kit: Kit, x0: number, x1: number, z0: number, z1: number): void {
  const { batch, mats } = kit;
  const t = WALL_THICKNESS + 0.03;
  batch.span(mats.planksShade, x0 + t, x1 - t, 0, 0.025, z0 + t, z1 - t, { tile: 1.6 });
  batch.span(mats.plasterShade, x0 + t, x1 - t, 2.92, 3, z0 + t, z1 - t, { tile: PLASTER_TILE });
  for (let x = x0 + 1.1; x < x1 - 0.6; x += 1.7) {
    batch.span(mats.planksShade, x - 0.09, x + 0.09, 2.72, 2.92, z0 + t, z1 - t, { tile: 1.5 });
  }
}

function addCafeShell(kit: Kit): void {
  const { batch, mats } = kit;
  addRoom(kit, CAFE.x0, CAFE.x1, CAFE.z0, CAFE.z1);
  const insert = archInsert(2.7, 2.8, 2.4, 1.9, 0.78, WALL_THICKNESS);
  const surround = archSurround(2.4, 1.9, 0.78, 0.18, 0.05);
  for (const u of [4, 10.6]) {
    batch.place(mats.plaster[5]!, insert, CAFE.x0 + u, 0, CAFE.z1 - WALL_THICKNESS / 2, 0, 1, PLASTER_TILE);
    batch.place(mats.stoneLight, surround, CAFE.x0 + u, 0, CAFE.z1, 0, 1, 1.4);
  }
  insert.dispose();
  surround.dispose();
}

function addNetStoreShell(kit: Kit): void {
  const { batch, mats } = kit;
  addRoom(kit, NET_STORE.x0, NET_STORE.x1, NET_STORE.z0, NET_STORE.z1);
  // Timber lintel and the big doors folded back against the quay wall.
  const frame = new Frame(batch, 's', NET_STORE.x0, NET_STORE.z1, 0);
  frame.box(mats.planks, 3.75, 6.75, 2.5, 2.72, -0.2, 0.06, { tile: 1.5 });
  frame.leaf(mats.paint[0]!, 3.95, 1, 1.3, 0.04, 2.5, Math.PI - 0.12);
  frame.leaf(mats.paint[0]!, 6.55, -1, 1.3, 0.04, 2.5, Math.PI - 0.35);
}

/** Parish church and bell tower on the terrace, the landmark above the square. */
function addChurch(kit: Kit): void {
  const { batch, colliders, mats } = kit;
  const plaster = mats.plaster[2]!;
  const x0 = -9;
  const x1 = 9;
  const z1 = TERRACE_NORTH;
  const z0 = z1 - 13;
  const base = TERRACE_Y;
  const height = 9.6;
  batch.span(plaster, x0, x1, base, base + height, z0, z1, { tile: PLASTER_TILE });
  colliders.span(x0, x1, base, base + height, z0, z1, 'plaster');
  addGableRoof(kit, { x0, x1, z0, z1 }, base + height, 'z', plaster);

  const front = new Frame(batch, 's', x0, z1, base);
  for (const u of [0, 5.2, 12.2, 17.4]) front.box(mats.stoneLight, u, u + 0.6, 0, height, 0, 0.16, { tile: 1.5 });
  front.box(mats.stoneLight, -0.1, 18.1, height - 0.5, height - 0.1, 0, 0.24, { tile: 1.5 });
  front.box(mats.stoneLight, 0.6, 17.4, 5.0, 5.22, 0, 0.12, { tile: 1.5 });
  front.box(mats.stone, 0, 18, 0, 0.7, 0, 0.08, { tile: 2 });
  const door = archedPanel(2.6, 2.5, 1.3);
  const surround = archSurround(2.6, 2.5, 1.3, 0.34, 0.2);
  batch.place(mats.paint[2]!, door, 0, base, z1 + 0.03, 0, 1, 1);
  batch.place(mats.stoneLight, surround, 0, base, z1, 0, 1, 1.4);
  door.dispose();
  surround.dispose();
  const rose = new THREE.CircleGeometry(1.05, 24);
  batch.place(mats.glassLit, rose, 0, base + 7.1, z1 + 0.03);
  rose.dispose();
  const rim = new THREE.TorusGeometry(1.12, 0.13, 8, 28);
  batch.place(mats.stoneLight, rim, 0, base + 7.1, z1 + 0.04);
  rim.dispose();
  for (const [u0, u1] of [
    [2.3, 3.5],
    [14.5, 15.7],
  ] as const) {
    front.box(mats.glass, u0, u1, 2.2, 4.4, 0, 0.03);
    front.box(mats.stoneLight, u0 - 0.14, u1 + 0.14, 2.06, 2.2, 0, 0.1, { tile: 1.5 });
    front.box(mats.stoneLight, u0 - 0.14, u1 + 0.14, 4.4, 4.54, 0, 0.1, { tile: 1.5 });
  }
  // Two broad steps to the door.
  for (let i = 0; i < 2; i++) {
    const reach = 0.5 * (2 - i);
    batch.span(mats.stoneLight, -2.6 + i * 0.3, 2.6 - i * 0.3, base, base + 0.15 * (i + 1), z1, z1 + reach, { tile: 1.2 });
    colliders.span(-2.6 + i * 0.3, 2.6 - i * 0.3, base, base + 0.15 * (i + 1), z1, z1 + reach, 'concrete');
  }

  // Bell tower.
  const tx0 = 9;
  const tx1 = 13.6;
  const tz0 = z1 - 4.6;
  const towerHeight = 17.5;
  const belfry = { v0: 12.6, v1: 15.4 };
  for (const side of ['s', 'e', 'w', 'n'] as const) {
    const frame = new Frame(batch, side, side === 'e' ? tx1 : tx0, side === 's' ? z1 : tz0, base);
    const opening = { u0: 1.55, u1: 3.05, v0: belfry.v0, v1: belfry.v1 };
    for (const piece of wallPieces(4.6, towerHeight, [opening])) {
      frame.box(plaster, piece.u0, piece.u1, piece.v0, piece.v1, -0.4, 0, { tile: PLASTER_TILE });
    }
    frame.box(mats.stoneLight, -0.08, 4.68, 11.7, 11.95, 0, 0.12, { tile: 1.5 });
    frame.box(mats.stoneLight, -0.1, 4.7, towerHeight - 0.3, towerHeight, 0, 0.18, { tile: 1.5 });
    frame.box(mats.stoneLight, 1.4, 3.2, belfry.v0 - 0.14, belfry.v0, -0.4, 0.1, { tile: 1.5 });
    if (side === 's' || side === 'w') {
      frame.box(mats.glass, 1.9, 2.7, 5.2, 6.8, 0, 0.03);
      frame.box(mats.stoneLight, 1.8, 2.8, 5.06, 5.2, 0, 0.1, { tile: 1.5 });
    }
  }
  const cxT = (tx0 + tx1) / 2;
  const czT = (tz0 + z1) / 2;
  batch.span(mats.iron, tx0 + 0.4, tx1 - 0.4, base + belfry.v0 - 0.2, base + belfry.v0, tz0 + 0.4, z1 - 0.4);
  batch.span(mats.planksShade, tx0 + 0.4, tx1 - 0.4, base + belfry.v1, base + belfry.v1 + 0.2, tz0 + 0.4, z1 - 0.4, { tile: 1.5 });
  const bell = new THREE.LatheGeometry(
    [
      [0.001, 1.0],
      [0.18, 0.98],
      [0.3, 0.7],
      [0.38, 0.3],
      [0.55, 0.0],
    ].map(([x, y]) => new THREE.Vector2(x, y)),
    16,
  );
  batch.place(mats.brass, bell, cxT, base + belfry.v0 + 1.1, czT);
  bell.dispose();
  batch.span(mats.planksShade, tx0 + 0.4, tx1 - 0.4, base + belfry.v0 + 2.1, base + belfry.v0 + 2.25, czT - 0.08, czT + 0.08, { tile: 1.5 });
  const spire = new THREE.ConeGeometry(3.6, 3.4, 4, 1);
  spire.rotateY(Math.PI / 4);
  batch.place(mats.roof, spire, cxT, base + towerHeight + 1.7, czT, 0, 1, 2.5);
  spire.dispose();
  batch.span(mats.iron, cxT - 0.03, cxT + 0.03, base + towerHeight + 3.3, base + towerHeight + 4.5, czT - 0.03, czT + 0.03);
  batch.span(mats.iron, cxT - 0.3, cxT + 0.3, base + towerHeight + 4.0, base + towerHeight + 4.06, czT - 0.03, czT + 0.03);
  colliders.span(tx0, tx1, base, base + towerHeight, tz0, z1, 'plaster');
}
