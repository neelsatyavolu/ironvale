import * as THREE from 'three/webgpu';
import { addPot, type Kit } from './facade';
import { drapedNet } from './kit';
import { FOUNTAIN, TERRACE_Y } from './layout';
import type { Sea } from './water';

/** Places local (x, z) offsets around a yawed anchor. */
export function localFrame(x: number, z: number, yaw: number): (lx: number, lz: number) => [number, number] {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return (lx, lz) => [x + lx * cos + lz * sin, z - lx * sin + lz * cos];
}

interface Fruit {
  readonly matrix: THREE.Matrix4;
  readonly color: number;
}

const PRODUCE = [0xe07a1f, 0xe3c53a, 0xb5301f, 0x7da03a, 0x4a2a52, 0xd9a03a] as const;

/** Market stalls: [x, z, yaw, awning index, base height]. The counter is waist-high cover. */
const STALLS: readonly (readonly [number, number, number, number])[] = [
  [-6.4, -1.2, 0, 0],
  [7.4, -11.4, -Math.PI / 2, 1],
  [-8.4, -11.6, Math.PI / 2, 2],
  [-19.8, 13.4, Math.PI, 3],
  [17.4, 13.2, Math.PI, 0],
];

function addStall(kit: Kit, x: number, z: number, yaw: number, awning: number, fruit: Fruit[]): void {
  const { batch, colliders, mats, random, density } = kit;
  const at = localFrame(x, z, yaw);
  const box = (material: THREE.Material, w: number, h: number, d: number, lx: number, y: number, lz: number, tile = 1.5, pitch?: number): void => {
    const [wx, wz] = at(lx, lz);
    batch.box(material, w, h, d, wx, y, wz, pitch === undefined ? { yaw, tile } : { yaw, pitch, tile });
  };
  const canvas = mats.awning[awning % mats.awning.length]!;
  for (const sx of [-1.25, 1.25]) {
    box(mats.planks, 0.07, 2.16, 0.07, sx, 1.08, 0.85);
    box(mats.planks, 0.07, 2.56, 0.07, sx, 1.28, -0.85);
  }
  box(canvas, 3.0, 0.025, 2.15, 0, 2.38, 0, 2.5, 0.19);
  box(canvas, 3.0, 0.24, 0.02, 0, 2.06, 1.06, 2.5);
  box(mats.planksPale, 2.5, 0.06, 1.0, 0, 0.87, 0);
  const skirt = canvas;
  box(skirt, 2.5, 0.8, 0.015, 0, 0.44, 0.5, 2.5);
  box(skirt, 0.015, 0.8, 1.0, -1.25, 0.44, 0);
  box(skirt, 0.015, 0.8, 1.0, 1.25, 0.44, 0);
  colliders.box(2.5, 0.9, 1.0, x, 0.45, z, 'wood', yaw);

  // Shallow trays of produce.
  for (let i = 0; i < 4; i++) {
    const cx = -0.93 + i * 0.62;
    const cz = (random() - 0.5) * 0.12;
    box(mats.planks, 0.56, 0.02, 0.42, cx, 0.91, cz);
    box(mats.planks, 0.56, 0.13, 0.02, cx, 0.965, cz - 0.2);
    box(mats.planks, 0.56, 0.13, 0.02, cx, 0.965, cz + 0.2);
    box(mats.planks, 0.02, 0.13, 0.42, cx - 0.27, 0.965, cz);
    box(mats.planks, 0.02, 0.13, 0.42, cx + 0.27, 0.965, cz);
    const color = PRODUCE[Math.floor(random() * PRODUCE.length)]!;
    const count = 12 + Math.round(34 * density);
    for (let n = 0; n < count; n++) {
      const [fx, fz] = at(cx + (random() - 0.5) * 0.46, cz + (random() - 0.5) * 0.32);
      const scale = 0.85 + random() * 0.4;
      fruit.push({
        matrix: new THREE.Matrix4().compose(
          new THREE.Vector3(fx, 0.955 + random() * 0.06, fz),
          new THREE.Quaternion(),
          new THREE.Vector3(scale, scale, scale),
        ),
        color,
      });
    }
  }
}

