import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Shape of one tree species. Lengths in metres, angles in radians. */
export interface TreeSpec {
  readonly height: number;
  readonly radius: number;
  /** Fraction of the height where the live crown starts. */
  readonly crownStart: number;
  /** Longest bough. */
  readonly branchLength: number;
  /** Tiers of boughs in the close-up crown. */
  readonly whorls: number;
  /** Downward droop of the lowest boughs. */
  readonly droop: number;
  /** 0 is a spire that is widest at the bottom, 1 a rounded crown that is widest in the middle. */
  readonly dome: number;
  /** Share of boughs left out, for an open ragged crown. */
  readonly gaps: number;
  /** Dead branch stubs on the bare lower trunk. */
  readonly stubs: number;
}

export const TREE_SPECS: readonly TreeSpec[] = [
  // Tall pine: long bare trunk, high rounded crown.
  { height: 25, radius: 0.34, crownStart: 0.46, branchLength: 3.5, whorls: 13, droop: 0.2, dome: 1, gaps: 0.16, stubs: 6 },
  // Spruce: a spire whose boughs hang. The crown starts high enough that they clear a standing player.
  { height: 21, radius: 0.27, crownStart: 0.3, branchLength: 3.1, whorls: 17, droop: 0.55, dome: 0, gaps: 0.05, stubs: 4 },
  // Slim younger tree.
  { height: 14, radius: 0.17, crownStart: 0.38, branchLength: 2.0, whorls: 12, droop: 0.42, dome: 0.25, gaps: 0.08, stubs: 3 },
];

/** Waist-high to head-high sapling used as undergrowth. */
export const SAPLING_SPEC: TreeSpec = {
  height: 3.4,
  radius: 0.05,
  crownStart: 0.08,
  branchLength: 1.05,
  whorls: 8,
  droop: 0.3,
  dome: 0,
  gaps: 0,
  stubs: 0,
};

const BARK_TILE = 2;

/** Tapered trunk with a root flare, sunk below ground so it holds on slopes. */
export function trunkGeometry(spec: TreeSpec, sides: number, random: (() => number) | null): THREE.BufferGeometry {
  const { height: h, radius: r } = spec;
  const profile: readonly (readonly [number, number])[] = [
    [r * 1.7, -0.9],
    [r * 1.55, 0],
    [r * 1.2, 0.3],
    [r * 1.05, 0.9],
    [r, 2],
    [r * 0.9, h * 0.3],
    [r * 0.72, h * 0.55],
    [r * 0.45, h * 0.8],
    [r * 0.1, h],
  ];
  const lathe = new THREE.LatheGeometry(
    profile.map(([x, y]) => new THREE.Vector2(x, y)),
    sides,
  );
  const position = lathe.getAttribute('position');
  const uv = lathe.getAttribute('uv');
  const around = Math.max(1, Math.round((r * Math.PI * 2) / 1.3));
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * around, position.getY(i) / BARK_TILE);
  if (!random || spec.stubs === 0) return lathe;

  const parts: THREE.BufferGeometry[] = [lathe];
  const crown = h * spec.crownStart;
  for (let i = 0; i < spec.stubs; i++) {
    const y = 1.9 + random() * Math.max(0.5, crown - 2.2);
    const length = 0.3 + random() * 0.6;
    const stub = new THREE.CylinderGeometry(0.006, 0.022 + random() * 0.02, length, 4, 1, true);
    stub.translate(0, length / 2, 0);
    stub.rotateZ(-(Math.PI / 2 - 0.1 + random() * 0.5));
    stub.translate(r * 0.85, y, 0);
    stub.rotateY(random() * Math.PI * 2);
    parts.push(stub);
  }
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('Could not merge trunk geometry');
  return merged;
}

interface CardSink {
  readonly position: number[];
  readonly normal: number[];
  readonly uv: number[];
  readonly index: number[];
}

type Point3 = readonly [number, number, number];

