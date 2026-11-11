import * as THREE from 'three/webgpu';
import { archedPanel, archSurround } from './arch';
import { Frame, type Kit } from './facade';

/** What the church front needs to know about the wall it dresses. */
export interface ChurchFront {
  readonly x0: number;
  readonly x1: number;
  /** Plane of the south wall. */
  readonly z: number;
  readonly base: number;
  readonly height: number;
  readonly ridgeY: number;
}

const ROSE_Y = 7.1;
const ROSE_RADIUS = 1.05;

/** Flat quad on the wall for the stain material, strongest along its top edge. */
function runOff(kit: Kit, x0: number, x1: number, y0: number, y1: number, z: number, strength: number): void {
  const quad = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
  const uv = quad.getAttribute('uv');
  for (let k = 0; k < uv.count; k++) uv.setY(k, uv.getY(k) * strength);
  quad.translate((x0 + x1) / 2, (y0 + y1) / 2, z + 0.008);
  kit.batch.add(kit.mats.stain, quad);
}

/**
 * Stonework that turns the church's plaster box into a front: a wheel of
 * tracery in the rose window, a pedimented portal, arched side windows behind
 * iron bars, a raking cornice up the gable and the rain staining that a
 * century leaves under every ledge.
 */
export function addChurchFront(kit: Kit, front: ChurchFront): void {
  const { batch, mats } = kit;
  const { x0, x1, z, base, height, ridgeY } = front;
  const cx = (x0 + x1) / 2;
  const frame = new Frame(batch, 's', x0, z, base);
  const u = (x: number): number => x - x0;

  // Rose window: dark glass, eight spokes, an inner ring and a boss.
  const glass = new THREE.CircleGeometry(ROSE_RADIUS, 28);
  batch.place(mats.glass, glass, cx, base + ROSE_Y, z + 0.03);
  glass.dispose();
  for (let k = 0; k < 4; k++) {
    batch.box(mats.stoneLight, ROSE_RADIUS * 2, 0.075, 0.07, cx, base + ROSE_Y, z + 0.06, { roll: (k * Math.PI) / 4, tile: 1.5 });
  }
  const ring = new THREE.TorusGeometry(0.46, 0.05, 6, 24);
  batch.place(mats.stoneLight, ring, cx, base + ROSE_Y, z + 0.06);
  ring.dispose();
  const boss = new THREE.CylinderGeometry(0.17, 0.17, 0.12, 12);
  boss.rotateX(Math.PI / 2);
  batch.place(mats.stoneLight, boss, cx, base + ROSE_Y, z + 0.07);
  boss.dispose();
  const outer = new THREE.TorusGeometry(1.34, 0.07, 6, 32);
  batch.place(mats.stoneLight, outer, cx, base + ROSE_Y, z + 0.03);
  outer.dispose();

  // Portal: pilasters, an entablature and a pediment over the arched door.
  for (const side of [-1, 1]) {
    frame.box(mats.stoneLight, u(cx + side * 2.05) - 0.24, u(cx + side * 2.05) + 0.24, 0, 4.15, 0, 0.26, { tile: 1.5 });
    frame.box(mats.stoneLight, u(cx + side * 2.05) - 0.32, u(cx + side * 2.05) + 0.32, 0, 0.5, 0, 0.34, { tile: 1.5 });
    frame.box(mats.stoneLight, u(cx + side * 2.05) - 0.3, u(cx + side * 2.05) + 0.3, 3.95, 4.15, 0, 0.32, { tile: 1.5 });
    batch.box(mats.stoneLight, 2.85, 0.2, 0.34, cx + side * 1.25, base + 4.98, z + 0.17, { roll: side * -0.36, tile: 1.5 });
  }
  frame.box(mats.stoneLight, u(cx) - 2.45, u(cx) + 2.45, 4.15, 4.5, 0, 0.3, { tile: 1.5 });
  frame.box(mats.stoneLight, u(cx) - 2.6, u(cx) + 2.6, 4.5, 4.62, 0, 0.38, { tile: 1.5 });
  runOff(kit, cx - 2.5, cx + 2.5, base + 3.0, base + 4.15, z + 0.02, 0.8);

  // Side windows: arched, set in stone, barred.
  const pane = archedPanel(1.2, 1.7, 0.6);
  const surround = archSurround(1.2, 1.7, 0.6, 0.2, 0.14);
  for (const wx of [x0 + 2.9, x1 - 2.9]) {
    batch.place(mats.glass, pane, wx, base + 2.2, z + 0.035, 0, 1, 1);
    batch.place(mats.stoneLight, surround, wx, base + 2.2, z, 0, 1, 1.4);
    frame.box(mats.stoneLight, u(wx) - 0.85, u(wx) + 0.85, 2.02, 2.2, 0, 0.2, { tile: 1.5 });
    for (let bar = -0.4; bar <= 0.41; bar += 0.2) frame.box(mats.iron, u(wx) + bar - 0.012, u(wx) + bar + 0.012, 2.2, 4.2, 0.07, 0.094);
    for (const v of [2.8, 3.5]) frame.box(mats.iron, u(wx) - 0.6, u(wx) + 0.6, v, v + 0.024, 0.07, 0.094);
    runOff(kit, wx - 0.95, wx + 0.95, base + 0.8, base + 2.02, z + 0.08, 0.9);
  }
  pane.dispose();
  surround.dispose();

  // Raking cornice up both sides of the gable, and a stone cross at its head.
  const half = (x1 - x0) / 2;
  const rise = ridgeY - (base + height);
  const rake = Math.hypot(half, rise);
  const pitch = Math.atan2(rise, half);
  for (const side of [-1, 1]) {
    batch.box(mats.stoneLight, rake + 0.3, 0.26, 0.3, cx + (side * half) / 2, base + height + rise / 2 - 0.2, z + 0.13, { roll: side * -pitch, tile: 1.5 });
  }
  batch.box(mats.stoneLight, 0.5, 0.4, 0.4, cx, ridgeY - 0.1, z + 0.12, { tile: 1.5 });
  batch.box(mats.stoneLight, 0.16, 1.3, 0.14, cx, ridgeY + 0.75, z + 0.12, { tile: 1.5 });
  batch.box(mats.stoneLight, 0.7, 0.16, 0.14, cx, ridgeY + 0.95, z + 0.12, { tile: 1.5 });

  // Rain marks: under the main cornice, under the string course and below the rose.
  runOff(kit, x0 + 0.7, x1 - 0.7, base + height - 2.3, base + height - 0.5, z + 0.02, 0.85);
  runOff(kit, x0 + 0.7, x1 - 0.7, base + 3.4, base + 5.0, z + 0.02, 0.75);
  runOff(kit, cx - 1.5, cx + 1.5, base + ROSE_Y - 2.0, base + ROSE_Y - 1.2, z + 0.02, 0.7);
  // Damp climbing from the terrace paving.
  const foot = new THREE.PlaneGeometry(x1 - x0 - 1.4, 1.6);
  const uv = foot.getAttribute('uv');
  for (let k = 0; k < uv.count; k++) uv.setY(k, (1 - uv.getY(k)) * 0.8);
  foot.translate(cx, base + 0.7 + 0.8, z + 0.09);
  batch.add(mats.stain, foot);
}
