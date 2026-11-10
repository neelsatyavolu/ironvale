import * as THREE from 'three/webgpu';
import type { Kit } from './kit';
import type { Materials } from './materials';
import { YARD } from './plan';

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Rubber-tyred gantry straddling the container block. */
export const RTG = { west: -14.4, east: 19, north: 2, south: 10, girder: 16.8, trolleyX: 4 } as const;
/** Ship-to-shore crane on the quay. */
export const STS = { west: -24, east: -6, waterside: YARD.quay + 2.6, landside: YARD.quay + 13.4, portal: 10.5, top: 27 } as const;

/** Yard gantry: wheeled sills, four legs with hazard bands, twin girders, trolley, cab and a container on the spreader. */
export function buildYardGantry(kit: Kit, m: Materials): void {
  const yellow = 0xc79a1c;
  const midZ = (RTG.north + RTG.south) / 2;
  const tyre = new THREE.CylinderGeometry(0.72, 0.72, 0.46, 20).rotateZ(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.3, 0.3, 0.48, 12).rotateZ(Math.PI / 2);

  for (const x of [RTG.west, RTG.east]) {
    // Sill beam on two bogies of two tyres each.
    kit.box(m.steel, 0.95, 0.85, 10.6, x, 1.25, midZ, { color: yellow });
    for (const z of [RTG.north - 0.9, RTG.north + 0.9, RTG.south - 0.9, RTG.south + 0.9]) {
      kit.add(m.matte, tyre, new THREE.Matrix4().makeTranslation(x, 0.72, z), 0x141516);
      kit.add(m.steel, hub, new THREE.Matrix4().makeTranslation(x, 0.72, z), yellow);
    }
    for (const z of [RTG.north, RTG.south]) {
      kit.box(m.steel, 1.25, 0.2, 3.6, x, 1.46, z, { color: 0x2a2c2e });
      kit.box(m.steel, 0.85, RTG.girder - 2.1, 0.85, x, 2.1, z, { color: yellow });
      kit.box(m.hazard, 0.9, 2.2, 0.9, x, 2.1, z);
      kit.collide(0.9, RTG.girder, 0.9, x, 2, z, 'metal');
      // Knee brace up to the girder.
      const inward = x < 0 ? 1 : -1;
      kit.beam(m.steel, V(x, RTG.girder - 4, z), V(x + inward * 3.4, RTG.girder + 0.2, z), 0.4, 0.4, yellow);
    }
    kit.collide(1.5, 2.1, 11.6, x, 0, midZ, 'metal');
    // Cable reel and electrical cabinet on the sill.
    const reel = new THREE.CylinderGeometry(0.8, 0.8, 0.3, 20).rotateZ(Math.PI / 2);
    kit.add(m.steel, reel, new THREE.Matrix4().makeTranslation(x + (x < 0 ? 0.65 : -0.65), 2.95, midZ), 0x2a2c2e);
    reel.dispose();
    kit.box(m.steel, 0.7, 1.5, 1.4, x, 2.1, midZ + 2.2, { color: 0x9aa0a2 });
  }
  tyre.dispose();
  hub.dispose();

  // Twin box girders with end ties and a walkway rail.
  const span = RTG.east - RTG.west + 2.4;
  const midX = (RTG.west + RTG.east) / 2;
  for (const z of [RTG.north, RTG.south]) {
    kit.box(m.steel, span, 1.5, 0.9, midX, RTG.girder, z, { color: yellow });
    kit.box(m.steel, span, 0.05, 0.05, midX, RTG.girder + 2.5, z + (z === RTG.north ? -0.5 : 0.5), { color: 0x8c6f1a });
    for (let x = RTG.west - 1; x <= RTG.east + 1; x += 2.6) {
      kit.box(m.steel, 0.05, 1.0, 0.05, x, RTG.girder + 1.5, z + (z === RTG.north ? -0.5 : 0.5), { color: 0x8c6f1a });
    }
    for (let x = RTG.west + 3; x < RTG.east; x += 5.5) {
      kit.box(m.matte, 0.5, 0.14, 0.34, x, RTG.girder - 0.16, z, { color: 0x1d1f21 });
      kit.box(m.lamp, 0.42, 0.02, 0.26, x, RTG.girder - 0.18, z, { color: 0xfff0d2 });
    }
  }
  for (const x of [RTG.west - 0.9, RTG.east + 0.9]) kit.box(m.steel, 0.6, 1.2, RTG.south - RTG.north, x, RTG.girder + 0.1, midZ, { color: yellow });

  // Trolley, operator cab, hoist ropes and spreader. The container itself comes from the plan.
  const tx = RTG.trolleyX;
  kit.box(m.steel, 3.2, 0.7, RTG.south - RTG.north + 1.6, tx, RTG.girder + 1.5, midZ, { color: 0x3b4144 });
  kit.box(m.steel, 2.2, 1.3, 2.6, tx, RTG.girder + 2.2, midZ, { color: 0x9aa0a2 });
  kit.box(m.steel, 1.7, 2.1, 2.0, tx + 2.5, RTG.girder - 2.2, midZ - 2.6, { color: 0xb9bdbb });
  kit.box(m.glass, 1.72, 1.0, 1.7, tx + 2.5, RTG.girder - 1.9, midZ - 2.75);
  kit.box(m.lamp, 1.2, 0.03, 1.2, tx + 2.5, RTG.girder - 0.14, midZ - 2.6, { color: 0xffd9a0 });
  kit.beam(m.steel, V(tx + 2.5, RTG.girder - 0.1, midZ - 2.6), V(tx + 1.4, RTG.girder + 1.5, midZ - 2.2), 0.2, 0.2, 0x3b4144);
  const spreaderTop = 9.2 + 2.591 + 0.42;
  for (const dx of [-2.6, 2.6]) {
    for (const dz of [-1.0, 1.0]) {
      kit.box(m.rawSteel, 0.03, RTG.girder + 1.5 - spreaderTop, 0.03, tx + dx * 0.15, spreaderTop, midZ + dz * 2.6, { color: 0x2c2c2c });
    }
  }
  kit.box(m.steel, 2.5, 0.3, 6.2, tx, spreaderTop - 0.36, midZ, { color: yellow });
  kit.box(m.steel, 1.0, 0.5, 1.6, tx, spreaderTop - 0.1, midZ, { color: 0x3b4144 });
  for (const dz of [-3.0, 3.0]) kit.box(m.steel, 2.6, 0.14, 0.2, tx, spreaderTop - 0.42, midZ + dz, { color: 0x2a2c2e });
}

