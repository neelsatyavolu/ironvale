import * as THREE from 'three/webgpu';
import type { Assets } from '../../core/assets';
import type { Kit } from './facade';
import { instanced, instanceModel, mergeParts, transform } from './kit';
import { JETTIES, MOLE, QUAY_EDGE, SLIPWAY, TERRACE_Y } from './layout';

type Spot = readonly [x: number, z: number, yaw: number, y?: number];

/** Stacks of long crates: [x, z, yaw, base height]. Each is two side by side, two high, one across the top. */
const CRATE_PILES: readonly Spot[] = [
  [-34.5, 17.9, 0.12],
  [6.6, 18.1, 1.5],
  [47.4, 10.9, 1.5],
  [-22.2, 1.0, 1.62],
  [-31.6, 5.2, 0.4],
  [16.5, -20.8, 1.45, TERRACE_Y],
];

/** Clusters of upright barrels: [x, z, yaw, base height]. The scan is heavy, so there are only a few. */
const BARREL_CLUSTERS: readonly Spot[] = [
  [-41.6, 11.2, 0],
  [-3.2, 10.9, 0.8],
  [27.2, 1.1, 2.6],
  [-15.3, 6.4, 1.3],
  [-20.5, -17.0, 0.6, TERRACE_Y],
  [-26.2, 4.6, 0.2],
];

/** One-metre packing cases: [x, z, yaw, base height]. A second case sits on some of them. */
const CASES: readonly Spot[] = [
  [-14.6, 17.6, 0.2],
  [21.2, 17.9, -0.15],
  [18.2, -3.1, 0.1],
  [38.4, -17.2, 0.3, TERRACE_Y],
  [-40.5, -20.6, -0.2, TERRACE_Y],
  [-4.5, -13.2, 0.5],
  [-47.2, 30.5, 0.1],
  [30.6, 12.4, 0.35],
  [8.2, -1.9, -0.3],
  [-8.6, 16.8, 0.5],
  [41.5, -3.0, 0.2],
  [36.2, 4.4, 0.1],
  [22.5, 11.3, 0.3],
  [13.4, 11.2, 0.15],
  [49.6, 18.2, 0.4],
  [-40.2, -3.1, 0.3],
  [-10.4, -0.3, 0.2],
  [-1.9, 36.9, 0.1],
];

const BENCHES: readonly Spot[] = [
  [-11.3, -8.5, Math.PI / 2],
  [11.3, -5.5, -Math.PI / 2],
  [-36.5, -3.5, 0],
  [-6, -21.4, 0, TERRACE_Y],
  [30, 10.6, 0],
  [-51.3, 36, Math.PI / 2],
];

/** Heaps of lobster pots: [x, z, yaw, base height]. */
const POT_HEAPS: readonly Spot[] = [
  [-23.6, 18.5, 0.1],
  [25.4, 18.4, -0.1],
  [-26, 33.5, 1.57],
  [29, 31.6, 1.5],
  [-47.5, 24.5, 1.5],
  [8, 36.6, 0.2],
  [-33.2, 8.6, 0.05],
];

const ROPE_COILS: readonly Spot[] = [
  [-25.4, 24, 0],
  [3.6, 23, 0],
  [28.4, 22.5, 0],
  [-46.4, 38.5, 0],
  [-12.6, 18.8, 0],
  [38.6, 18.6, 0],
  [-1.5, 36.4, 0],
  [-29.4, 7.4, 0],
  [10.5, 17.2, 0],
  [45.5, 16.8, 0],
];

const CRATE_SCALE = 1.25;
const BARREL_SCALE = 1.15;

function bollardGeometry(): THREE.BufferGeometry {
  const profile = [
    [0.001, 0],
    [0.2, 0],
    [0.2, 0.05],
    [0.13, 0.1],
    [0.12, 0.42],
    [0.2, 0.47],
    [0.21, 0.54],
    [0.14, 0.6],
    [0.001, 0.61],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(profile, 14);
}

function coilGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const ring = new THREE.TorusGeometry(0.3 - (i % 2) * 0.012, 0.032, 6, 22);
    ring.rotateX(Math.PI / 2);
    ring.rotateY(i * 0.7);
    ring.translate(0, 0.032 + i * 0.058, 0);
    parts.push(ring);
  }
  const inner = new THREE.TorusGeometry(0.2, 0.032, 6, 18);
  inner.rotateX(Math.PI / 2);
  inner.translate(0.03, 0.032, 0);
  parts.push(inner);
  return mergeParts(parts);
}