/** How far the crown reaches at `t` (0 at its base, 1 at the tree top). */
export function crownRadius(spec: TreeSpec, t: number): number {
  const spire = (1 - t) ** 0.85;
  const dome = Math.sin(Math.PI * Math.min(1, 0.2 + t * 0.8)) ** 0.7;
  return spec.branchLength * (spire * (1 - spec.dome) + dome * spec.dome) + 0.2;
}

/** Card outline as [V, share of the half width]; matches the frond painted in needles.ts. */
const NEAR_ROWS: readonly (readonly [number, number])[] = [
  [0, 0.3],
  [0.45, 1],
  [1, 0.72],
];
const FAR_ROWS: readonly (readonly [number, number])[] = [
  [0, 0.3],
  [1, 1],
];

interface Bough {
  readonly origin: Point3;
  readonly azimuth: number;
  readonly length: number;
  readonly halfWidth: number;
  /** Elevation of the inner part; negative hangs. */
  readonly pitch: number;
  /** Extra droop of the outer part. */
  readonly bend: number;
  /** How far the edges hang below the spine, as a share of the half width. */
  readonly sag: number;
  readonly roll: number;
  /** Nothing hangs below this height. */
  readonly floor: number;
}

/**
 * Lowest a bough of a full-size tree may hang, before the tree is scaled (the
 * forest scales trees down to 0.72). Keeps foliage out of a standing player's
 * face: bots see through it, the player cannot.
 */
const CLEARANCE = 2.95;

/**
 * One bough as a card cut to the frond's outline. The close-up version has a
 * spine with edges that hang below it, so it has depth from the side; the
 * distant version is a single flat piece. Returns the spine.
 */
function addBough(sink: CardSink, bough: Bough, close: boolean): readonly Point3[] {
  const { origin, azimuth, length, halfWidth, pitch, bend, sag, roll, floor } = bough;
  const cos = Math.cos(azimuth);
  const sin = Math.sin(azimuth);
  const rows = close ? NEAR_ROWS : FAR_ROWS;
  const spine: Point3[] = [];
  const base = sink.position.length / 3;
  const across = close ? 3 : 2;
  let [x, y, z] = origin;
  rows.forEach(([v, share], row) => {
    if (row > 0) {
      const span = (v - (rows[row - 1] as readonly [number, number])[0]) * length;
      const elevation = pitch - (row > 1 ? bend : 0);
      x += cos * Math.cos(elevation) * span;
      z += sin * Math.cos(elevation) * span;
      y = Math.max(floor, y + Math.sin(elevation) * span);
    }
    spine.push([x, y, z]);
    const half = halfWidth * share;
    const outward = 0.3 + v * 0.45;
    for (let k = 0; k < across; k++) {
      // -1, 0, 1 across the close-up card; -1, 1 across the distant one.
      const edge = close ? k - 1 : k * 2 - 1;
      const drop = Math.abs(edge) * sag * half - edge * roll * half;
      sink.position.push(x - sin * edge * half, Math.max(floor, y - drop), z + cos * edge * half);
      const nx = cos * outward - sin * edge * 0.5;
      const nz = sin * outward + cos * edge * 0.5;
      const nl = Math.hypot(nx, 0.8, nz);
      sink.normal.push(nx / nl, 0.8 / nl, nz / nl);
      sink.uv.push(0.5 + edge * 0.5 * share, v);
    }
  });
  for (let row = 0; row < rows.length - 1; row++) {
    for (let k = 0; k < across - 1; k++) {
      const a = base + row * across + k;
      sink.index.push(a, a + 1, a + across, a + across, a + 1, a + across + 1);
    }
  }
  return spine;
}

