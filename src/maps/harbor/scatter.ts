import * as THREE from 'three/webgpu';
import { localFrame } from './dressing';
import type { Kit } from './facade';
import { mergeParts } from './kit';
import { addCase } from './props';
import { MOLE, QUAY_EDGE, SEABED_Y, TERRACE_Y } from './layout';

type Spot = readonly [x: number, z: number, yaw: number, y?: number];
/** Something propped against a wall that faces +Z (`facing` 1) or -Z (`facing` -1): [x, wall z, facing, base height]. */
type Leaning = readonly [x: number, z: number, facing: 1 | -1, y?: number];

/** Sacks stacked on a pallet: [x, z, yaw, base height, layers]. Five layers is chest-high cover. */
const SACK_PILES: readonly (readonly [number, number, number, number, number])[] = [
  [-44.6, 12.4, 0.1, 0, 5],
  [-18.2, -2.6, 1.5, 0, 5],
  [4.2, -11.9, 0.3, 0, 4],
  [33.6, 13.6, 1.62, 0, 5],
  [-36.6, -18.4, 0.2, TERRACE_Y, 5],
  [3.6, -17.4, 1.5, TERRACE_Y, 4],
  [20.4, 1.2, 0.05, 0, 3],
  [-48.6, 28.4, 1.4, 0, 4],
];

/** Empty pallets in short stacks: [x, z, yaw, base height]. */
const PALLET_STACKS: readonly Spot[] = [
  [-37.6, 18.3, 0.2],
  [38.8, 11.4, 1.4],
  [47.2, -3.2, 0.1],
  [-27.8, -3.2, 1.6],
  [-49.4, 38.2, 0.3],
  [36.4, -20.9, 0.1, TERRACE_Y],
];

/** Life rings hang on the quay lamp posts, on the landward side. */
const LIFE_RINGS: readonly Leaning[] = [
  [-20, 18.63, -1],
  [15, 18.63, -1],
  [-40, 18.63, -1],
];

const OARS: readonly Leaning[] = [
  [-35.1, 10, 1],
  [15.6, 10, 1],
  [38.2, 10, 1],
  [-26.6, 2, -1],
  [24.6, 2, -1],
  [-13.2, -22, 1, TERRACE_Y],
];

/**
 * Packing cases two wide and two high: [x, z, yaw, base height]. They stand
 * near the middle of a route to cut the end-to-end view and screen a spawn.
 */
const TALL_STACKS: readonly Spot[] = [
  [39, -1, 0.06],
  [-38.6, -1, -0.05],
  [-39.5, 14.6, 0.1],
];

const LADDERS: readonly Leaning[] = [
  [-49.2, 10, 1],
  [25.6, 10, 1],
  [-44.2, -4, 1],
  [46.4, -22, 1, TERRACE_Y],
];

/** Buckets and mooring buoys in loose groups: [x, z, yaw, base height]. */
const BUCKET_GROUPS: readonly Spot[] = [
  [-47.2, 35.4, 0.6],
  [4.2, 14.6, 2.4],
  [20.2, 10.7, 0.1],
  [-26.3, 10.7, 0.2],
  [-45, 1.4, 0.1],
  [24.4, -3.4, 0.1],
  [-3.2, -12.9, 0.3],
];

const MANHOLES: readonly (readonly [number, number, number?])[] = [
  [-41, 0.6],
  [-15.5, 0.8],
  [5.5, 0.4],
  [26, -2.2],
  [44, 0.2],
  [-33, 14.4],
  [20, 15.2],
  [-5, -8.6],
  [-26, -19, TERRACE_Y],
  [30, -19.2, TERRACE_Y],
];

/** Iron ladders down the quay wall into the basin: x positions. */
const QUAY_LADDERS = [-32.5, 12.5, 36.2] as const;

const SACK = (() => {
  const geometry = new THREE.SphereGeometry(0.5, 10, 7);
  geometry.scale(0.78, 0.27, 0.5);
  return geometry;
})();

