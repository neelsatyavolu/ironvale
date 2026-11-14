import * as THREE from 'three/webgpu';
import type { Clutter } from './clutter';
import type { Kit } from './kit';
import type { Materials } from './materials';
import { RAIL, WAREHOUSE } from './plan';
import type { Props } from './props';

const HALF_PI = Math.PI / 2;
const TOP = WAREHOUSE.mezzanine.top;
const STAINS = 66;

/** Cover and clutter with colliders. Positions are fixed so both network players see the same level. */
export function dressYard(p: Props): void {
  // Gate and staging area at the south end.
  p.barrierRun(-1.6, 40.5, 3, 0);
  p.barrierRun(5.2, 37.6, 2, 0.15);
  p.palletStack(-8.5, 44.8, 6);
  p.palletStack(-9.9, 44.6, 3, 0.2);
  p.loadedPallet(-8.8, 43.2, 0.1);
  p.forklift(17.2, 40.6, 2.6);
  p.ibc(14.2, 48.3);
  p.ibc(15.5, 48.35, 0.05);
  p.ibc(14.2, 48.3, 0.03, 1.17);
  p.skip(-37, 38.5, 0, 0x2f5d7a);
  p.barrels(-17.5, 44, 3);
  p.cylinders(-30, 49.7, 4, 0);
  p.spool(-13, 38, 0.9, true, 0.3);
  p.generator(40.2, 21.6, HALF_PI);
  // South-west yard, on the way to the warehouse's south door.
  p.blocks(-27.5, 31, 3, 2, 0);
  p.palletStack(-34.5, 22.2, 7);
  p.palletStack(-35.9, 22.3, 4, 0.15);
  p.loadedPallet(-25.2, 22.4, 0.05);
  p.loadedPallet(-23.8, 22.5, -0.08);
  p.crate(-19.8, 34.5, 1.8, 1.25, 1.3, 0.3);
  p.spool(-33.2, 46.6, 0.75, false);
  p.palletStack(-40.6, 42.6, 5, 0.1);
  p.blocks(-39.5, 24.5, 2, 1, 0);
  p.barrels(-40.4, 33, 3, true);
  p.forklift(-31.5, 36.5, 0.9);
  for (const [x, z] of [[-18.9, 23.3], [-19.3, 23.6], [39.2, 19.6], [39.6, 19.9], [-40.7, 1.6], [-40.3, 1.3]] as const) {
    p.model('mdl-railyard-propane', x, z, x * 7);
  }

  // Central avenue: cover on alternate sides, the middle left clear for the long view.
  p.ibc(1.7, 27, 0.05);
  p.ibc(1.75, 28.2, -0.04);
  p.spool(6.5, 21.8, 0.9, true, HALF_PI);
  p.blocks(1.5, 11.5, 2, 1, HALF_PI);
  p.barrels(6.35, 3.5, 3);
  p.palletStack(6.7, -3.5, 5, 0.1);
  p.loadedPallet(6.6, -5.0, -0.05);
  p.blocks(1.5, -13.2, 2, 2, HALF_PI);
  p.ibc(6.6, -21);
  p.ibc(6.6, -21, 0.04, 1.17);
  p.spool(1.7, -25.5, 0.75, false);

  // West lane between the stacks, with the dead-end nook.
  p.palletStack(-8.5, -16, 7);
  p.loadedPallet(-8.45, -14.6);
  p.barrels(-3.3, 7.4, 4, true);
  p.loadedPallet(-3.3, 4.1, HALF_PI);
  p.ibc(-5.3, 11.5);
  p.barrels(-8.6, 25.5, 2);
  p.crate(-5.5, 27.5, 1.6, 1.2, 1.2, 0);

  // East lane and its dead end.
  p.barrels(13.5, -22.5, 3);
  p.palletStack(10.8, 3, 5);
  p.loadedPallet(13.4, -4, 0.1);
  p.spool(12.2, 30.2, 0.9, false);
  p.cylinders(13.98, 26.5, 3, HALF_PI);
  p.crate(10.9, 25.5, 1.2, 1.0, 1.8, 0);

  // Road along the warehouse.
  p.skip(-13.2, 27.5, HALF_PI, 0x63392a);
  p.blocks(-12.5, -13, 2, 2, HALF_PI);
  p.blocks(-15.5, -29.4, 3, 2, 0);
  p.barrels(-12.5, -1, 2);
  p.palletStack(-12.6, 13.5, 4);

  // Lane beside the tracks.
  p.crate(17.9, -22, 1.8, 1.3, 1.3, HALF_PI);
  p.barrels(17.6, -6, 3);
  p.palletStack(17.6, 24.5, 6);
  p.loadedPallet(17.7, 26, 0.08);
  p.blocks(20.6, 14.5, 2, 1, HALF_PI);

  // East strip.
  p.blocks(34, 2.2, 2, 2, 0.1);
  p.ibc(40.6, -2.5);
  p.ibc(40.6, -1.3, 0.04);
  p.ibc(40.6, -2.5, 0.02, 1.17);
  p.blocks(34.5, -26, 2, 2, HALF_PI);
  p.palletStack(40.4, 36, 8);
  p.palletStack(40.4, 37.3, 4, 0.1);
  p.loadedPallet(38.9, 36.4, 0.2);
  p.skip(38.2, 44.6, 0.05, 0x2f5d7a);
  p.barrels(33.6, 31, 3);
  p.crate(RAIL.trackA, -3.4, 2.0, 1.1, 2.2, 0, 1.2);

  // Quay apron.
  p.blocks(-1.5, -34, 3, 2, 0);
  p.spool(-18.5, -41.5, 0.9, true, 0.5);
  p.spool(-20.4, -40.0, 0.6, false);
  p.loadedPallet(27.5, -35.5);
  p.loadedPallet(28.9, -35.3, 0.1);
  p.loadedPallet(28.2, -36.9, 1.5);
  p.barrels(-36.5, -33, 4, true);
  p.generator(-38.5, -43, 0);
  p.blocks(29.5, -43.6, 3, 1, 0);
  p.ibc(4.5, -42.2);
  p.ibc(5.8, -42.3, 0.06);
  p.crate(-29, -43, 2.2, 1.3, 1.4, 0.1);

  // Warehouse floor.
  p.forklift(-21.5, 4.5, -0.6);
  p.loadedPallet(-22, -15, 0.1);
  p.loadedPallet(-20.4, -16.6, 1.6);
  p.loadedPallet(-22.6, 12);
  p.ibc(-20.2, 16.5);
  p.ibc(-21.5, 16.6, 0.05);
  p.palletStack(-19.6, -2, 6);
  p.loadedPallet(-28.3, -9);
  p.loadedPallet(-31.8, 6, 0.05);
  p.palletStack(-28.2, 12.5, 4);
  p.barrels(-38.5, -20.5, 5, true);
  p.spool(-37.4, -17.6, 0.75, true, 0.2);
  p.cylinders(-41.4, -18, 4, HALF_PI);
  // Under and on the mezzanine.
  p.bench(-41.25, 4, HALF_PI);
  p.loadedPallet(-38, -5);
  p.loadedPallet(-38.1, -3.6, 0.1);
  p.palletStack(-39.5, 13, 9);
  p.crate(-37.5, 9.5, 1.6, 1.1, 1.2, 0);
  p.loadedPallet(-40, 2, 0.1, TOP);
  p.loadedPallet(-39.8, 10, 1.5, TOP);
  p.ibc(-40.5, 14.4, 0, TOP);
}

