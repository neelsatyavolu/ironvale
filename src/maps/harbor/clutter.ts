import * as THREE from 'three/webgpu';
import { archedPanel, archSurround } from './arch';
import { localFrame } from './dressing';
import type { Kit } from './facade';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { projectUv } from './kit';
import { FOUNTAIN, SQUARE_STAIR, STREET_NORTH, STREET_SOUTH, TERRACE_EDGE, TERRACE_Y } from './layout';

type Spot = readonly [x: number, z: number, yaw: number, y?: number];

/** Stacks of fish boxes: knee to waist high, in twos and threes. */
const FISH_BOXES: readonly Spot[] = [
  [-29.2, 18.6, 0.1],
  [-1.6, 18.4, 1.5],
  [12.8, 18.5, 0.05],
  [33.4, 18.6, 0.1],
  [40.6, 10.9, 0],
  [-25.6, 28, 1.57],
  [3.9, 29.5, 1.55],
  [29.3, 26, 1.6],
  [-18.4, 10.8, 0],
  [-46.2, 26.5, 1.5],
  [5.6, 12.6, 0.4],
  [26.4, 12.2, 1.2],
];

const HANDCARTS: readonly Spot[] = [
  [-6.6, 16.2, 0.35],
  [28.2, -2.6, 3.0],
  [-21.5, -2.9, 0.1],
  [8.6, -6.4, 1.2],
  [10.6, 16.6, 2.6],
  [-33.6, 13.4, 1.9],
  [24.6, -19.6, 0.2, TERRACE_Y],
  [-10, -20.4, 3.0, TERRACE_Y],
];

const NET_HEAPS: readonly Spot[] = [
  [-27.2, 17.2, 0.4],
  [0.2, 18.5, 0],
  [30, 18.6, 1],
  [-42.6, 17.6, 2],
  [-50.6, 32.6, 0.6],
  [14.4, 16.4, 2.2],
  [-26.3, 23.8, 1],
  [28.5, 24.2, 0.3],
  [38, 18.4, 1.4],
];

/** Small canvas canopies over shop doors: [x, z, facing (+1 south, -1 north), width, awning index, base]. */
const CANOPIES: readonly (readonly [number, number, 1 | -1, number, number, number])[] = [
  [-3, STREET_SOUTH, -1, 2.2, 0, 0],
  [18, STREET_SOUTH, -1, 2.6, 2, 0],
  [-20.5, STREET_SOUTH, -1, 2.4, 3, 0],
  [-36, STREET_NORTH, 1, 2.6, 1, 0],
  [16.5, STREET_NORTH, 1, 2.8, 0, 0],
  [38.5, STREET_NORTH, 1, 2.4, 3, 0],
  [-44.5, 10, 1, 3.0, 2, 0],
  [28, 10, 1, 3.2, 3, 0],
  [18, 10, 1, 2.6, 1, 0],
  [-20.5, 10, 1, 2.6, 0, 0],
  [44, 10, 1, 3, 1, 0],
];

function addFishBoxes(kit: Kit, x: number, y: number, z: number, yaw: number): void {
  const { batch, colliders, mats, random } = kit;
  const at = localFrame(x, z, yaw);
  const stacks = 1 + Math.floor(random() * 2.4);
  let tallest = 0;
  for (let s = 0; s < stacks; s++) {
    const count = 2 + Math.floor(random() * 4);
    tallest = Math.max(tallest, count);
    const material = mats.fishBox[Math.floor(random() * mats.fishBox.length)]!;
    for (let i = 0; i < count; i++) {
      const [bx, bz] = at((s - (stacks - 1) / 2) * 0.68 + (random() - 0.5) * 0.04, (random() - 0.5) * 0.05);
      const turn = yaw + (random() - 0.5) * 0.1;
      const by = y + i * 0.21;
      batch.box(material, 0.62, 0.17, 0.42, bx, by + 0.085, bz, { yaw: turn });
      batch.box(material, 0.66, 0.035, 0.46, bx, by + 0.19, bz, { yaw: turn });
    }
  }
  colliders.box(stacks * 0.68, tallest * 0.21, 0.46, x, y + (tallest * 0.21) / 2, z, 'wood', yaw);
}