/** Upright half-frond under a bough: the curtain of branchlets a spruce bough trails. */
function addCurtain(sink: CardSink, spine: readonly Point3[], azimuth: number, depth: number, floor: number): void {
  const cos = Math.cos(azimuth);
  const sin = Math.sin(azimuth);
  const base = sink.position.length / 3;
  spine.forEach((point, row) => {
    const v = (NEAR_ROWS[row] as readonly [number, number])[0];
    const hang = depth * (NEAR_ROWS[row] as readonly [number, number])[1];
    sink.position.push(point[0], point[1] + 0.02, point[2], point[0], Math.max(floor, point[1] - hang), point[2]);
    for (let k = 0; k < 2; k++) sink.normal.push(cos * 0.75, 0.66, sin * 0.75);
    sink.uv.push(0.5, v, 0.5 + 0.5 * (NEAR_ROWS[row] as readonly [number, number])[1], v);
  });
  for (let row = 0; row < spine.length - 1; row++) {
    const a = base + row * 2;
    sink.index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
}

/**
 * Crown as tiers of boughs that together cover every direction, so the tree
 * reads as a solid cone or dome of foliage rather than a pole with tufts.
 * `detail` 1 is the close-up crown. Lower values are for trees seen through
 * fog: fewer tiers of broad boughs that hang steeply, because a flat card is
 * invisible edge-on and distant trees are always seen from the side.
 */
export function crownGeometry(spec: TreeSpec, detail: number, random: () => number): THREE.BufferGeometry {
  const sink: CardSink = { position: [], normal: [], uv: [], index: [] };
  const { height: h, radius: r } = spec;
  const close = detail >= 1;
  const y0 = h * spec.crownStart;
  // Saplings are undergrowth and may reach the ground.
  const floor = h > 6 ? CLEARANCE : 0;
  const whorls = Math.max(4, Math.round(spec.whorls * detail));
  const arc = close ? 1.55 : 2.6;
  for (let w = 0; w < whorls; w++) {
    const t = (w + 0.15 + random() * 0.4) / whorls;
    const y = y0 + (h - y0) * t * 0.95;
    const reach = crownRadius(spec, t);
    const trunk = r * (1 - 0.85 * (y / h)) * 0.6;
    const count = Math.min(close ? 9 : 6, Math.max(4, Math.round((Math.PI * 2 * reach) / arc)));
    const spin = random() * Math.PI * 2;
    // Low boughs hang, the top ones reach up.
    const pitch = -spec.droop + (spec.droop + 0.5) * t ** 1.4;
    for (let b = 0; b < count; b++) {
      if (random() < spec.gaps * (close ? 1 : 0.5)) continue;
      const azimuth = spin + ((b + (random() - 0.5) * 0.5) / count) * Math.PI * 2;
      const length = reach * (0.72 + random() * 0.5);
      const halfWidth = Math.min(length * 0.55, ((Math.PI * length) / count) * (close ? 1.3 : 1.5));
      const origin: Point3 = [Math.cos(azimuth) * trunk, y + (random() - 0.5) * 0.5, Math.sin(azimuth) * trunk];
      const spine = addBough(
        sink,
        {
          origin,
          azimuth,
          length,
          halfWidth,
          pitch: close ? pitch + (random() - 0.5) * 0.25 : Math.min(pitch, -0.2) - 0.5,
          bend: 0.3 + spec.droop * 0.5 + random() * 0.2,
          sag: 0.5 + random() * 0.35,
          roll: (random() - 0.5) * 0.5,
          floor,
        },
        close,
      );
      if (close && random() < 0.3 + spec.droop * 0.6) addCurtain(sink, spine, azimuth, halfWidth * 0.8, floor);
    }
  }
  // Leader: two crossed upright cards for the tip.
  const tip = Math.min(1.8, h * 0.12);
  for (const azimuth of [0.4, 0.4 + Math.PI / 2]) {
    const base = sink.position.length / 3;
    const cos = Math.cos(azimuth) * tip * 0.26;
    const sin = Math.sin(azimuth) * tip * 0.26;
    sink.position.push(-cos, h + tip * 0.12, -sin, cos, h + tip * 0.12, sin, -cos, h - tip * 0.88, -sin, cos, h - tip * 0.88, sin);
    sink.normal.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    sink.uv.push(0.1, 1, 0.9, 1, 0.1, 0.35, 0.9, 0.35);
    sink.index.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(sink.position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(sink.normal, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(sink.uv, 2));
  geometry.setIndex(sink.index);
  return geometry;
}
