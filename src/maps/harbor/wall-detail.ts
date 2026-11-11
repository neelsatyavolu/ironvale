import * as THREE from 'three/webgpu';
import { seededRandom } from '../../core/random';
import type { Frame, Kit } from './facade';
import type { Rect } from './pieces';
import { AD_COUNT, adCell, decalQuad, posterCell, POSTER_COUNT } from './posters';
import { streetLevel } from './shade-grid';

/** What a house wall offers the things that accumulate on it. */
export interface WallFace {
  readonly frame: Frame;
  readonly length: number;
  readonly height: number;
  /** Height of the street above the wall's base on this side. */
  readonly ground: number;
  readonly storeyHeight: number;
  readonly openings: readonly (Rect & { readonly kind: string })[];
  /** true on the long sides, where the roof drains. */
  readonly eave: boolean;
  /** Where the rainwater pipe comes down, if this wall has one. */
  readonly pipeU: number | null;
  /** false on sides nobody walks past: they get a gutter and nothing else. */
  readonly detailed: boolean;
  readonly seed: number;
}

type Span = readonly [number, number];

/** Stretches of `[0, length]` left over once every blocked stretch is taken out. */
export function freeSpans(length: number, blocked: readonly Span[], margin = 0): Span[] {
  const sorted = [...blocked].sort((a, b) => a[0] - b[0]);
  const spans: Span[] = [];
  let from = margin;
  for (const [b0, b1] of sorted) {
    if (b0 > from) spans.push([from, Math.min(b0, length - margin)]);
    from = Math.max(from, b1);
  }
  if (from < length - margin) spans.push([from, length - margin]);
  return spans.filter(([a, b]) => b - a > 1e-6);
}

/** Flat quad on a wall for the stain material: V is 1 along the top edge, or along the bottom when `rising`. */
function stainQuad(kit: Kit, frame: Frame, u0: number, u1: number, v0: number, v1: number, strength: number, rising = false): void {
  const quad = new THREE.PlaneGeometry(u1 - u0, v1 - v0);
  const uv = quad.getAttribute('uv');
  for (let k = 0; k < uv.count; k++) uv.setY(k, (rising ? 1 - uv.getY(k) : uv.getY(k)) * strength);
  quad.rotateY(frame.yaw);
  const [x, z] = frame.point((u0 + u1) / 2, 0.006);
  quad.translate(x, frame.base + (v0 + v1) / 2, z);
  kit.batch.add(kit.mats.stain, quad);
}

/** Round stain on the paving, darkest in the middle. */
function stainPool(kit: Kit, x: number, y: number, z: number, radius: number, strength: number): void {
  const disc = new THREE.CircleGeometry(radius, 14);
  const position = disc.getAttribute('position');
  const uv = disc.getAttribute('uv');
  for (let k = 0; k < uv.count; k++) {
    const r = Math.hypot(position.getX(k), position.getY(k)) / radius;
    uv.setXY(k, 0.5, (1 - r) * strength);
  }
  disc.rotateX(-Math.PI / 2);
  disc.translate(x, y + 0.012, z);
  kit.batch.add(kit.mats.stain, disc);
}

function addGutter(kit: Kit, face: WallFace): void {
  const { frame, length, height, pipeU } = face;
  const { mats } = kit;
  frame.box(mats.zinc, -0.28, length + 0.28, height - 0.3, height - 0.2, 0.4, 0.53);
  for (let u = 0.5; u < length; u += 1.6) frame.box(mats.castIron, u - 0.015, u + 0.015, height - 0.32, height - 0.19, 0.1, 0.54);
  // Swan neck from the gutter back to the pipe on the wall.
  if (pipeU !== null) frame.box(mats.iron, pipeU - 0.045, pipeU + 0.045, height - 0.36, height - 0.28, 0.03, 0.5);
}

function addPipeFoot(kit: Kit, face: WallFace, u: number): void {
  const { frame, ground } = face;
  // Shoe turned out over the paving, the splash it leaves up the wall and the wet it leaves on the ground.
  frame.box(kit.mats.iron, u - 0.045, u + 0.045, ground + 0.06, ground + 0.15, 0.03, 0.24);
  stainQuad(kit, frame, u - 0.5, u + 0.5, ground, ground + 1.5, 1, true);
  stainQuad(kit, frame, u - 0.16, u + 0.16, ground + 1.2, face.height - 0.3, 0.55);
  const [x, z] = frame.point(u, 0.5);
  stainPool(kit, x, frame.base + ground, z, 0.8, 1);
}

function addRunOff(kit: Kit, face: WallFace, random: () => number): void {
  const { frame, openings, ground } = face;
  for (const opening of openings) {
    if (opening.kind === 'open' || opening.kind === 'door') continue;
    const balcony = opening.kind === 'french';
    if (balcony && opening.v0 < ground + 1) continue;
    const top = balcony ? opening.v0 - 0.46 : opening.v0 - 0.09;
    const reach = balcony ? 0.9 + random() * 0.6 : 0.45 + random() * 0.75;
    const below = openings.filter((o) => o.v1 < top && o.u0 < opening.u1 && o.u1 > opening.u0).reduce((highest, o) => Math.max(highest, o.v1 + 0.15), ground);
    const bottom = Math.max(top - reach, below);
    if (top - bottom < 0.2) continue;
    const spread = balcony ? 0.5 : 0.14;
    stainQuad(kit, frame, opening.u0 - spread, opening.u1 + spread, bottom, top, balcony ? 0.9 : 0.6 + random() * 0.4);
  }
}