const BUCKET = new THREE.LatheGeometry(
  [
    [0.001, 0.012],
    [0.1, 0.012],
    [0.1, 0],
    [0.11, 0],
    [0.145, 0.27],
    [0.13, 0.27],
    [0.1, 0.03],
    [0.001, 0.03],
  ].map(([r, y]) => new THREE.Vector2(r, y)),
  12,
);

function addPallet(kit: Kit, x: number, y: number, z: number, yaw: number): void {
  const { batch, mats } = kit;
  const at = localFrame(x, z, yaw);
  const box = (w: number, h: number, d: number, lx: number, ly: number, lz: number): void => {
    const [wx, wz] = at(lx, lz);
    batch.box(mats.planksPale, w, h, d, wx, y + ly, wz, { yaw, tile: 1.3 });
  };
  for (const lz of [-0.45, 0, 0.45]) box(1.2, 0.09, 0.1, 0, 0.065, lz);
  for (let i = 0; i < 5; i++) box(0.14, 0.02, 1.0, -0.53 + i * 0.265, 0.12, 0);
  for (const lx of [-0.53, 0, 0.53]) box(0.14, 0.02, 1.0, lx, 0.01, 0);
}

function addSackPile(kit: Kit, x: number, y: number, z: number, yaw: number, layers: number): void {
  const { batch, colliders, mats, random } = kit;
  addPallet(kit, x, y, z, yaw);
  const at = localFrame(x, z, yaw);
  const rise = 0.215;
  for (let layer = 0; layer < layers; layer++) {
    const crosswise = layer % 2 === 1;
    const count = layer === layers - 1 && random() < 0.5 ? 1 : 2;
    for (let i = 0; i < count; i++) {
      const side = count === 1 ? 0 : i === 0 ? -0.26 : 0.26;
      const [wx, wz] = crosswise ? at(side + (random() - 0.5) * 0.06, (random() - 0.5) * 0.08) : at((random() - 0.5) * 0.08, side + (random() - 0.5) * 0.06);
      batch.place(mats.sack, SACK, wx, y + 0.27 + layer * rise, wz, yaw + (crosswise ? Math.PI / 2 : 0) + (random() - 0.5) * 0.2, 0.96 + random() * 0.1);
    }
  }
  colliders.box(1.1, 0.14 + layers * rise + 0.08, 1.0, x, y + (0.14 + layers * rise + 0.08) / 2, z, 'dirt', yaw);
}

function addTallStack(kit: Kit, x: number, y: number, z: number, yaw: number): void {
  const at = localFrame(x, z, yaw);
  for (const side of [-0.56, 0.56]) {
    const [wx, wz] = at((kit.random() - 0.5) * 0.08, side);
    const size = 1.04 + kit.random() * 0.06;
    addCase(kit, wx, y, wz, size, yaw + (kit.random() - 0.5) * 0.08);
    addCase(kit, wx + (kit.random() - 0.5) * 0.1, y + size, wz + (kit.random() - 0.5) * 0.1, 0.98, yaw + (kit.random() - 0.5) * 0.25);
  }
}

/** A straight piece propped against a wall, foot `out` metres from it. Returns a placer for parts along its length. */
function leaning(kit: Kit, [x, z, facing, y = 0]: Leaning, length: number, out: number) {
  const tilt = Math.asin(out / length);
  const pitch = -facing * tilt;
  const footZ = z + facing * out;
  // Unit vector from foot to head.
  const up = Math.cos(tilt);
  const back = -facing * Math.sin(tilt);
  return (material: THREE.Material, w: number, h: number, d: number, dx: number, along: number): void => {
    kit.batch.box(material, w, h, d, x + dx, y + along * up, footZ + along * back, { pitch, tile: 1.2, swap: true });
  };
}

function addOars(kit: Kit, spot: Leaning): void {
  const { mats, random } = kit;
  const count = 2 + Math.floor(random() * 2);
  for (let i = 0; i < count; i++) {
    const length = 2.5 + random() * 0.4;
    const part = leaning(kit, [spot[0] + i * 0.16, spot[1], spot[2], spot[3] ?? 0], length + 0.6, 0.35 + random() * 0.2);
    part(mats.planksPale, 0.045, length, 0.045, 0, length / 2);
    part(i === 0 ? mats.paint[4]! : mats.planksPale, 0.15, 0.62, 0.022, 0, length + 0.3);
  }
}

