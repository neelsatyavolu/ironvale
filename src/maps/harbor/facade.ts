import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BoxOptions, Batch, Colliders } from './kit';
import type { HarborMaterials } from './materials';
import type { Rect } from './pieces';

export type Side = 'n' | 's' | 'e' | 'w';

/** Shared handles every builder in this map needs. */
export interface Kit {
  readonly batch: Batch;
  readonly colliders: Colliders;
  readonly mats: HarborMaterials;
  readonly random: () => number;
  readonly density: number;
}

export const WALL_THICKNESS = 0.36;
const PLASTER_TILE = 2.6;

const ALONG: Readonly<Record<Side, readonly [number, number]>> = { s: [1, 0], n: [1, 0], e: [0, 1], w: [0, 1] };
const OUT: Readonly<Record<Side, readonly [number, number]>> = { s: [0, 1], n: [0, -1], e: [1, 0], w: [-1, 0] };

/**
 * Local frame of one wall: `u` runs along it (always toward +X or +Z), `v` is
 * height above the base and `d` is distance out from the wall face (negative
 * is into the wall).
 */
export class Frame {
  constructor(
    private readonly batch: Batch,
    readonly side: Side,
    private readonly ox: number,
    private readonly oz: number,
    readonly base: number,
  ) {}

  /** World extents [x0, x1, z0, z1] of a slab in wall coordinates. */
  extent(u0: number, u1: number, d0: number, d1: number): [number, number, number, number] {
    switch (this.side) {
      case 's':
        return [this.ox + u0, this.ox + u1, this.oz + d0, this.oz + d1];
      case 'n':
        return [this.ox + u0, this.ox + u1, this.oz - d1, this.oz - d0];
      case 'e':
        return [this.ox + d0, this.ox + d1, this.oz + u0, this.oz + u1];
      case 'w':
        return [this.ox - d1, this.ox - d0, this.oz + u0, this.oz + u1];
    }
  }

  point(u: number, d: number): [number, number] {
    const a = ALONG[this.side];
    const n = OUT[this.side];
    return [this.ox + a[0] * u + n[0] * d, this.oz + a[1] * u + n[1] * d];
  }

  /** Yaw that turns a prop authored facing +Z to face out of this wall. */
  get yaw(): number {
    const n = OUT[this.side];
    return Math.atan2(n[0], n[1]);
  }

  box(material: THREE.Material, u0: number, u1: number, v0: number, v1: number, d0: number, d1: number, options?: BoxOptions): void {
    const [x0, x1, z0, z1] = this.extent(u0, u1, d0, d1);
    this.batch.span(material, x0, x1, this.base + v0, this.base + v1, z0, z1, options);
  }

  collide(colliders: Colliders, u0: number, u1: number, v0: number, v1: number, d0: number, d1: number, surface: Parameters<Colliders['span']>[6]): void {
    const [x0, x1, z0, z1] = this.extent(u0, u1, d0, d1);
    colliders.span(x0, x1, this.base + v0, this.base + v1, z0, z1, surface);
  }

  /**
   * Hinged panel (shutter or door leaf). `dir` is the way the leaf lies when
   * closed (+1 toward +u). `angle` 0 is closed, PI is folded back flat against
   * the wall.
   */
  leaf(material: THREE.Material, hingeU: number, dir: 1 | -1, width: number, v0: number, v1: number, angle: number, hingeD = 0.03): void {
    const a = ALONG[this.side];
    const n = OUT[this.side];
    const cos = Math.cos(angle) * dir;
    const sin = Math.sin(angle);
    const dx = a[0] * cos + n[0] * sin;
    const dz = a[1] * cos + n[1] * sin;
    const [hx, hz] = this.point(hingeU, hingeD);
    this.batch.box(material, width, v1 - v0, 0.04, hx + (dx * width) / 2, this.base + (v0 + v1) / 2, hz + (dz * width) / 2, {
      yaw: Math.atan2(-dz, dx),
      tile: 1,
    });
  }
}

export type ShutterState = 'open' | 'closed' | 'ajar' | 'none';

export interface WindowOptions {
  readonly lit: boolean;
  readonly shutters: ShutterState;
  readonly paint: THREE.Material;
  readonly trim: boolean;
  /** Full-height door-window: no sill. */
  readonly french: boolean;
  /** Planter of geraniums on the sill. */
  readonly flowers?: boolean;
}

