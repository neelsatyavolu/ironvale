import type * as THREE from 'three/webgpu';
import { seededRandom } from '../../core/random';
import type { Kit } from './facade';
import { CAFE, NET_STORE } from './layout';
import { adCell, decalQuad, posterCell, type AtlasCell } from './posters';

/** Below the window sills (0.95 m), rail included. */
const DADO = 0.86;
const SEED = 0x51ca7;
const SKIN = 0.018;
/** Inner wall face, measured in from the footprint (the shell is 0.36 thick with a 0.03 lining). */
const INNER = 0.39;

interface Room {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}

type Gap = readonly [number, number];

/** Stretches of [from, to] left after cutting the gaps out, dropping slivers. */
export function between(from: number, to: number, gaps: readonly Gap[]): Gap[] {
  const out: Gap[] = [];
  let at = from;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (a - at > 0.12) out.push([at, a]);
    at = Math.max(at, b);
  }
  if (to - at > 0.12) out.push([at, to]);
  return out;
}

/**
 * Painted boarding to waist height with a rail on top and a skirting under
 * it, run round a room and broken at the doorways. Wall-mounted and thinner
 * than a hand, so it needs no collision.
 */
function addDado(kit: Kit, room: Room, panel: THREE.Material, gaps: { n: readonly Gap[]; s: readonly Gap[]; w: readonly Gap[]; e: readonly Gap[] }): void {
  const { batch, mats } = kit;
  const strip = (x0: number, x1: number, z0: number, z1: number, out: readonly [number, number]): void => {
    const [ox, oz] = out;
    const grow = (d: number): [number, number, number, number] => [x0 + Math.min(0, ox * d), x1 + Math.max(0, ox * d), z0 + Math.min(0, oz * d), z1 + Math.max(0, oz * d)];
    const [ax0, ax1, az0, az1] = grow(SKIN);
    batch.span(panel, ax0, ax1, 0.02, DADO, az0, az1, { tile: 0.9, swap: true });
    const [bx0, bx1, bz0, bz1] = grow(SKIN + 0.022);
    batch.span(mats.planksShade, bx0, bx1, DADO, DADO + 0.055, bz0, bz1, { tile: 1.2 });
    batch.span(mats.planksShade, bx0, bx1, 0.02, 0.14, bz0, bz1, { tile: 1.2 });
  };
  for (const [a, b] of between(room.x0, room.x1, gaps.n)) strip(a, b, room.z0, room.z0, [0, 1]);
  for (const [a, b] of between(room.x0, room.x1, gaps.s)) strip(a, b, room.z1, room.z1, [0, -1]);
  for (const [a, b] of between(room.z0, room.z1, gaps.w)) strip(room.x0, room.x0, a, b, [1, 0]);
  for (const [a, b] of between(room.z0, room.z1, gaps.e)) strip(room.x1, room.x1, a, b, [-1, 0]);
}

/** Framed picture, mirror or board hung flat on a wall. `along` is x for a north or south wall, z for the west wall. */
function addFrame(kit: Kit, wall: 'n' | 's' | 'w', room: Room, along: number, y: number, w: number, h: number, face: THREE.Material, print?: number): void {
  const { batch, mats } = kit;
  const rim = 0.045;
  const put = (material: THREE.Material, half: number, tall: number, depth: number): void => {
    if (wall === 'w') batch.span(material, room.x0, room.x0 + depth, y - tall / 2, y + tall / 2, along - half, along + half, { tile: 0.8 });
    else if (wall === 'n') batch.span(material, along - half, along + half, y - tall / 2, y + tall / 2, room.z0, room.z0 + depth, { tile: 0.8 });
    else batch.span(material, along - half, along + half, y - tall / 2, y + tall / 2, room.z1 - depth, room.z1, { tile: 0.8 });
  };
  put(mats.planksShade, w / 2, h, 0.03);
  put(face, w / 2 - rim, h - rim * 2, 0.036);
  if (print === undefined) return;
  // An old bill under the glass: the middle of the sheet, cropped to the frame.
  const pw = w - rim * 2;
  const ph = h - rim * 2;
  const cell = cropCell(posterCell(print), pw / ph);
  const out = 0.04;
  if (wall === 'w') batch.add(mats.poster, decalQuad(cell, pw, ph, room.x0 + out, y, along, Math.PI / 2));
  else if (wall === 'n') batch.add(mats.poster, decalQuad(cell, pw, ph, along, y, room.z0 + out, 0));
  else batch.add(mats.poster, decalQuad(cell, pw, ph, along, y, room.z1 - out, Math.PI));
}

/** Largest centred part of a portrait poster cell (2:3) with the given width-to-height ratio, kept off the torn edges. */
export function cropCell(cell: AtlasCell, aspect: number): AtlasCell {
  const [u0, v0, u1, v1] = cell;
  const inset = 0.12;
  const du = (u1 - u0) * (1 - inset * 2);
  const dv = (v1 - v0) * (1 - inset * 2);
  // The cell is 2 wide by 3 tall, so a full-width crop is `2 / 3 / aspect` of its height.
  const tall = Math.min(1, 2 / 3 / aspect);
  const wide = Math.min(1, (aspect * 3) / 2);
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  return [cu - (du * wide) / 2, cv - (dv * tall) / 2, cu + (du * wide) / 2, cv + (dv * tall) / 2];
}