function addLadder(kit: Kit, spot: Leaning): void {
  const { mats, colliders } = kit;
  const length = 3.4;
  const part = leaning(kit, spot, length, 0.75);
  for (const dx of [-0.21, 0.21]) part(mats.planksPale, 0.05, length, 0.035, dx, length / 2);
  for (let along = 0.3; along < length - 0.1; along += 0.3) part(mats.planksPale, 0.42, 0.035, 0.03, 0, along);
  const [x, z, facing, y = 0] = spot;
  colliders.box(0.5, 2.2, 0.75, x, y + 1.1, z + facing * 0.4, 'wood');
}

function addLifeRing(kit: Kit, [x, z, facing, y = 0]: Leaning): void {
  const { batch, mats } = kit;
  const ring = new THREE.TorusGeometry(0.29, 0.062, 8, 22);
  batch.place(mats.float, ring, x, y + 1.55, z + facing * 0.07);
  ring.dispose();
  for (let i = 0; i < 4; i++) {
    const band = new THREE.TorusGeometry(0.29, 0.066, 8, 4, 0.36);
    band.rotateZ((i * Math.PI) / 2 + 0.6);
    batch.place(mats.cloth[0]!, band, x, y + 1.55, z + facing * 0.07);
    band.dispose();
  }
  batch.box(mats.iron, 0.04, 0.04, 0.09, x, y + 1.86, z + facing * 0.045);
}

function addBucketGroup(kit: Kit, x: number, y: number, z: number, yaw: number): void {
  const { batch, colliders, mats, random } = kit;
  const at = localFrame(x, z, yaw);
  const buoy = new THREE.SphereGeometry(0.19, 10, 8);
  buoy.scale(1, 1.18, 1);
  const count = 2 + Math.floor(random() * 3);
  for (let i = 0; i < count; i++) {
    const [wx, wz] = at((i - (count - 1) / 2) * 0.42 + (random() - 0.5) * 0.1, (random() - 0.5) * 0.4);
    if (random() < 0.5) {
      const material = [mats.iron, mats.fishBox[0]!, mats.fishBox[2]!, mats.planksPale][Math.floor(random() * 4)]!;
      batch.place(material, BUCKET, wx, y, wz, random() * 6, 0.9 + random() * 0.25);
    } else {
      batch.place(random() < 0.6 ? mats.float : mats.fishBox[1]!, buoy, wx, y + 0.2, wz, random() * 6, 0.85 + random() * 0.35);
      batch.box(mats.rope, 0.03, 0.1, 0.03, wx, y + 0.45, wz);
    }
  }
  buoy.dispose();
  colliders.box(count * 0.42, 0.34, 0.5, x, y + 0.17, z, 'metal', yaw);
}

/** Old stocked anchor, leaned against a wall as a harbour ornament. */
function addAnchor(kit: Kit, x: number, z: number, facing: 1 | -1): void {
  const shank = new THREE.BoxGeometry(0.075, 1.7, 0.075);
  shank.translate(0, 0.95, 0);
  const stock = new THREE.BoxGeometry(1.05, 0.07, 0.07);
  stock.translate(0, 1.66, 0);
  const ring = new THREE.TorusGeometry(0.12, 0.022, 6, 14);
  ring.translate(0, 1.9, 0);
  const arms = new THREE.TorusGeometry(0.52, 0.045, 6, 16, Math.PI * 0.86);
  arms.rotateZ(Math.PI + Math.PI * 0.07);
  arms.rotateY(Math.PI / 2);
  arms.translate(0, 0.62, 0);
  const parts = [shank, stock, ring, arms];
  for (const side of [-1, 1]) {
    const fluke = new THREE.BoxGeometry(0.03, 0.26, 0.2);
    fluke.rotateX(side * 0.5);
    fluke.translate(0, 0.52, side * 0.5);
    parts.push(fluke);
  }
  const anchor = mergeParts(parts);
  anchor.rotateX(-facing * 0.2);
  anchor.translate(x, 0, z + facing * 0.42);
  kit.batch.add(kit.mats.castIron, anchor);
  kit.colliders.box(1.05, 1.9, 0.6, x, 0.95, z + facing * 0.32, 'metal');
}