/** Glazed window set back in its opening, with frame, sill, optional trim and shutters. */
export function addWindow(kit: Kit, frame: Frame, r: Rect, options: WindowOptions, random: () => number): void {
  const { mats } = kit;
  const w = r.u1 - r.u0;
  const h = r.v1 - r.v0;
  frame.box(options.lit ? mats.glassLit : mats.glass, r.u0, r.u1, r.v0, r.v1, -0.21, -0.18);
  const bar = 0.055;
  const joinery = mats.plasterWhite;
  frame.box(joinery, r.u0, r.u0 + bar, r.v0, r.v1, -0.18, -0.12);
  frame.box(joinery, r.u1 - bar, r.u1, r.v0, r.v1, -0.18, -0.12);
  frame.box(joinery, r.u0, r.u1, r.v1 - bar, r.v1, -0.18, -0.12);
  frame.box(joinery, r.u0, r.u1, r.v0, r.v0 + bar, -0.18, -0.12);
  frame.box(joinery, r.u0 + w / 2 - 0.03, r.u0 + w / 2 + 0.03, r.v0, r.v1, -0.18, -0.13);
  if (h > 1.2) frame.box(joinery, r.u0, r.u1, r.v0 + h * 0.64, r.v0 + h * 0.64 + 0.045, -0.18, -0.13);
  if (!options.french) frame.box(mats.stoneLight, r.u0 - 0.1, r.u1 + 0.1, r.v0 - 0.09, r.v0, -0.2, 0.09, { tile: 1.5 });
  if (options.trim) {
    const band = 0.13;
    frame.box(joinery, r.u0 - band, r.u0, r.v0, r.v1 + band, 0, 0.03);
    frame.box(joinery, r.u1, r.u1 + band, r.v0, r.v1 + band, 0, 0.03);
    frame.box(joinery, r.u0, r.u1, r.v1, r.v1 + band, 0, 0.03);
  }
  if (options.flowers && !options.french) {
    // Window box of geraniums.
    frame.box(mats.terracotta, r.u0 + 0.06, r.u1 - 0.06, r.v0, r.v0 + 0.15, -0.04, 0.12);
    for (let u = r.u0 + 0.2; u < r.u1 - 0.1; u += 0.26) {
      const [x, z] = frame.point(u, 0.05);
      addSpray(kit, x, frame.base + r.v0 + 0.3, z, 0.46, 2, random() < 0.75);
    }
  }
  addShutters(frame, r, options.shutters, options.paint, random);
}

function addShutters(frame: Frame, r: Rect, state: ShutterState, paint: THREE.Material, random: () => number): void {
  if (state === 'none') return;
  const half = (r.u1 - r.u0) / 2;
  if (state === 'closed') {
    frame.box(paint, r.u0, r.u0 + half - 0.005, r.v0, r.v1, -0.09, -0.05, { tile: 1 });
    frame.box(paint, r.u0 + half + 0.005, r.u1, r.v0, r.v1, -0.09, -0.05, { tile: 1 });
    return;
  }
  const swing = (): number => (state === 'open' ? Math.PI - 0.04 - random() * 0.1 : Math.PI * (0.45 + random() * 0.4));
  frame.leaf(paint, r.u0, 1, half, r.v0, r.v1, swing());
  frame.leaf(paint, r.u1, -1, half, r.v0, r.v1, swing());
}

/** Plank door closed in its opening, with a stone surround and a knob. */
export function addDoor(kit: Kit, frame: Frame, r: Rect, paint: THREE.Material): void {
  const { mats } = kit;
  frame.box(paint, r.u0, r.u1, r.v0, r.v1, -0.2, -0.14, { tile: 1, swap: true });
  const band = 0.15;
  frame.box(mats.stoneLight, r.u0 - band, r.u0, r.v0, r.v1 + band, -0.02, 0.045, { tile: 1.5 });
  frame.box(mats.stoneLight, r.u1, r.u1 + band, r.v0, r.v1 + band, -0.02, 0.045, { tile: 1.5 });
  frame.box(mats.stoneLight, r.u0, r.u1, r.v1, r.v1 + band, -0.02, 0.045, { tile: 1.5 });
  frame.box(mats.brass, r.u1 - 0.16, r.u1 - 0.11, r.v0 + 1.0, r.v0 + 1.06, -0.14, -0.09);
}