/** Row of bottles and jars on a bracketed shelf against the north wall. */
function addShelf(kit: Kit, room: Room, x0: number, x1: number, y: number, random: () => number): void {
  const { batch, mats } = kit;
  batch.span(mats.planksShade, x0, x1, y, y + 0.03, room.z0, room.z0 + 0.2, { tile: 1.2 });
  for (const x of [x0 + 0.12, x1 - 0.12]) batch.span(mats.iron, x - 0.012, x + 0.012, y - 0.16, y, room.z0, room.z0 + 0.17);
  const glass = [mats.glass, mats.foliage, mats.brass, mats.terracotta];
  for (let x = x0 + 0.1; x < x1 - 0.08; x += 0.13 + random() * 0.16) {
    const tall = 0.14 + random() * 0.16;
    batch.box(glass[Math.floor(random() * glass.length)]!, 0.06, tall, 0.06, x, y + 0.03 + tall / 2, room.z0 + 0.1);
  }
}

/**
 * What makes the two enterable rooms read as used rather than as bare boxes:
 * panelling, pictures, a slate menu, shelves and hooks. Everything is on the
 * walls, clear of the floor, so movement and bot routes are untouched. Uses
 * its own random stream.
 */
export function addRoomDressing(kit: Kit): void {
  const { batch, mats } = kit;
  const t = INNER;
  const cafe: Room = { x0: CAFE.x0 + t, x1: CAFE.x1 - t, z0: CAFE.z0 + t, z1: CAFE.z1 - t };
  addDado(kit, cafe, mats.paint[1]!, {
    n: [[-3.72, -2.28]],
    s: [
      [-9.45, -6.55],
      [-2.85, 0.05],
    ],
    w: [[5.38, 6.62]],
    // The bar and its shelves cover the east wall.
    e: [[cafe.z0, cafe.z1]],
  });
  addFrame(kit, 'n', cafe, -10.3, 1.75, 0.62, 0.48, mats.hill, 2);
  addFrame(kit, 'n', cafe, -6.35, 1.72, 0.5, 0.66, mats.plaster[1]!, 3);
  addFrame(kit, 'n', cafe, -1.2, 1.78, 0.85, 0.55, mats.tarp);
  addFrame(kit, 's', cafe, -10.6, 1.75, 0.9, 0.62, mats.glass);
  addFrame(kit, 's', cafe, -4.7, 1.7, 1.3, 0.85, mats.castIron);
  addFrame(kit, 's', cafe, 1.3, 1.75, 0.6, 0.75, mats.plaster[4]!, 1);
  addFrame(kit, 'w', cafe, 3.8, 1.75, 0.95, 0.6, mats.hill, 0);
  addFrame(kit, 'w', cafe, 8.2, 1.7, 0.55, 0.7, mats.roof, 4);
  addShelf(kit, cafe, -5.6, -4.1, 2.02, seededRandom(SEED));
  // Chalk lines on the slate menu between the arches.
  for (let row = 0; row < 6; row++) {
    const w = 0.5 + ((row * 37) % 5) * 0.11;
    batch.span(mats.plasterWhite, -5.25, -5.25 + w, 1.98 - row * 0.115, 1.995 - row * 0.115, cafe.z1 - 0.04, cafe.z1 - 0.036);
  }
  // Coat hooks on a board by the west door.
  batch.span(mats.planksShade, cafe.x0, cafe.x0 + 0.03, 1.62, 1.72, 6.85, 7.75, { tile: 1.2 });
  for (let z = 6.97; z < 7.7; z += 0.165) batch.span(mats.brass, cafe.x0 + 0.03, cafe.x0 + 0.085, 1.655, 1.675, z - 0.008, z + 0.008);

  const store: Room = { x0: NET_STORE.x0 + t, x1: NET_STORE.x1 - t, z0: NET_STORE.z0 + t, z1: NET_STORE.z1 - t };
  addDado(kit, store, mats.paint[3]!, {
    n: [[NET_STORE.x0 + 6.8, NET_STORE.x0 + 8.2]],
    s: [[NET_STORE.x0 + 3.85, NET_STORE.x0 + 6.65]],
    // Racking on the west wall, the bench on the east.
    w: [[store.z0, store.z1]],
    e: [[5.1, 8.7]],
  });
  addFrame(kit, 'n', store, NET_STORE.x0 + 4.9, 1.8, 0.9, 0.6, mats.tarp, 2);
  addFrame(kit, 's', store, NET_STORE.x0 + 9.6, 1.9, 0.7, 0.5, mats.castIron);

  // Lettering painted on the plaster: the house amaro over the bar, the firm's name in the store.
  batch.add(mats.poster, decalQuad(adCell(2), 3.4, 0.85, cafe.x1 - 0.012, 2.52, 5.8, -Math.PI / 2));
  batch.add(mats.poster, decalQuad(adCell(1), 2.6, 0.65, NET_STORE.x0 + 3.6, 2.35, store.z0 + 0.012, 0));
  // Bills pasted by the store's street door, one over the edge of the other.
  batch.add(mats.poster, decalQuad(posterCell(6), 0.42, 0.63, NET_STORE.x0 + 9.3, 1.5, store.z0 + 0.012, 0, 0.04));
  batch.add(mats.poster, decalQuad(posterCell(4), 0.42, 0.63, NET_STORE.x0 + 9.68, 1.42, store.z0 + 0.015, 0, -0.05));
}