function addServices(kit: Kit, face: WallFace, spans: readonly Span[], random: () => number): Span | null {
  const { frame, ground, height } = face;
  const { mats } = kit;
  const span = spans.find(([a, b]) => b - a > 0.7);
  if (!span || random() < 0.4) return null;
  const u = span[0] + 0.3 + random() * Math.min(0.5, span[1] - span[0] - 0.6);
  // Junction box with a conduit up to the eaves, and on some walls a meter cabinet below it.
  frame.box(mats.castIron, u - 0.1, u + 0.1, ground + 2.5, ground + 2.78, 0, 0.09);
  frame.box(mats.iron, u - 0.014, u + 0.014, ground + 2.78, height - 0.3, 0, 0.028);
  for (let v = ground + 3.1; v < height - 0.4; v += 1.3) frame.box(mats.iron, u - 0.03, u + 0.03, v, v + 0.02, 0, 0.034);
  if (random() < 0.6) {
    frame.box(mats.zinc, u - 0.18, u + 0.18, ground + 1.15, ground + 1.63, 0, 0.13);
    frame.box(mats.castIron, u - 0.19, u + 0.19, ground + 1.63, ground + 1.66, 0, 0.15);
    frame.box(mats.iron, u - 0.014, u + 0.014, ground + 1.66, ground + 2.5, 0, 0.028);
    stainQuad(kit, frame, u - 0.2, u + 0.2, ground + 0.6, ground + 1.15, 0.7);
  }
  return [u - 0.3, u + 0.3];
}

const BAY = 4.5;

/** Bill posters at head height in the clear stretches of a wall, and on a long blank one a painted advertisement above them. */
function addPosters(kit: Kit, face: WallFace, spans: readonly Span[], random: () => number): void {
  const { frame, ground } = face;
  const ceiling = frame.base + ground + face.storeyHeight - 0.25;
  for (const [a, b] of spans) {
    if (b - a >= 4 && random() < 0.6) {
      const width = Math.min(3.4, b - a - 0.6);
      const u = a + 0.3 + width / 2 + random() * (b - a - 0.6 - width);
      const [x, z] = frame.point(u, 0.008);
      const y = Math.max(streetLevel(x, z), frame.base + ground) + 2.32;
      if (y + width / 8 < ceiling + 0.2) kit.batch.add(kit.mats.poster, decalQuad(adCell(Math.floor(random() * AD_COUNT)), width, width / 4, x, y, z, frame.yaw));
    }
    for (let from = a; from < b - 1.1; from += BAY) {
      const to = Math.min(b, from + BAY);
      if (random() < 0.4) continue;
      const count = Math.min(1 + Math.floor(random() * 3), Math.floor((to - from) / 0.6));
      const w = random() < 0.3 ? 0.62 : 0.48;
      const h = w * 1.5;
      let u = from + 0.2 + random() * Math.max(0, to - from - count * w - 0.4);
      for (let i = 0; i < count; i++) {
        const [x, z] = frame.point(u + w / 2, 0.012 + i * 0.003);
        const y = Math.max(streetLevel(x, z), frame.base + ground) + 1.45 + (random() - 0.5) * 0.25;
        u += w * (0.92 + random() * 0.25);
        // Skip where a ramp or steps have climbed too far up this wall.
        if (y + h / 2 > ceiling) continue;
        kit.batch.add(kit.mats.poster, decalQuad(posterCell(Math.floor(random() * POSTER_COUNT)), w, h, x, y, z, frame.yaw, (random() - 0.5) * 0.09));
      }
    }
  }
}

/** Worn stone step in front of each door, and the dirt trodden off it onto the paving. */
function addDoorsteps(kit: Kit, face: WallFace): void {
  const { frame, ground } = face;
  for (const door of face.openings) {
    if (door.kind !== 'door' || door.v0 > ground + 0.3) continue;
    // Too low to trip on, so it needs no collider.
    frame.box(kit.mats.stoneLight, door.u0 - 0.2, door.u1 + 0.2, ground, ground + 0.04, 0.1, 0.46, { tile: 1.5 });
    const [x, z] = frame.point((door.u0 + door.u1) / 2, 0.75);
    stainPool(kit, x, frame.base + ground + 0.03, z, 0.85, 0.7);
  }
}

/** Gutter, rainwater stains, run-off under sills and balconies, service boxes and bill posters for one wall. */
export function addWallDetail(kit: Kit, face: WallFace): void {
  if (face.eave) addGutter(kit, face);
  if (!face.detailed) return;
  const random = seededRandom(face.seed);
  const { ground, openings, pipeU, length } = face;
  if (pipeU !== null) addPipeFoot(kit, face, pipeU);
  addRunOff(kit, face, random);
  addDoorsteps(kit, face);

  // What already occupies the wall at head height: openings with their folded-back shutters, and the pipe.
  const blocked: Span[] = openings
    .filter((o) => o.v0 < ground + 2.4 && o.v1 > ground + 0.6)
    .map((o) => {
      const reach = o.kind === 'door' || o.kind === 'open' ? 0.3 : (o.u1 - o.u0) / 2 + 0.2;
      return [o.u0 - reach, o.u1 + reach] as const;
    });
  if (pipeU !== null) blocked.push([pipeU - 0.3, pipeU + 0.3]);
  const services = addServices(kit, face, freeSpans(length, blocked, 0.35), random);
  if (services) blocked.push(services);
  addPosters(kit, face, freeSpans(length, blocked, 0.35), random);
}
