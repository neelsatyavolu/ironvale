import * as THREE from 'three/webgpu';
import type { Kit } from './facade';
import { drapedNet } from './kit';
import { CAFE, NET_STORE, PASSAGE } from './layout';

const WALL = 0.39;

/** Regions that count as indoors: cafe, net store and the vaulted passage. */
export const INTERIOR_BOXES: readonly (readonly [number, number, number, number, number, number])[] = [
  [CAFE.x0 + WALL, CAFE.x1 - WALL, 0, 3, CAFE.z0 + 0.1, CAFE.z1 - 0.1],
  [NET_STORE.x0 + WALL, NET_STORE.x1 - WALL, 0, 3, NET_STORE.z0 + 0.1, NET_STORE.z1 - 0.1],
  [PASSAGE.x0, PASSAGE.x1, 0, 2.9, CAFE.z0 + 0.4, CAFE.z1 - 0.4],
];

function addTable(kit: Kit, x: number, z: number, chairs: number, y = 0): void {
  const { batch, colliders, mats, random } = kit;
  const top = new THREE.CylinderGeometry(0.4, 0.4, 0.035, 16);
  const leg = new THREE.CylinderGeometry(0.03, 0.03, 0.72, 6);
  const foot = new THREE.CylinderGeometry(0.22, 0.24, 0.03, 12);
  batch.place(mats.planksPale, top, x, y + 0.75, z);
  batch.place(mats.iron, leg, x, y + 0.37, z);
  batch.place(mats.iron, foot, x, y + 0.015, z);
  for (const geometry of [top, leg, foot]) geometry.dispose();
  colliders.box(0.72, 0.77, 0.72, x, y + 0.385, z, 'wood', 0.4);

  const start = random() * Math.PI * 2;
  for (let i = 0; i < chairs; i++) {
    const angle = start + (i * Math.PI * 2) / chairs + (random() - 0.5) * 0.3;
    const cx = x + Math.cos(angle) * 0.72;
    const cz = z + Math.sin(angle) * 0.72;
    // The seat back is at local +Z, so local -Z has to point at the table.
    const yaw = Math.atan2(-(x - cx), -(z - cz));
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const part = (w: number, h: number, d: number, lx: number, ly: number, lz: number): void => {
      batch.box(mats.planks, w, h, d, cx + lx * cos + lz * sin, y + ly, cz - lx * sin + lz * cos, { yaw, tile: 1 });
    };
    part(0.4, 0.035, 0.4, 0, 0.45, 0);
    part(0.4, 0.42, 0.03, 0, 0.7, 0.185);
    for (const sx of [-0.17, 0.17]) for (const sz of [-0.17, 0.17]) part(0.035, sz > 0 ? 0.9 : 0.45, 0.035, sx, sz > 0 ? 0.45 : 0.225, sz);
  }
}

export interface Interiors {
  update(elapsed: number): void;
  dispose(): void;
}