/** Round stone fountain: stepped plinth, basin and a central bowl. */
function addFountain(kit: Kit, root: THREE.Object3D, sea: Sea, owned: { dispose(): void }[]): void {
  const { batch, colliders, mats } = kit;
  const { x, z } = FOUNTAIN;
  const lathe = (points: readonly (readonly [number, number])[], segments: number): THREE.LatheGeometry =>
    new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
  const plinth = lathe([[0.001, 0.14], [2.75, 0.14], [2.75, 0]], 32);
  const basin = lathe([[1.72, 0.2], [1.72, 0.72], [1.8, 0.8], [2.14, 0.8], [2.22, 0.72], [2.16, 0.3], [2.25, 0.14]], 32);
  const column = lathe(
    [[0.001, 0.2], [0.5, 0.2], [0.42, 0.5], [0.24, 0.62], [0.2, 1.35], [0.32, 1.45], [0.82, 1.62], [0.86, 1.72], [0.7, 1.72], [0.22, 1.56], [0.12, 1.62], [0.1, 2.05], [0.17, 2.14], [0.001, 2.28]],
    20,
  );
  batch.place(mats.stone, plinth, x, 0, z, 0, 1, 2);
  batch.place(mats.stoneLight, basin, x, 0, z, 0, 1, 1.4);
  batch.place(mats.stoneLight, column, x, 0, z, 0, 1, 1.4);
  const plinthCollider = new THREE.CylinderGeometry(2.75, 2.75, 0.14, 16);
  const basinCollider = new THREE.CylinderGeometry(2.2, 2.2, 0.66, 16);
  const columnCollider = new THREE.CylinderGeometry(0.5, 0.5, 2, 8);
  colliders.shape(plinthCollider, x, 0.07, z, 'concrete');
  colliders.shape(basinCollider, x, 0.47, z, 'concrete');
  colliders.shape(columnCollider, x, 1.2, z, 'concrete');
  for (const geometry of [plinth, basin, column, plinthCollider, basinCollider, columnCollider]) geometry.dispose();

  const pool = new THREE.CircleGeometry(1.74, 28);
  pool.rotateX(-Math.PI / 2);
  owned.push(pool);
  const water = new THREE.Mesh(pool, sea.material);
  water.position.set(x, 0.62, z);
  water.receiveShadow = true;
  root.add(water);
}

function lantern(kit: Kit, x: number, y: number, z: number): void {
  const { batch, mats } = kit;
  batch.box(mats.lamp, 0.17, 0.26, 0.17, x, y, z);
  batch.box(mats.iron, 0.28, 0.035, 0.28, x, y + 0.16, z);
  batch.box(mats.iron, 0.16, 0.07, 0.16, x, y + 0.21, z);
  batch.box(mats.iron, 0.22, 0.03, 0.22, x, y - 0.15, z);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) batch.box(mats.iron, 0.018, 0.3, 0.018, x + sx * 0.095, y, z + sz * 0.095);
}

/** Cast-iron lamp standard. The lantern sits 3.5 m up. */
function addLampPost(kit: Kit, x: number, z: number, base = 0): void {
  const { batch, colliders, mats } = kit;
  const shaft = new THREE.CylinderGeometry(0.04, 0.065, 3.1, 8);
  const foot = new THREE.CylinderGeometry(0.1, 0.16, 0.5, 10);
  batch.place(mats.iron, shaft, x, base + 1.75, z);
  batch.place(mats.iron, foot, x, base + 0.25, z);
  shaft.dispose();
  foot.dispose();
  lantern(kit, x, base + 3.5, z);
  colliders.box(0.22, 3.3, 0.22, x, base + 1.65, z, 'metal');
}

/** Lantern on a wall bracket; (nx, nz) points away from the wall. */
function addWallLantern(kit: Kit, x: number, y: number, z: number, nx: number, nz: number): void {
  const { batch, mats } = kit;
  const reach = 0.5;
  batch.box(mats.iron, nx !== 0 ? reach : 0.03, 0.03, nz !== 0 ? reach : 0.03, x + (nx * reach) / 2, y + 0.3, z + (nz * reach) / 2);
  batch.box(mats.iron, 0.02, 0.12, 0.02, x + nx * reach, y + 0.24, z + nz * reach);
  lantern(kit, x + nx * reach, y, z + nz * reach);
}

/** Washing line between two walls. */
function addLaundry(kit: Kit, x0: number, z0: number, x1: number, z1: number, y: number): void {
  const { batch, mats, random } = kit;
  const length = Math.hypot(x1 - x0, z1 - z0);
  const yaw = Math.atan2(-(z1 - z0), x1 - x0);
  batch.box(mats.rope, length, 0.012, 0.012, (x0 + x1) / 2, y, (z0 + z1) / 2, { yaw });
  let t = 0.25 + random() * 0.2;
  while (t < length - 0.5) {
    const w = 0.35 + random() * 0.45;
    const h = 0.45 + random() * 0.55;
    const f = (t + w / 2) / length;
    batch.box(mats.cloth[Math.floor(random() * mats.cloth.length)]!, w, h, 0.012, x0 + (x1 - x0) * f, y - h / 2 - 0.01, z0 + (z1 - z0) * f, {
      yaw,
      pitch: (random() - 0.5) * 0.12,
    });
    t += w + 0.08 + random() * 0.3;
  }
}

/** Positions of the lamps that get a real light, strongest first. At most eight are used. */
export const LIGHT_SPOTS: readonly (readonly [number, number, number, number])[] = [
  [-4.5, 2.5, 6, 30],
  [-30.2, 2.5, 6, 26],
  [9.25, 2.45, 6, 16],
  [-31.4, 4.5, -9, 14],
  [-10.6, 3.35, -2.6, 22],
  [-20, 3.35, 18.7, 22],
  [15, 3.35, 18.7, 22],
  [10.6, 3.35, -12.6, 22],
];

export interface Dressing {
  dispose(): void;
}

