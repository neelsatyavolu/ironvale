import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ball, box, capsule, line, painted, rod, slackLine, type Point } from './boat-parts';
import { DEPTH, DRAFT, section, stationX, type HullForm } from './hull-shape';

export interface BoatSpec extends HullForm {
  readonly x: number;
  readonly z: number;
  /** Bow points along +X at yaw 0. */
  readonly yaw: number;
  readonly hull: number;
  readonly stripe: number;
  /** Lapped planking; otherwise the planks are laid flush. */
  readonly clinker?: boolean;
  readonly cabin?: boolean;
  readonly mast?: boolean;
  readonly outboard?: boolean;
  readonly name: string;
  /** Port registration painted on both bows. */
  readonly reg: string;
  /** Height of the keel when the boat is ashore; afloat boats leave this unset. */
  readonly ashore?: number;
  /** Laid up under a tarpaulin on a ridge pole: tall enough to hide behind. */
  readonly covered?: boolean;
}

const WOOD = 0x8a6f4d;
const WOOD_DARK = 0x5d4a35;
const WHITE = 0xe9e4d6;
const GLASS = 0x121a22;
const STEEL = 0x8b8f92;
const BLACK = 0x1c1d1f;
const ROPE = 0xb09a72;
const BUOY = 0xd4622a;
/** Bottom boards sit clear of the waterline, or the sea sheet would show through them as the boat rocks. */
export const FLOOR_Y = DRAFT + 0.13;

type Parts = THREE.BufferGeometry[];
const at = (spec: BoatSpec, t: number) => ({ x: (t - 0.5) * spec.length, shape: section(t, spec) });

/** Slatted bottom boards, thwarts on risers with knees, and a foredeck. */
export function addJoinery(parts: Parts, spec: BoatSpec): void {
  const slat = 0.15;
  for (let k = -3; k <= 3; k++) {
    const z = k * (slat + 0.022);
    let from = 1;
    let to = 0;
    for (let i = 2; i <= 38; i++) {
      const t = i / 40;
      if (section(t, spec).halfAt(FLOOR_Y) > Math.abs(z) + slat / 2 + 0.03) {
        from = Math.min(from, t);
        to = Math.max(to, t);
      }
    }
    if (to - from > 0.1) parts.push(box((to - from) * spec.length, 0.022, slat, ((from + to) / 2 - 0.5) * spec.length, FLOOR_Y, z, k % 2 ? WOOD : 0x7d6445));
  }
  const y = DEPTH * 0.7;
  for (const t of spec.cabin ? [0.2, 0.76] : spec.outboard ? [0.16, 0.42, 0.68] : [0.28, 0.5, 0.72]) {
    const { x, shape } = at(spec, t);
    const half = shape.halfAt(y) - 0.02;
    parts.push(box(0.26, 0.04, half * 2, x, y, 0, WOOD));
    for (const side of [-1, 1]) {
      parts.push(box(0.05, 0.16, 0.05, x, y + 0.1, side * (half - 0.03), WOOD_DARK, { pitch: side * 0.5 }));
      parts.push(box(0.3, 0.05, 0.03, x, y - 0.045, side * (half - 0.015), WOOD_DARK));
    }
  }
  // Foredeck: a short triangle of planking over the bow, with a samson post through it.
  const deckY = (t: number): number => section(t, spec).gunwale - 0.04;
  for (let i = 0; i < 5; i++) {
    const t0 = 0.86 + i * 0.026;
    const t1 = t0 + 0.026;
    const half = Math.min(section(t0, spec).half(1), section(t1, spec).half(1)) - 0.04;
    if (half > 0.03) parts.push(box((t1 - t0) * spec.length + 0.004, 0.025, half * 2, stationX((t0 + t1) / 2, 1, spec), (deckY(t0) + deckY(t1)) / 2, 0, i % 2 ? WOOD : 0x7d6445, { roll: 0.045 }));
  }
  parts.push(rod(0.035, 0.04, 0.34, stationX(0.9, 1, spec), deckY(0.9) + 0.14, 0, WOOD_DARK));
  parts.push(rod(0.012, 0.012, 0.2, stationX(0.9, 1, spec), deckY(0.9) + 0.24, 0, STEEL, { pitch: Math.PI / 2 }));
}