/** Small stone balcony with an iron railing in front of a door-window. */
export function addBalcony(kit: Kit, frame: Frame, centre: number, floor: number, random: () => number): void {
  const { mats, colliders } = kit;
  const half = 0.95;
  const depth = 0.82;
  const u0 = centre - half;
  const u1 = centre + half;
  frame.box(mats.stoneLight, u0, u1, floor - 0.14, floor, 0, depth, { tile: 1.5 });
  frame.box(mats.stoneLight, u0 + 0.12, u0 + 0.3, floor - 0.42, floor - 0.14, 0, depth * 0.6, { tile: 1.5 });
  frame.box(mats.stoneLight, u1 - 0.3, u1 - 0.12, floor - 0.42, floor - 0.14, 0, depth * 0.6, { tile: 1.5 });
  frame.collide(colliders, u0, u1, floor - 0.14, floor, 0, depth, 'concrete');

  const rail = depth - 0.05;
  const iron = mats.iron;
  for (const v of [0.06, 1.0]) {
    frame.box(iron, u0, u1, floor + v, floor + v + 0.035, rail - 0.02, rail + 0.02);
    frame.box(iron, u0, u0 + 0.035, floor + v, floor + v + 0.035, 0, rail);
    frame.box(iron, u1 - 0.035, u1, floor + v, floor + v + 0.035, 0, rail);
  }
  const step = 0.125;
  for (let u = u0 + step / 2; u < u1; u += step) frame.box(iron, u - 0.008, u + 0.008, floor + 0.06, floor + 1.0, rail - 0.008, rail + 0.008);
  for (let d = step; d < rail - 0.05; d += step) {
    frame.box(iron, u0 + 0.01, u0 + 0.026, floor + 0.06, floor + 1.0, d - 0.008, d + 0.008);
    frame.box(iron, u1 - 0.026, u1 - 0.01, floor + 0.06, floor + 1.0, d - 0.008, d + 0.008);
  }
  frame.collide(colliders, u0, u1, floor, floor + 1.03, rail - 0.03, rail + 0.03, 'metal');

  // A pot or two of geraniums.
  const pots = Math.floor(random() * 3);
  for (let i = 0; i < pots; i++) {
    const [x, z] = frame.point(u0 + 0.25 + random() * (half * 2 - 0.5), depth - 0.25 - random() * 0.2);
    addPot(kit, x, frame.base + floor, z, 0.8 + random() * 0.5);
  }
}

const POT_PROFILE = [
  [0.001, 0],
  [0.11, 0],
  [0.15, 0.24],
  [0.165, 0.24],
  [0.165, 0.28],
  [0.13, 0.28],
  [0.001, 0.26],
].map(([x, y]) => new THREE.Vector2(x, y));
const POT_GEOMETRY = new THREE.LatheGeometry(POT_PROFILE, 10);
const BUSH_GEOMETRY = (() => {
  // Welded and lumpy, so the shrub shades as a soft mass rather than a faceted ball.
  const raw = new THREE.IcosahedronGeometry(0.24, 2);
  raw.deleteAttribute('normal');
  raw.deleteAttribute('uv');
  const bush = mergeVertices(raw, 1e-4);
  const position = bush.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const lump = 1 + 0.14 * Math.sin(x * 31 + y * 17) * Math.cos(z * 27 - y * 11);
    position.setXYZ(i, x * lump, y * lump * 0.9, z * lump);
  }
  bush.computeVertexNormals();
  return bush;
})();

/** Upright cut-out leaf sprays crossed through one point: reads as a bushy plant from any side. */
export function addSpray(kit: Kit, x: number, y: number, z: number, size: number, cards: number, flowering: boolean): void {
  const start = kit.random() * Math.PI;
  for (let i = 0; i < cards; i++) {
    const card = new THREE.PlaneGeometry(size, size);
    const uv = card.getAttribute('uv');
    for (let k = 0; k < uv.count; k++) uv.setX(k, (uv.getX(k) + (flowering ? 1 : 0)) / 2);
    card.rotateZ((kit.random() - 0.5) * 0.6);
    card.rotateY(start + (i * Math.PI) / cards);
    card.translate(x, y, z);
    kit.batch.add(kit.mats.spray, card);
  }
}

/** Terracotta pot with a small shrub: a dark core for bulk and leaf sprays for the outline. */
export function addPot(kit: Kit, x: number, y: number, z: number, scale: number): void {
  kit.batch.place(kit.mats.terracotta, POT_GEOMETRY, x, y, z, 0, scale);
  kit.batch.place(kit.mats.foliage, BUSH_GEOMETRY, x, y + 0.4 * scale, z, kit.random() * 3, scale * 0.7);
  addSpray(kit, x, y + 0.5 * scale, z, 0.74 * scale, 3, kit.random() < 0.3);
}

export { PLASTER_TILE };