/** Tyres, bollards, bins, drains, inspection covers and overhead cables. */
export function dressDetails(c: Clutter): void {
  const at = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  // Tyre stacks: five high is chest-high cover.
  c.tyres(11.4, 41.2, 5);
  c.tyres(12.5, 41.8, 2);
  c.tyres(-12.4, 6.5, 5);
  c.tyres(34.5, 38.5, 5);
  c.tyres(35.6, 39.1, 3);
  c.tyres(19.6, -30.6, 5);
  c.tyres(-30, -31.6, 4);

  for (const [x, z] of [[34.7, 8.6], [34.7, 18.9], [-22.6, -25.3], [-19.6, -25.3], [-35.2, 21.6], [-24.8, 21.6]] as const) c.bollard(x, z);
  c.bin(34.5, 20.2, HALF_PI, 0x2d5a3a);
  c.bin(-21.6, 20.75, 0, 0x2d5a3a);
  c.bin(-20.8, 20.75, 0.06, 0x24333d);

  for (const [x, z] of [[3.5, 43], [-14.8, 10], [4.2, -12], [27, -37.5], [36.8, 24.5], [-25, 28], [12.2, 12], [-30, 2]] as const) c.manhole(x, z);
  c.drain(-16, 35.4, 21, 35.4);
  c.drain(-17.5, -23.8, -17.5, 19.8);
  c.drain(-41.5, -30.7, 21, -30.7);
  c.drain(33.2, -29, 33.2, 46);

  // Overhead cables between the floodlight masts and the buildings.
  const mast = 11.42;
  c.cable(at(20.9, mast, 37), at(33.3, mast, -9), 2.2);
  c.cable(at(33.3, mast, -9), at(22.6, mast, -33.2), 1.3);
  c.cable(at(-18.8, mast, 21.2), at(-18.05, 7.7, 19.7), 0.35);
  c.cable(at(20.9, mast, 37), at(24.5, 3.7, 50.1), 0.9);
  c.cable(at(40.6, 5.2, 17.7), at(33.3, mast, -9), 1.6);
  c.cable(at(-11.9, mast, -33.4), at(-18.05, 7.7, -23.8), 0.8);
}