/** Wheelhouse: panelled sides, glazed all round, a cambered roof with a handrail, lights and an aerial. */
export function addWheelhouse(parts: Parts, spec: BoatSpec): void {
  const cx = at(spec, 0.44).x;
  const w = spec.beam * 0.52;
  const l = 1.55;
  const y0 = DEPTH - 0.12;
  const sill = y0 + 0.72;
  const head = sill + 0.46;
  const top = head + 0.14;
  // Panelled lower sides, then posts and rails around the glass.
  parts.push(box(l, sill - y0, w, cx, (y0 + sill) / 2, 0, WHITE));
  parts.push(box(l + 0.03, 0.05, w + 0.03, cx, sill, 0, spec.stripe));
  parts.push(box(l, top - head, w, cx, (head + top) / 2, 0, WHITE));
  parts.push(box(l - 0.06, head - sill, w - 0.06, cx, (sill + head) / 2, 0, GLASS));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(box(0.07, head - sill, 0.07, cx + (sx * (l - 0.07)) / 2, (sill + head) / 2, (sz * (w - 0.07)) / 2, WHITE));
    // Mullions: one on each side wall, one in the windscreen.
    parts.push(box(0.045, head - sill, 0.03, cx + sx * 0.1, (sill + head) / 2, (sx * (w - 0.03)) / 2, WHITE));
  }
  parts.push(box(0.03, head - sill, 0.045, cx + (l - 0.03) / 2, (sill + head) / 2, 0, WHITE));
  // Door in the after bulkhead, standing ajar.
  parts.push(box(0.03, 1.1, 0.5, cx - l / 2 - 0.012, y0 + 0.62, w * 0.14, spec.stripe));
  parts.push(box(0.035, 0.3, 0.3, cx - l / 2 - 0.02, y0 + 0.9, w * 0.14, GLASS));
  parts.push(ball(0.022, cx - l / 2 - 0.04, y0 + 0.6, w * 0.14 - 0.19, STEEL));
  // Roof: two thin slabs, the upper one narrower, read as a camber; drip edge in the trim colour.
  parts.push(box(l + 0.26, 0.04, w + 0.24, cx + 0.03, top + 0.02, 0, spec.stripe));
  parts.push(box(l + 0.1, 0.035, w * 0.62, cx + 0.03, top + 0.055, 0, WHITE));
  for (const sz of [-1, 1]) {
    const z = sz * (w / 2 - 0.04);
    parts.push(rod(0.011, 0.011, l * 0.8, cx, top + 0.13, z, STEEL, { roll: Math.PI / 2 }, 6));
    for (const dx of [-0.38, 0, 0.38]) parts.push(rod(0.009, 0.009, 0.1, cx + dx * l, top + 0.08, z, STEEL, {}, 5));
    // Side lights: red to port, green to starboard.
    parts.push(box(0.09, 0.07, 0.05, cx + l * 0.3, top - 0.05, sz * (w / 2 + 0.03), sz > 0 ? 0x1f7a3a : 0xa32218));
  }
  parts.push(rod(0.006, 0.008, 1.5, cx - l * 0.3, top + 0.8, -w * 0.3, BLACK, { roll: 0.08 }, 5));
  parts.push(rod(0.04, 0.04, 0.09, cx + l * 0.32, top + 0.11, 0, WHITE));
  parts.push(ball(0.035, cx + l * 0.32, top + 0.17, 0, 0xe8e2c8));
  // Life ring on the side and a stovepipe aft.
  const ring = new THREE.TorusGeometry(0.2, 0.05, 6, 14);
  ring.translate(cx - 0.3, y0 + 0.36, w / 2 + 0.05);
  parts.push(painted(ring, BUOY));
  parts.push(rod(0.03, 0.03, 0.5, cx - l * 0.36, top + 0.26, w * 0.3, BLACK));
  parts.push(rod(0.045, 0.03, 0.05, cx - l * 0.36, top + 0.53, w * 0.3, BLACK));
}

/** Outboard motor clamped to the transom, tilted down, with its tiller and a fuel tank. */
export function addOutboard(parts: Parts, spec: BoatSpec): void {
  const shape = section(0, spec);
  const x = stationX(0, 1, spec) - 0.14;
  const top = shape.gunwale + 0.34;
  parts.push(box(0.1, 0.26, 0.2, x + 0.13, shape.gunwale - 0.06, 0, BLACK));
  parts.push(ball(0.2, x - 0.02, top, 0, 0x26323c, [1.15, 0.72, 0.7]));
  parts.push(box(0.36, 0.05, 0.25, x - 0.02, top - 0.14, 0, STEEL));
  parts.push(box(0.14, 0.62, 0.1, x - 0.03, top - 0.46, 0, 0x26323c, { roll: -0.06 }));
  parts.push(box(0.3, 0.02, 0.2, x - 0.1, top - 0.8, 0, STEEL));
  parts.push(ball(0.07, x - 0.06, top - 0.92, 0, 0x26323c, [1.7, 0.8, 0.8]));
  for (let i = 0; i < 3; i++) parts.push(box(0.012, 0.19, 0.09, x - 0.17, top - 0.92, 0, STEEL, { pitch: (i * Math.PI * 2) / 3, roll: 0.3 }));
  parts.push(rod(0.016, 0.02, 0.5, x + 0.3, top - 0.04, 0.05, BLACK, { roll: Math.PI / 2 - 0.12 }, 6));
  parts.push(box(0.36, 0.2, 0.26, x + 0.62, FLOOR_Y + 0.11, -0.22, 0xa32218));
  parts.push(rod(0.03, 0.03, 0.03, x + 0.62, FLOOR_Y + 0.225, -0.22, BLACK));
  parts.push(line([[x + 0.62, FLOOR_Y + 0.2, -0.1], [x + 0.4, FLOOR_Y + 0.05, 0.02], [x + 0.2, shape.gunwale - 0.2, 0.02], [x + 0.05, top - 0.14, 0]], 0.008, BLACK, 4));
}