/** D-section lobster pot: timber base and hoops, netting over the top and ends. */
function lobsterPot(): { wood: THREE.BufferGeometry; net: THREE.BufferGeometry } {
  const wood: THREE.BufferGeometry[] = [];
  const base = new THREE.BoxGeometry(0.72, 0.03, 0.52);
  base.translate(0, 0.015, 0);
  wood.push(base);
  for (const x of [-0.34, 0, 0.34]) {
    const hoop = new THREE.TorusGeometry(0.25, 0.014, 5, 10, Math.PI);
    hoop.rotateY(Math.PI / 2);
    hoop.translate(x, 0.03, 0);
    wood.push(hoop);
  }
  for (const angle of [0.5, 1.57, 2.64]) {
    const slat = new THREE.BoxGeometry(0.7, 0.014, 0.03);
    slat.translate(0, 0.03 + Math.sin(angle) * 0.255, Math.cos(angle) * 0.255);
    wood.push(slat);
  }
  const shell = new THREE.CylinderGeometry(0.245, 0.245, 0.68, 10, 1, true, 0, Math.PI);
  shell.rotateZ(Math.PI / 2);
  shell.translate(0, 0.03, 0);
  const scaleUv = (geometry: THREE.BufferGeometry, su: number, sv: number): void => {
    const uv = geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  };
  scaleUv(shell, 3, 3);
  const net: THREE.BufferGeometry[] = [shell];
  for (const x of [-0.34, 0.34]) {
    const end = new THREE.CircleGeometry(0.245, 8, 0, Math.PI);
    end.rotateY(Math.PI / 2);
    end.translate(x, 0.03, 0);
    scaleUv(end, 2.5, 2.5);
    net.push(end);
  }
  return { wood: mergeParts(wood), net: mergeParts(net) };
}