/** Furniture for the cafe and the net store, the cafe awning and its hanging sign. */
export function addInteriors(kit: Kit, root: THREE.Object3D): Interiors {
  const { batch, colliders, mats, random } = kit;

  // Cafe: bar along the east wall, bottles behind it, tables inside and out.
  const barX0 = CAFE.x1 - 1.75;
  batch.span(mats.planks, barX0, barX0 + 0.6, 0, 1.06, 3.3, 8.3, { tile: 1.2 });
  batch.span(mats.stoneLight, barX0 - 0.08, barX0 + 0.68, 1.06, 1.11, 3.22, 8.38, { tile: 1.2 });
  colliders.span(barX0, barX0 + 0.6, 0, 1.11, 3.3, 8.3, 'wood');
  const shelfX = CAFE.x1 - WALL - 0.24;
  for (const y of [1.25, 1.7, 2.15]) {
    batch.span(mats.planksShade, shelfX, shelfX + 0.24, y, y + 0.035, 3.4, 8.2, { tile: 1.2 });
    for (let z = 3.55; z < 8.1; z += 0.16 + random() * 0.14) {
      const tall = 0.2 + random() * 0.12;
      const glass = [mats.glass, mats.foliage, mats.brass, mats.terracotta][Math.floor(random() * 4)]!;
      batch.box(glass, 0.065, tall, 0.065, shelfX + 0.1, y + 0.035 + tall / 2, z);
    }
  }
  addTable(kit, -9.4, 5.1, 3);
  addTable(kit, -6, 7.4, 2);
  addTable(kit, -3.1, 4.5, 3);
  addTable(kit, -10.7, 11.7, 2);
  addTable(kit, -4.7, 11.9, 3);
  addTable(kit, 1.5, 11.6, 2);
  for (const [x, z] of [
    [-8.2, 6],
    [-3.6, 6.2],
    [0.2, 5.4],
  ] as const) {
    batch.box(mats.iron, 0.012, 0.5, 0.012, x, 2.47, z);
    batch.box(mats.lamp, 0.14, 0.12, 0.14, x, 2.18, z);
    batch.box(mats.iron, 0.3, 0.02, 0.3, x, 2.25, z);
  }

  // Canvas awning over the cafe front.
  const span = CAFE.x1 - CAFE.x0 - 1.6;
  const cx = (CAFE.x0 + CAFE.x1) / 2;
  batch.box(mats.awning[1]!, span, 0.025, 2.5, cx, 2.92, CAFE.z1 + 1.2, { pitch: 0.2, tile: 2.5 });
  batch.box(mats.awning[1]!, span, 0.22, 0.02, cx, 2.56, CAFE.z1 + 2.42, { tile: 2.5 });
  for (const x of [CAFE.x0 + 0.9, cx, CAFE.x1 - 0.9]) {
    batch.box(mats.iron, 0.03, 0.03, 2.5, x, 2.9, CAFE.z1 + 1.2, { pitch: 0.2 });
  }

  // Sign on a bracket at the cafe corner. It swings a little in the breeze.
  const signX = CAFE.x0 + 0.6;
  batch.box(mats.iron, 0.03, 0.03, 1.0, signX, 3.75, CAFE.z1 + 0.5);
  const board = new THREE.BoxGeometry(0.04, 0.5, 0.78);
  board.translate(0, -0.32, 0);
  const sign = new THREE.Mesh(board, mats.paint[4]!);
  sign.position.set(signX, 3.73, CAFE.z1 + 0.55);
  sign.castShadow = true;
  root.add(sign);

  // Net store: racking on the west wall, a bench, nets hung from the beams.
  const rackX = NET_STORE.x0 + WALL;
  for (const z of [3.1, 4.9, 6.7]) batch.span(mats.planksShade, rackX, rackX + 0.55, 0, 2.2, z - 0.04, z + 0.04, { tile: 1.2 });
  for (const y of [0.45, 1.05, 1.65, 2.2]) {
    batch.span(mats.planksShade, rackX, rackX + 0.55, y, y + 0.04, 3.1, 6.7, { tile: 1.2 });
    for (let z = 3.35; z < 6.4 && y < 2; z += 0.55 + random() * 0.4) {
      const h = 0.2 + random() * 0.22;
      batch.box([mats.planks, mats.rope, mats.float, mats.paint[0]!][Math.floor(random() * 4)]!, 0.36, h, 0.36, rackX + 0.28, y + 0.04 + h / 2, z, { tile: 1 });
    }
  }
  colliders.span(rackX, rackX + 0.55, 0, 2.24, 3.1, 6.7, 'wood');
  const benchX0 = NET_STORE.x1 - WALL - 0.8;
  batch.span(mats.planks, benchX0, benchX0 + 0.8, 0.82, 0.9, 5.2, 8.6, { tile: 1.2 });
  for (const z of [5.3, 8.5]) batch.span(mats.planks, benchX0 + 0.05, benchX0 + 0.75, 0, 0.82, z - 0.05, z + 0.05, { tile: 1.2 });
  colliders.span(benchX0, benchX0 + 0.8, 0, 0.9, 5.2, 8.6, 'wood');
  const drape = drapedNet(2.6, 1.3, 0.2);
  // Hung along the walls, clear of the way between the two doors.
  batch.place(mats.net, drape, -33.3, 2.06, 9.2, 0.04, 1, 0.3);
  batch.place(mats.net, drape, -26.5, 2.06, 6.9, Math.PI / 2, 1, 0.3);
  drape.dispose();
  for (const [x, z] of [
    [-32.4, 5.6],
    [-28.4, 6.8],
  ] as const) {
    batch.box(mats.iron, 0.012, 0.45, 0.012, x, 2.5, z);
    batch.box(mats.lamp, 0.14, 0.12, 0.14, x, 2.22, z);
    batch.box(mats.iron, 0.3, 0.02, 0.3, x, 2.29, z);
  }

  return {
    update: (elapsed) => {
      sign.rotation.z = Math.sin(elapsed * 1.3) * 0.07 + Math.sin(elapsed * 0.37) * 0.04;
    },
    dispose: () => board.dispose(),
  };
}