/** Short mast with stays, a boom carrying a furled sail, and a masthead lamp. */
export function addMast(parts: Parts, spec: BoatSpec): void {
  const x = at(spec, spec.cabin ? 0.68 : 0.6).x;
  const foot = FLOOR_Y;
  const height = 3.6;
  const head = foot + height;
  parts.push(rod(0.03, 0.05, height, x, foot + height / 2, 0, WOOD));
  parts.push(box(0.2, 0.05, 0.2, x, DEPTH * 0.7 + 0.04, 0, WOOD_DARK));
  parts.push(ball(0.03, x, head + 0.04, 0, 0xe8e2c8));
  const boomY = DEPTH + 0.95;
  parts.push(rod(0.026, 0.03, 2.1, x - 1.0, boomY, 0, WOOD, { roll: Math.PI / 2 }));
  parts.push(capsule(0.085, 1.5, x - 0.95, boomY + 0.1, 0, 0xcfc5ad, { roll: Math.PI / 2 }));
  for (const dx of [-1.55, -1.1, -0.65, -0.3]) {
    const tie = new THREE.TorusGeometry(0.1, 0.012, 4, 10);
    tie.rotateY(Math.PI / 2);
    tie.translate(x + dx, boomY + 0.07, 0);
    parts.push(painted(tie, ROPE));
  }
  const bow = stationX(1, 1, spec);
  const stem: Point = [bow, section(1, spec).gunwale + 0.26, 0];
  parts.push(line([[x, head - 0.1, 0], stem], 0.007, BLACK, 4));
  for (const side of [-1, 1]) {
    const shape = section(0.55, spec);
    parts.push(line([[x, head - 0.25, 0], [x - 0.25, shape.gunwale + 0.03, side * (shape.half(1) - 0.03)]], 0.007, BLACK, 4));
  }
  parts.push(line([[x - 2.0, boomY + 0.02, 0], [x - 1.2, boomY + 1.4, 0], [x, head - 0.18, 0]], 0.006, ROPE, 4));
}

/** A pair of oars shipped along the thwarts, with their rowlocks. */
export function addOars(parts: Parts, spec: BoatSpec): void {
  const y = DEPTH * 0.7 + 0.05;
  for (const side of [-1, 1]) {
    const z = side * spec.beam * 0.2;
    parts.push(rod(0.02, 0.024, 2.5, 0.1, y, z, 0xb89d70, { roll: Math.PI / 2, yaw: side * 0.04 }, 6));
    parts.push(box(0.62, 0.016, 0.13, 1.5, y, z - side * 0.06, 0xb89d70, { yaw: side * 0.04 }));
    const shape = section(0.46, spec);
    parts.push(rod(0.012, 0.012, 0.1, at(spec, 0.46).x, shape.gunwale + 0.08, side * (shape.half(1) - 0.03), STEEL, {}, 5));
    const crutch = new THREE.TorusGeometry(0.035, 0.008, 4, 8, Math.PI);
    crutch.rotateY(Math.PI / 2);
    crutch.rotateX(Math.PI);
    crutch.translate(at(spec, 0.46).x, shape.gunwale + 0.165, side * (shape.half(1) - 0.03));
    parts.push(painted(crutch, STEEL));
  }
}