/** Loose harbour clutter: crates, barrels, benches, lobster pots, rope and bollards. Most of it is cover. */
export function addProps(kit: Kit, root: THREE.Object3D, assets: Assets): { dispose(): void } {
  const { colliders, mats, random, density } = kit;
  const owned: { dispose(): void }[] = [];
  // The scanned crate and barrel are dense meshes. Each pile is its own instanced batch so piles
  // out of view are culled, and plain boxes and drums stand in for them in the shadow pass.
  const shadowOnly = new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false });
  owned.push(shadowOnly);
  const proxies = (geometry: THREE.BufferGeometry, transforms: readonly THREE.Matrix4[]): void => {
    owned.push(geometry);
    const mesh = instanced(root, geometry, shadowOnly, transforms);
    if (mesh) mesh.receiveShadow = false;
  };
  const keep = <T>(list: readonly T[], min: number): readonly T[] =>
    list.slice(0, Math.max(min, Math.round(list.length * Math.min(1, density + 0.15))));

  // Long crates (glTF), stacked.
  const crates: THREE.Matrix4[] = [];
  const crateModel = assets.model('mdl-harbor-crate');
  const w = 0.52 * CRATE_SCALE;
  const h = 0.45 * CRATE_SCALE;
  const l = 1.16 * CRATE_SCALE;
  for (const [x, z, yaw, y = 0] of CRATE_PILES) {
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const pile: THREE.Matrix4[] = [];
    const at = (lx: number, ly: number, lz: number, turn: number): void => {
      pile.push(transform(x + lx * cos + lz * sin, y + ly, z - lx * sin + lz * cos, yaw + turn, CRATE_SCALE));
    };
    for (let layer = 0; layer < 2; layer++) {
      at(-w / 2 - 0.02, layer * h, (random() - 0.5) * 0.1, (random() - 0.5) * 0.08);
      at(w / 2 + 0.02, layer * h, (random() - 0.5) * 0.1, (random() - 0.5) * 0.08);
    }
    if (random() < 0.7) at(0, h * 2, 0, Math.PI / 2 + (random() - 0.5) * 0.3);
    colliders.box(w * 2 + 0.06, h * 2, l, x, y + h, z, 'wood', yaw);
    instanceModel(root, crateModel, pile, false);
    crates.push(...pile);
  }
  const crateProxy = new THREE.BoxGeometry(0.52, 0.45, 1.16);
  crateProxy.translate(0, 0.225, 0);
  proxies(crateProxy, crates);

  // Barrels (glTF), a few to a cluster.
  const barrels: THREE.Matrix4[] = [];
  const barrelModel = assets.model('mdl-harbor-barrel');
  const diameter = 0.74 * BARREL_SCALE;
  for (const [x, z, yaw, y = 0] of keep(BARREL_CLUSTERS, 4)) {
    const cluster: THREE.Matrix4[] = [];
    const count = 2 + Math.floor(random() * 2);
    for (let i = 0; i < count; i++) {
      const angle = yaw + (i * Math.PI * 2) / 3;
      const radius = i === 0 ? 0 : diameter * 1.02;
      const bx = x + Math.cos(angle) * radius * (i === 0 ? 0 : 1);
      const bz = z + Math.sin(angle) * radius * (i === 0 ? 0 : 1);
      cluster.push(transform(bx, y, bz, random() * Math.PI * 2, BARREL_SCALE));
      colliders.box(diameter * 0.9, 0.87 * BARREL_SCALE, diameter * 0.9, bx, y + 0.5, bz, 'wood', 0.6);
    }
    instanceModel(root, barrelModel, cluster, false);
    barrels.push(...cluster);
  }
  const barrelProxy = new THREE.CylinderGeometry(0.33, 0.33, 0.87, 10);
  barrelProxy.translate(0, 0.435, 0);
  proxies(barrelProxy, barrels);

  instanceModel(
    root,
    assets.model('mdl-harbor-bench'),
    BENCHES.map(([x, z, yaw, y = 0]) => transform(x, y, z, yaw, 1.3)),
  );
  for (const [x, z, yaw, y = 0] of BENCHES) colliders.box(1.5, 0.6, 0.6, x, y + 0.3, z, 'wood', yaw);

  // Packing cases built from planks: chest-high cover.
  for (const [x, z, yaw, y = 0] of CASES) {
    const size = 1 + random() * 0.15;
    addCase(kit, x, y, z, size, yaw);
    if (random() < 0.45) addCase(kit, x + (random() - 0.5) * 0.2, y + size, z + (random() - 0.5) * 0.2, 0.8, yaw + 0.4);
  }

  // Lobster pots in heaps of three to six.
  const pot = lobsterPot();
  owned.push(pot.wood, pot.net);
  const pots: THREE.Matrix4[] = [];
  for (const [x, z, yaw, y = 0] of keep(POT_HEAPS, 4)) {
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const place = (lx: number, ly: number, lz: number): void => {
      pots.push(transform(x + lx * cos + lz * sin, y + ly, z - lx * sin + lz * cos, yaw + (random() - 0.5) * 0.25));
    };
    const columns = 2 + Math.floor(random() * 2);
    for (let c = 0; c < columns; c++) place((c - (columns - 1) / 2) * 0.78, 0, (random() - 0.5) * 0.06);
    for (let c = 0; c < columns - 1; c++) place((c - (columns - 2) / 2) * 0.78, 0.29, (random() - 0.5) * 0.06);
    if (columns === 3 && random() < 0.6) place(0, 0.58, 0);
    colliders.box(columns * 0.78, 0.58, 0.55, x, y + 0.29, z, 'wood', yaw);
  }
  instanced(root, pot.wood, mats.planks, pots);
  const nets = instanced(root, pot.net, mats.net, pots);
  if (nets) nets.castShadow = false;

  const coil = coilGeometry();
  owned.push(coil);
  instanced(
    root,
    coil,
    mats.rope,
    keep(ROPE_COILS, 5).map(([x, z]) => transform(x, 0, z, random() * 6, 0.9 + random() * 0.3)),
  );

  // Mooring bollards along the open quay edge, the mole and beside each jetty.
  const bollard = bollardGeometry();
  owned.push(bollard);
  const posts: THREE.Matrix4[] = [];
  const post = (x: number, z: number): void => {
    posts.push(transform(x, 0, z, random() * 6));
    colliders.box(0.34, 0.6, 0.34, x, 0.3, z, 'metal');
  };
  for (const x of [-11.4, -3.6, -0.2, 6.4]) post(x, QUAY_EDGE - 0.32);
  for (const jetty of JETTIES) {
    post(jetty.x - jetty.width / 2 - 0.5, QUAY_EDGE - 0.32);
    post(jetty.x + jetty.width / 2 + 0.5, QUAY_EDGE - 0.32);
  }
  for (const z of [24, 30, 36, 41]) post(MOLE.x1 - 0.4, z);
  post(SLIPWAY.x0 - 0.45, QUAY_EDGE - 0.32);
  post(SLIPWAY.x1 + 0.45, QUAY_EDGE - 0.32);
  instanced(root, bollard, mats.iron, posts);

  return {
    dispose: () => {
      for (const item of owned) item.dispose();
    },
  };
}

/** Plank packing case with corner posts, rails and a diagonal brace. */
export function addCase(kit: Kit, x: number, y: number, z: number, size: number, yaw: number): void {
  const { batch, colliders, mats } = kit;
  const s = size;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const box = (bw: number, bh: number, bd: number, lx: number, ly: number, lz: number, roll = 0): void => {
    batch.box(mats.crate, bw, bh, bd, x + lx * cos + lz * sin, y + ly, z - lx * sin + lz * cos, { yaw, roll, tile: 1.1 });
  };
  box(s - 0.04, s - 0.04, s - 0.04, 0, s / 2, 0);
  const t = 0.09;
  const e = s / 2 - t / 2 + 0.012;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) box(t, s, t, sx * e, s / 2, sz * e);
    box(t, t, s - t, sx * e, t / 2, 0);
    box(t, t, s - t, sx * e, s - t / 2, 0);
    box(s - t, t, t, 0, t / 2, sx * e);
    box(s - t, t, t, 0, s - t / 2, sx * e);
    box(s * 1.25, t * 0.8, 0.03, 0, s / 2, sx * (s / 2 + 0.002), sx * 0.74);
  }
  colliders.box(s, s, s, x, y + s / 2, z, 'wood', yaw);
}