/** Small decoration with no colliders. The amount follows the detail setting. */
export function scatterDetail(kit: Kit, m: Materials): void {
  // Traffic cones.
  const cones: readonly [number, number][] = [
    [-4.4, 47.6], [4.4, 47.6], [0.9, 33.4], [7.1, 33.4], [-16.8, 20.6], [-16.8, -24.6], [18.4, 12.4],
    [18.4, -0.4], [33, 20], [33, 8], [-9, -31], [8, -31.2], [26.9, 44], [-33.6, 21.2], [-26.4, 21.2], [-11, 35],
  ];
  const cone = new THREE.CylinderGeometry(0.03, 0.13, 0.46, 10);
  const band = new THREE.CylinderGeometry(0.065, 0.09, 0.11, 10);
  cones.forEach(([x, z], i) => {
    const lean = kit.range(0, Math.PI * 2);
    if (i / cones.length >= kit.detail) return;
    kit.add(m.matte, cone, kit.transform(x, 0.27, z, lean), 0xc8501a);
    kit.add(m.matte, band, kit.transform(x, 0.3, z, lean), 0xdedcd4);
    kit.box(m.matte, 0.3, 0.035, 0.3, x, 0, z, { yaw: lean, color: 0xc8501a });
  });
  cone.dispose();
  band.dispose();

  // Oil stains and tyre scuffs: soft dark patches with a wet sheen.
  const patch = new THREE.PlaneGeometry(1, 1).rotateX(-HALF_PI);
  const stains = Math.round(STAINS * kit.detail);
  for (let i = 0; i < STAINS; i++) {
    // A third of them inside the shed, where forklifts leak and turn.
    const inShed = i % 3 === 0;
    const x = inShed ? kit.range(-40, -19) : kit.range(-17, 41);
    const z = inShed ? kit.range(-23, 19) : kit.range(-44, 48);
    const size = kit.range(1.2, 3.6);
    const stretch = kit.range(0.5, 1);
    const turn = kit.range(0, Math.PI);
    if (i >= stains) continue;
    kit.add(m.stain, patch, kit.transform(x, 0.006, z, turn).multiply(new THREE.Matrix4().makeScale(size, 1, size * stretch)));
  }
  const scuffs = Math.round(22 * kit.detail);
  for (let i = 0; i < 22; i++) {
    const x = kit.range(-16, 20);
    const z = kit.range(-42, 46);
    const yaw = kit.range(-0.25, 0.25) + (kit.random() < 0.3 ? HALF_PI : 0);
    const length = kit.range(4, 11);
    if (i >= scuffs) continue;
    for (const side of [-0.8, 0.8]) {
      const pose = kit.transform(x + Math.cos(yaw) * side, 0.005, z - Math.sin(yaw) * side, yaw);
      kit.add(m.stain, patch, pose.multiply(new THREE.Matrix4().makeScale(0.34, 1, length)));
    }
  }
  patch.dispose();

  // Flattened cartons and loose boards.
  const scraps = Math.round(30 * kit.detail);
  for (let i = 0; i < 30; i++) {
    const inShed = kit.random() < 0.4;
    const x = inShed ? kit.range(-40, -19) : kit.range(-16, 40);
    const z = inShed ? kit.range(-22, 18) : kit.range(-42, 47);
    const yaw = kit.range(0, Math.PI);
    const board = kit.random() < 0.35;
    const width = board ? 0.1 : kit.range(0.4, 0.9);
    const length = board ? kit.range(0.8, 1.2) : kit.range(0.3, 0.7);
    if (i >= scraps) continue;
    if (board) kit.box(m.wood, width, 0.022, length, x, 0.004, z, { yaw });
    else kit.box(m.matte, width, 0.012, length, x, 0.004, z, { yaw, color: 0x8a6f4c });
  }
}