/** Small harbour light on the head of the mole. */
function addMoleLight(kit: Kit): void {
  const { batch, colliders, mats } = kit;
  const x = (MOLE.x0 + MOLE.x1) / 2;
  const z = MOLE.z1 - 1.3;
  batch.span(mats.stoneLight, x - 0.6, x + 0.6, 0, 0.45, z - 0.6, z + 0.6, { tile: 1.2 });
  batch.span(mats.stoneLight, x - 0.45, x + 0.45, 0.45, 0.62, z - 0.45, z + 0.45, { tile: 1.2 });
  const post = new THREE.CylinderGeometry(0.07, 0.11, 2.3, 10);
  batch.place(mats.paint[1]!, post, x, 1.77, z, 0, 1, 1);
  post.dispose();
  batch.box(mats.iron, 0.34, 0.04, 0.34, x, 2.94, z);
  batch.box(mats.lampGreen, 0.2, 0.26, 0.2, x, 3.09, z);
  batch.box(mats.iron, 0.3, 0.05, 0.3, x, 3.24, z);
  colliders.span(x - 0.6, x + 0.6, 0, 0.62, z - 0.6, z + 0.6, 'concrete');
  colliders.box(0.24, 2.6, 0.24, x, 1.9, z, 'metal');
}

/** Small things that make the quay, the streets and the terrace look worked in. Sack piles are cover. */
export function addScatter(kit: Kit): void {
  const { batch, mats, random, density } = kit;
  const keep = <T>(list: readonly T[], min: number): readonly T[] =>
    list.slice(0, Math.max(min, Math.round(list.length * Math.min(1, density + 0.15))));

  // Cover is never thinned out: the low tier plays the same map.
  for (const [x, z, yaw, y, layers] of SACK_PILES) addSackPile(kit, x, y, z, yaw, layers);
  for (const [x, z, yaw, y = 0] of PALLET_STACKS) {
    const count = 2 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) addPallet(kit, x + (random() - 0.5) * 0.06, y + i * 0.135, z + (random() - 0.5) * 0.06, yaw + (random() - 0.5) * 0.12);
    kit.colliders.box(1.2, count * 0.135, 1.0, x, y + (count * 0.135) / 2, z, 'wood', yaw);
  }
  for (const [x, z, yaw, y = 0] of TALL_STACKS) addTallStack(kit, x, y, z, yaw);
  for (const spot of LADDERS) addLadder(kit, spot);

  for (const spot of keep(LIFE_RINGS, 2)) addLifeRing(kit, spot);
  for (const spot of keep(OARS, 3)) addOars(kit, spot);
  for (const [x, z, yaw, y = 0] of keep(BUCKET_GROUPS, 5)) addBucketGroup(kit, x, y, z, yaw);
  addAnchor(kit, 12.2, 10, 1);
  addMoleLight(kit);

  const cover = new THREE.CylinderGeometry(0.34, 0.34, 0.014, 18);
  for (const [x, z, y = 0] of MANHOLES) batch.place(mats.castIron, cover, x, y + 0.008, z, 0, 1, 0.5);
  cover.dispose();

  // Iron ladders on the quay wall, for anyone who ends up in the basin by the wall.
  for (const x of QUAY_LADDERS) {
    for (const dx of [-0.2, 0.2]) batch.span(mats.iron, x + dx - 0.02, x + dx + 0.02, SEABED_Y, 0.9, QUAY_EDGE + 0.05, QUAY_EDGE + 0.09);
    for (let y = SEABED_Y + 0.2; y < 0.05; y += 0.3) batch.span(mats.iron, x - 0.2, x + 0.2, y, y + 0.03, QUAY_EDGE + 0.05, QUAY_EDGE + 0.08);
  }
}