/** Quay crane: portal legs on bogies, sill and portal beams, boom out over the water, A-frame and machinery house. */
export function buildQuayCrane(kit: Kit, m: Materials): void {
  const paint = 0x35566e;
  const pale = 0xb4b8b6;
  const midX = (STS.west + STS.east) / 2;
  const midZ = (STS.waterside + STS.landside) / 2;
  const depth = STS.landside - STS.waterside;

  for (const x of [STS.west, STS.east]) {
    for (const z of [STS.waterside, STS.landside]) {
      kit.box(m.steel, 1.4, STS.top - 1.3, 1.4, x, 1.3, z, { color: paint });
      kit.box(m.hazard, 1.46, 2.4, 1.46, x, 1.3, z);
      kit.box(m.steel, 4.2, 0.9, 1.5, x, 0.4, z, { color: 0x2a2c2e });
      kit.box(m.hazard, 4.3, 0.5, 1.56, x, 0.7, z);
      kit.collide(4.3, 1.3, 1.6, x, 0, z, 'metal');
      kit.collide(1.5, STS.top, 1.5, x, 1.3, z, 'metal');
    }
    // Portal tie across the quay and the diagonal that stiffens each side frame.
    kit.box(m.steel, 1.1, 1.3, depth, x, STS.portal, midZ, { color: paint });
    kit.beam(m.steel, V(x, STS.portal + 1.3, STS.landside), V(x, STS.top - 0.5, STS.waterside), 0.7, 0.7, paint);
    kit.box(m.steel, 1.1, 1.4, depth, x, STS.top - 1.4, midZ, { color: paint });
  }
  for (const z of [STS.waterside, STS.landside]) {
    kit.box(m.steel, STS.east - STS.west, 1.4, 1.1, midX, STS.portal, z, { color: paint });
    kit.box(m.steel, STS.east - STS.west, 1.4, 1.1, midX, STS.top - 1.4, z, { color: paint });
  }
  // Access stair tower on the landside west leg, as a caged ladder.
  for (let y = 2; y < STS.top - 2; y += 0.45) kit.box(m.steel, 0.5, 0.03, 0.03, STS.west - 0.9, y, STS.landside + 0.4, { color: 0x8c6f1a });
  for (const dx of [-0.25, 0.25]) kit.box(m.steel, 0.04, STS.top - 4, 0.04, STS.west - 0.9 + dx, 2, STS.landside + 0.4, { color: 0x8c6f1a });

  // Boom: twin girders from the back reach out over the water, tied across.
  const boomY = STS.top;
  const back = STS.landside + 9;
  const tip = STS.waterside - 52;
  const boomLength = back - tip;
  const boomMid = (back + tip) / 2;
  for (const dx of [-2.6, 2.6]) {
    kit.box(m.steel, 0.9, 1.9, boomLength, midX + dx, boomY, boomMid, { color: paint });
    kit.box(m.steel, 0.05, 0.05, boomLength, midX + dx * 1.2, boomY + 3, boomMid, { color: 0x8c6f1a });
  }
  for (let z = tip + 1; z < back; z += 8.5) kit.box(m.steel, 5.2, 0.5, 0.5, midX, boomY + 0.2, z, { color: paint });

  // A-frame with fore and back stays.
  const apex = V(midX, boomY + 17, STS.waterside + 1.5);
  for (const dx of [-2.6, 2.6]) {
    const peak = apex.clone().setX(midX + dx * 0.4);
    kit.beam(m.steel, V(midX + dx, boomY + 1.9, STS.waterside), peak, 0.8, 0.8, paint);
    kit.beam(m.steel, V(midX + dx, boomY + 1.9, STS.landside), peak, 0.6, 0.6, paint);
    kit.beam(m.steel, peak, V(midX + dx, boomY + 1.9, tip + 9), 0.3, 0.3, paint);
    kit.beam(m.steel, peak, V(midX + dx, boomY + 1.9, tip + 30), 0.3, 0.3, paint);
    kit.beam(m.steel, peak, V(midX + dx, boomY + 1.9, back - 1), 0.3, 0.3, paint);
  }
  kit.box(m.steel, 3, 0.8, 1.2, midX, apex.y - 0.4, apex.z, { color: paint });
  kit.box(m.lamp, 0.25, 0.25, 0.25, midX, apex.y + 0.5, apex.z, { color: 0xff2a14 });
  kit.box(m.lamp, 0.25, 0.25, 0.25, midX, boomY + 2.1, tip + 0.5, { color: 0xff2a14 });

  // Machinery house on the back reach, trolley and cab under the boom.
  kit.box(m.cladding, 7.4, 4.4, 9, midX, boomY + 1.9, STS.landside + 3, { tile: 2, color: pale });
  kit.box(m.steel, 7.8, 0.2, 9.4, midX, boomY + 6.3, STS.landside + 3, { color: 0x6f7577 });
  for (const dz of [-2.5, 0, 2.5]) kit.box(m.lamp, 0.02, 0.5, 0.9, midX - 3.72, boomY + 4.2, STS.landside + 3 + dz, { color: 0xffe2b0 });
  kit.box(m.steel, 5.6, 0.8, 4, midX, boomY - 0.8, STS.waterside - 14, { color: 0x3b4144 });
  kit.box(m.steel, 2.2, 2.4, 2.6, midX + 1.2, boomY - 3.2, STS.waterside - 15.5, { color: pale });
  kit.box(m.lamp, 1.6, 0.9, 0.02, midX + 1.2, boomY - 2.4, STS.waterside - 16.82, { color: 0xffe2b0 });
  // Floodlights under the portal beam, washing the apron.
  for (const dx of [-5, 0, 5]) {
    kit.box(m.matte, 0.6, 0.2, 0.4, midX + dx, STS.portal - 0.22, STS.landside, { color: 0x1d1f21 });
    kit.box(m.lamp, 0.5, 0.02, 0.32, midX + dx, STS.portal - 0.24, STS.landside, { color: 0xfff0d2 });
  }
}