/** Fountain, market stalls, street lamps, washing lines and potted plants. */
export function addDressing(kit: Kit, root: THREE.Object3D, sea: Sea): Dressing {
  const { mats, random } = kit;
  const owned: { dispose(): void }[] = [];
  addFountain(kit, root, sea, owned);

  const fruit: Fruit[] = [];
  for (const [x, z, yaw, awning] of STALLS) addStall(kit, x, z, yaw, awning, fruit);
  if (fruit.length > 0) {
    const geometry = new THREE.SphereGeometry(0.034, 7, 5);
    owned.push(geometry);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.55 });
    owned.push(material);
    const mesh = new THREE.InstancedMesh(geometry, material, fruit.length);
    const color = new THREE.Color();
    fruit.forEach((item, i) => {
      mesh.setMatrixAt(i, item.matrix);
      mesh.setColorAt(i, color.setHex(item.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    root.add(mesh);
  }

  for (const [x, z] of [
    [-20, 18.7],
    [15, 18.7],
    [-40, 18.7],
    [48.8, 18.8],
    [-10.6, -2.6],
    [10.6, -12.6],
  ] as const) {
    addLampPost(kit, x, z);
  }
  addLampPost(kit, -25, -16.6, TERRACE_Y);
  addLampPost(kit, 25.5, -16.6, TERRACE_Y);
  addWallLantern(kit, 6.4, 2.75, 10, 0, 1);
  addWallLantern(kit, 12.1, 2.75, 2, 0, -1);
  addWallLantern(kit, -32, 4.5, -9, 1, 0);
  addWallLantern(kit, -4.7, 2.8, 2, 0, -1);
  addWallLantern(kit, -24.2, 2.9, 10, 0, 1);
  addWallLantern(kit, -16, 3.1, 5, 1, 0);
  addWallLantern(kit, 36.5, 3.1, 6.5, -1, 0);
  addWallLantern(kit, -3.4, TERRACE_Y + 3, -22, 0, 1);
  addWallLantern(kit, 3.4, TERRACE_Y + 3, -22, 0, 1);
  addWallLantern(kit, 34, TERRACE_Y + 2.2, -10, -1, 0);

  addLaundry(kit, -16, 5.4, -12, 5.0, 5.3);
  addLaundry(kit, -16, 7.8, -12, 8.1, 7.6);
  addLaundry(kit, -38, 6, -35.5, 6.2, 4.9);
  addLaundry(kit, -32, -9.6, -29.5, -9.4, 7.4);
  addLaundry(kit, -32, -13.6, -29.5, -13.8, 7.9);
  addLaundry(kit, 33, 5.6, 36.5, 5.3, 5.2);
  addLaundry(kit, 30, -4, 30.4, 2, 6.4);
  addLaundry(kit, 30, -9.2, 34, -9.5, 7.6);
  addLaundry(kit, 30, -13.2, 34, -12.9, 8.3);
  addLaundry(kit, -30.5, -4, -30.2, 2, 6.6);

  // Pots by doors and steps.
  for (const [x, z, y] of [
    [-12.5, 10.5, 0],
    [3.5, 10.5, 0],
    [-2.9, -21.3, TERRACE_Y],
    [2.9, -21.3, TERRACE_Y],
    [-11.4, 1.4, 0],
    [11.5, -3.6, 0],
    [-29.9, -5.4, 0],
    [-36, 1.5, 0],
    [22, -3.5, 0],
    [36.9, 10.5, 0],
    [-47, -21.4, TERRACE_Y],
    [30.6, -21.4, TERRACE_Y],
    [-11.4, -15.3, 0],
    [30.5, -4.4, 0],
    [33.5, -4.4, 0],
    [12.6, -17, TERRACE_Y],
    [-12.6, -17, TERRACE_Y],
    [47, 10.6, 0],
    [-27.5, 10.5, 0],
  ] as const) {
    addPot(kit, x, y, z, 1.1 + random() * 0.5);
  }

  // Net drying on a rail beside the net store, and floats heaped by its door.
  const { batch } = kit;
  for (const x of [-40.6, -37]) batch.box(mats.planks, 0.08, 1.95, 0.08, x, 0.975, 10.85);
  batch.box(mats.planks, 3.8, 0.07, 0.07, -38.8, 1.95, 10.85);
  const net = drapedNet(3.5, 1.7, 0.22);
  batch.place(mats.net, net, -38.8, 1.08, 10.9, 0, 1, 0.3);
  batch.place(mats.net, net, -38.8, 1.02, 10.78, Math.PI, 1, 0.3);
  net.dispose();
  const ball = new THREE.SphereGeometry(0.12, 10, 8);
  for (let i = 0; i < 9; i++) {
    batch.place(mats.float, ball, -33.6 + random() * 0.9, 0.12 + (i > 5 ? 0.2 : 0), 10.5 + random() * 0.5, 0, 0.8 + random() * 0.4);
  }
  ball.dispose();

  return {
    dispose: () => {
      for (const item of owned) item.dispose();
    },
  };
}