const WHEEL = (() => {
  const parts: THREE.BufferGeometry[] = [];
  const rim = new THREE.TorusGeometry(0.4, 0.035, 6, 20);
  const hub = new THREE.CylinderGeometry(0.07, 0.07, 0.12, 8);
  hub.rotateX(Math.PI / 2);
  parts.push(rim, hub);
  for (let i = 0; i < 6; i++) {
    const spoke = new THREE.BoxGeometry(0.78, 0.035, 0.03);
    spoke.rotateZ((i * Math.PI) / 6);
    parts.push(spoke);
  }
  return parts;
})();

/** Two-wheeled market barrow, tipped forward on its leg, with a load. */
function addHandcart(kit: Kit, x: number, y: number, z: number, yaw: number): void {
  const { batch, colliders, mats, random } = kit;
  const at = localFrame(x, z, yaw);
  const box = (material: THREE.Material, w: number, h: number, d: number, lx: number, ly: number, lz: number, roll = 0): void => {
    const [wx, wz] = at(lx, lz);
    batch.box(material, w, h, d, wx, y + ly, wz, { yaw, roll, tile: 1.1 });
  };
  box(mats.crate, 1.7, 0.05, 0.95, 0, 0.62, 0);
  for (const sz of [-0.46, 0.46]) {
    box(mats.crate, 1.7, 0.22, 0.035, 0, 0.75, sz);
    box(mats.crate, 2.9, 0.05, 0.05, 0.55, 0.6, sz * 0.9);
  }
  box(mats.crate, 0.035, 0.22, 0.95, -0.84, 0.75, 0);
  box(mats.crate, 0.06, 0.6, 0.06, 0.75, 0.3, 0.4);
  box(mats.crate, 0.06, 0.6, 0.06, 0.75, 0.3, -0.4);
  for (const sz of [-0.56, 0.56]) {
    const [wx, wz] = at(-0.15, sz);
    for (const part of WHEEL) batch.place(mats.iron, part, wx, y + 0.435, wz, yaw);
  }
  const load = random();
  if (load < 0.4) {
    box(mats.fishBox[0]!, 0.6, 0.2, 0.42, -0.3, 0.75, 0.05);
    box(mats.fishBox[1]!, 0.6, 0.2, 0.42, -0.28, 0.96, 0.02);
    box(mats.fishBox[2]!, 0.6, 0.2, 0.42, 0.4, 0.75, -0.1);
  } else if (load < 0.75) {
    box(mats.crate, 0.7, 0.5, 0.7, -0.25, 0.9, 0);
    box(mats.rope, 0.5, 0.3, 0.6, 0.45, 0.8, 0.05);
  } else {
    box(mats.cloth[0]!, 0.75, 0.3, 0.5, -0.3, 0.8, 0.1);
    box(mats.cloth[3]!, 0.7, 0.28, 0.5, 0.3, 0.79, -0.1);
    box(mats.cloth[0]!, 0.7, 0.26, 0.5, 0, 1.07, 0);
  }
  colliders.box(1.7, 1.05, 1.05, x, y + 0.53, z, 'wood', yaw);
}