/** Fenders on lanyards over the side and cleats at bow and stern. Returns the cleat positions for mooring lines. */
export function addFenders(parts: Parts, spec: BoatSpec): Point[] {
  for (const [t, side] of [
    [0.34, 1],
    [0.62, 1],
    [0.38, -1],
    [0.66, -1],
  ] as const) {
    const { x, shape } = at(spec, t);
    const z = side * (shape.half(1) + 0.085);
    parts.push(capsule(0.075, 0.3, x, shape.gunwale - 0.38, z, t > 0.5 ? 0xd8d6cf : 0x2c4a6b));
    parts.push(line([[x, shape.gunwale - 0.16, z], [x, shape.gunwale + 0.04, side * (shape.half(1) - 0.02)]], 0.008, ROPE, 4));
  }
  const cleats: Point[] = [];
  for (const t of [0.12, 0.82]) {
    const { shape } = at(spec, t);
    for (const side of [-1, 1]) {
      const p: Point = [stationX(t, 1, spec), shape.gunwale + 0.07, side * (shape.half(1) - 0.03)];
      parts.push(box(0.16, 0.025, 0.035, p[0], p[1], p[2], STEEL));
      parts.push(box(0.05, 0.05, 0.03, p[0], p[1] - 0.025, p[2], STEEL));
      cleats.push(p);
    }
  }
  return cleats;
}

/**
 * Working clutter: fish boxes, a heap of net with floats, a coil of rope, a
 * bucket and an anchor. Draws from `random` in the same order as the first
 * version of these boats did, so everything placed after them stays put.
 */
export function addClutter(parts: Parts, spec: BoatSpec, random: () => number): void {
  const boxes = 1 + Math.floor(random() * 3);
  for (let i = 0; i < boxes; i++) {
    const x = at(spec, 0.3 + random() * 0.12 + (spec.cabin ? 0.42 : 0.25 * i)).x;
    const z = (random() - 0.5) * 0.3;
    const yaw = random() * 0.6;
    const y = FLOOR_Y + 0.135 + (i % 2) * 0.24;
    const hex = [0x2f5f86, 0xc9d2d6, 0xb5483a][i % 3]!;
    parts.push(box(0.6, 0.22, 0.4, x, y, z, hex, { yaw }));
    parts.push(box(0.64, 0.035, 0.44, x, y + 0.11, z, hex, { yaw }));
    parts.push(box(0.54, 0.02, 0.34, x, y + 0.115, z, 0x9aa7ab, { yaw }));
  }
  const heapX = at(spec, 0.16).x + 0.3;
  const faceted = new THREE.IcosahedronGeometry(0.42, 2);
  faceted.deleteAttribute('normal');
  faceted.deleteAttribute('uv');
  const heap = mergeVertices(faceted, 1e-4);
  faceted.dispose();
  const position = heap.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const lump = 1 + 0.14 * Math.sin(position.getX(i) * 13) * Math.cos(position.getZ(i) * 11 + position.getY(i) * 7);
    position.setXYZ(i, position.getX(i) * 1.3 * lump, position.getY(i) * 0.42 * lump, position.getZ(i) * lump);
  }
  heap.computeVertexNormals();
  heap.translate(heapX, FLOOR_Y + 0.16, 0);
  parts.push(painted(heap, 0x35564d));
  for (let i = 0; i < 4; i++) parts.push(ball(0.085, heapX - 0.2 + random() * 0.5, FLOOR_Y + 0.36, (random() - 0.5) * 0.5, i % 2 ? BUOY : 0xd9b23a, [1, 0.8, 1]));

  const mid = at(spec, spec.cabin ? 0.82 : 0.6).x;
  for (let i = 0; i < 4; i++) {
    const coil = new THREE.TorusGeometry(0.17 - i * 0.012, 0.02, 5, 14);
    coil.rotateX(Math.PI / 2);
    coil.translate(mid, FLOOR_Y + 0.035 + i * 0.036, spec.beam * 0.16);
    parts.push(painted(coil, ROPE));
  }
  const bucket = new THREE.CylinderGeometry(0.13, 0.1, 0.24, 10, 1, true);
  bucket.translate(mid + 0.3, FLOOR_Y + 0.13, -spec.beam * 0.17);
  parts.push(painted(bucket, 0x2c4a6b));
  // Grapnel anchor lying in the bow with its chain.
  const ax = at(spec, 0.8).x;
  parts.push(rod(0.014, 0.014, 0.5, ax, FLOOR_Y + 0.12, 0.1, BLACK, { roll: Math.PI / 2 - 0.25 }, 5));
  for (let i = 0; i < 4; i++) parts.push(rod(0.01, 0.012, 0.2, ax + 0.2, FLOOR_Y + 0.1, 0.1, BLACK, { pitch: (i * Math.PI) / 2, roll: 0.9 }, 4));
  parts.push(slackLine([ax - 0.24, FLOOR_Y + 0.17, 0.1], [ax - 0.5, FLOOR_Y + 0.03, -0.1], 0.02, 0.012, STEEL));
}