/** Dressing that fills the open ground: fish boxes, barrows, net heaps, canopies and paving bands. */
export function addClutter(kit: Kit): void {
  const { batch, colliders, mats, random, density } = kit;
  const keep = <T>(list: readonly T[], min: number): readonly T[] =>
    list.slice(0, Math.max(min, Math.round(list.length * Math.min(1, density + 0.15))));

  for (const [x, z, yaw, y = 0] of FISH_BOXES) addFishBoxes(kit, x, y, z, yaw);
  for (const [x, z, yaw, y = 0] of HANDCARTS) addHandcart(kit, x, y, z, yaw);

  // A heap of netting: a low dark mound, welded so it shades smoothly, under a looser skin of mesh.
  const raw = new THREE.IcosahedronGeometry(0.75, 3);
  raw.deleteAttribute('normal');
  raw.deleteAttribute('uv');
  const heap = mergeVertices(raw, 1e-4);
  raw.dispose();
  const position = heap.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const px = position.getX(i);
    const pz = position.getZ(i);
    const outline = 1 + 0.13 * Math.sin(Math.atan2(pz, px) * 3 + 1.1) + 0.06 * Math.sin(Math.atan2(pz, px) * 7);
    const folds = 1 + 0.16 * Math.sin(px * 9 + pz * 4) + 0.1 * Math.sin(pz * 13 - px * 6) + 0.06 * Math.sin(px * 23) * Math.cos(pz * 19);
    position.setXYZ(i, px * outline, Math.max(0, position.getY(i)) * 0.46 * folds, pz * outline);
  }
  heap.computeVertexNormals();
  projectUv(heap, 1);
  const skin = heap.clone();
  skin.scale(1.03, 1.06, 1.03);
  const ball = new THREE.SphereGeometry(0.085, 8, 6);
  for (const [x, z, yaw, y = 0] of keep(NET_HEAPS, 5)) {
    const scale = 0.8 + random() * 0.5;
    batch.place(mats.netHeap, heap, x, y, z, yaw, scale);
    batch.place(mats.net, skin, x, y, z, yaw, scale, 0.3);
    // A string of cork floats trailing over the heap.
    const from = random() * Math.PI * 2;
    for (let i = 0; i < 6; i++) {
      const a = from + i * 0.42;
      const r = (0.25 + i * 0.09) * scale;
      batch.place(mats.float, ball, x + Math.cos(a) * r, y + (0.3 - i * 0.035) * scale, z + Math.sin(a) * r);
    }
    colliders.box(1.1 * scale, 0.3 * scale, 1.1 * scale, x, y + 0.15 * scale, z, 'foliage', yaw);
  }
  heap.dispose();
  skin.dispose();
  ball.dispose();

  // Canopies over shop doors, on iron stays.
  for (const [x, z, facing, width, awning, base] of CANOPIES) {
    const canvas = mats.awning[awning % mats.awning.length]!;
    const reach = 1.25;
    batch.box(canvas, width, 0.02, reach + 0.05, x, base + 2.72, z + (facing * reach) / 2, { pitch: facing * 0.36, tile: 2.5 });
    batch.box(canvas, width, 0.18, 0.015, x, base + 2.42, z + facing * (reach * 0.94), { tile: 2.5 });
    for (const sx of [-width / 2 + 0.04, width / 2 - 0.04]) {
      batch.box(mats.iron, 0.02, 0.02, reach, x + sx, base + 2.7, z + (facing * reach) / 2, { pitch: facing * 0.36 });
    }
  }

  // Dressed-stone bands in the cobbles: a drain line down the street and a ring round the fountain.
  const lift = 0.012;
  batch.span(mats.stone, -51.5, 51.5, 0, lift, -1.14, -0.86, { tile: 1.6 });
  for (const x of [-37.4, -36.1, -14.6, -13.4, 34.1, 35.4]) batch.span(mats.stone, x - 0.14, x + 0.14, 0, lift, STREET_SOUTH, 10, { tile: 1.6 });
  const ring = new THREE.RingGeometry(3.3, 3.95, 40);
  ring.rotateX(-Math.PI / 2);
  batch.place(mats.stoneLight, ring, FOUNTAIN.x, lift, FOUNTAIN.z, 0, 1, 1.2);
  ring.dispose();

  // Wall fountain in the stair landing: a shaded niche, a spout and a trough.
  const face = TERRACE_EDGE + 0.25 + SQUARE_STAIR.depth + 0.28;
  const niche = archedPanel(1.5, 1.5, 0.75);
  const surround = archSurround(1.5, 1.5, 0.75, 0.2, 0.1);
  batch.place(mats.plasterShade, niche, 0, 0.5, face + 0.012, 0, 1, 2);
  batch.place(mats.stoneLight, surround, 0, 0.5, face, 0, 1, 1.4);
  niche.dispose();
  surround.dispose();
  batch.span(mats.stoneLight, -1.0, 1.0, 0, 0.55, face, face + 0.62, { tile: 1.4 });
  batch.span(mats.brass, -0.03, 0.03, 1.2, 1.26, face, face + 0.3);
  colliders.span(-1.0, 1.0, 0, 0.55, face, face + 0.62, 'concrete');
}
