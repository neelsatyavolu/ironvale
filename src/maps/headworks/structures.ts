import * as THREE from 'three/webgpu';
import { downpipe, ladder, louvre, outlet, steelDoor, stencil, streak, STAIN } from './fittings';
import { faceOf, type Face, type Side } from './frame';
import { V, type Kit } from './kit';
import { wallLamp } from './lighting';
import { COAT, type Materials } from './materials';
import { handrail, pipeRun, placeValve } from './parts';
import { BLOCKS, HALF_Z, isTwin, TANK, type Block } from './plan';

const byId = (id: string): Block => {
  const found = BLOCKS.find((b) => b.id === id);
  if (!found) throw new Error(`Headworks plan has no block "${id}"`);
  return found;
};
/** The west piece and its east twin, with the side names turned to match. */
const pair = (id: string): readonly (readonly [Block, (side: Side) => Side])[] => {
  const flip: Readonly<Record<Side, Side>> = { n: 's', s: 'n', e: 'w', w: 'e' };
  return [
    [byId(id), (side) => side],
    [byId(`${id}-east`), (side) => flip[side]],
  ];
};

/** Band of windows behind concrete fins, with a sill and a head that throw their own shadow lines. */
function windowBand(kit: Kit, m: Materials, face: Face, y: number, height: number, margin: number): void {
  const width = face.width - margin * 2;
  kit.cast(m.glass, width, height, 0.04, face.at(0, y + height / 2, 0.004), 0.004);
  kit.cast(m.concrete, width + 0.5, 0.14, 0.34, face.at(0, y - 0.07, 0.15), 0.03, 0xe9e6de);
  kit.cast(m.concrete, width + 0.5, 0.18, 0.4, face.at(0, y + height + 0.09, 0.18), 0.03, 0xe9e6de);
  const fins = Math.round(width / 1.25);
  for (let i = 0; i <= fins; i++) {
    const u = -width / 2 + (i / fins) * width;
    kit.cast(m.concrete, 0.13, height, 0.32, face.at(u, y + height / 2, 0.15), 0.025, 0xf1eee7);
  }
  // Dirt washed off the sill, heavier under each fin.
  for (let i = 0; i < fins; i += 2) streak(kit, m, face, -width / 2 + ((i + kit.range(0.2, 0.8)) / fins) * width, y - 0.14, kit.range(0.3, 0.7), kit.range(0.9, 2.2), STAIN.damp);
}

/** Roof plant for the skyline: two air handlers, flues and a mast. */
function roofPlant(kit: Kit, m: Materials, b: Block): void {
  const top = b.y + b.h;
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const s = isTwin(b) ? -1 : 1;
  for (const dz of [-5.5, 3]) {
    const unit: Block = { ...b, x0: cx - 1.3, x1: cx + 1.3, z0: cz + s * dz - 1.6, z1: cz + s * dz + 1.6, y: top + 0.15, h: 1.5 };
    kit.slab(m.galvanised, unit.x0, unit.x1, unit.y, unit.y + unit.h, unit.z0, unit.z1, 0.04);
    kit.slab(m.concrete, unit.x0 - 0.1, unit.x1 + 0.1, top, top + 0.15, unit.z0 - 0.1, unit.z1 + 0.1, 0.03, 0xd9d6ce);
    for (const side of ['e', 'w'] as const) louvre(kit, m, faceOf(unit, side), 0, 0.8, 2.2, 0.9, 0x9aa1a4);
  }
  for (const dz of [-1.4, -0.6, 7]) kit.tube(m.stainless, V(cx + 1.6, top, cz + s * dz), V(cx + 1.6, top + 2.1, cz + s * dz), 0.1, undefined, 10);
  kit.tube(m.galvanised, V(cx - 2, top, cz + s * 8.5), V(cx - 2, top + 5.5, cz + s * 8.5), 0.04, undefined, 6);
  kit.slab(m.concrete, b.x0 - 0.06, b.x1 + 0.06, top, top + 0.3, b.z0 - 0.06, b.z0 + 0.24, 0.03, 0xe6e3db);
  kit.slab(m.concrete, b.x0 - 0.06, b.x1 + 0.06, top, top + 0.3, b.z1 - 0.24, b.z1 + 0.06, 0.03, 0xe6e3db);
  kit.slab(m.concrete, b.x0 - 0.06, b.x0 + 0.24, top, top + 0.3, b.z0, b.z1, 0.03, 0xe6e3db);
  kit.slab(m.concrete, b.x1 - 0.24, b.x1 + 0.06, top, top + 0.3, b.z0, b.z1, 0.03, 0xe6e3db);
}

/** Control building, store and pipe gallery: windows, doors, signs, rainwater pipes and roof plant. */
export function dressBuildings(kit: Kit, m: Materials): void {
  for (const [b, turn] of pair('control')) {
    const court = faceOf(b, turn('e'));
    const yard = faceOf(b, turn('w'));
    windowBand(kit, m, court, 3.9, 1.3, 1.4);
    windowBand(kit, m, yard, 3.9, 1.3, 1.4);
    steelDoor(kit, m, court, -6, 'CONTROL');
    kit.cast(m.concrete, 1.9, 0.14, 0.9, court.at(-6, 2.72, 0.45), 0.03, 0xe9e6de);
    wallLamp(kit, m, court.point(-6.9, 2.3, 0).x, 2.3, court.point(-6.9, 2.3, 0).z, court.normal.x, court.normal.z);
    stencil(kit, m, court, 'HEADWORKS', 3.5, 2.3, 6.4);
    steelDoor(kit, m, yard, 4);
    for (const u of [-9.4, 9.4]) downpipe(kit, m, court, u, b.h - 0.2);
    for (const u of [-9.4, 0.6, 9.4]) downpipe(kit, m, yard, u, b.h - 0.2);
    for (const side of ['n', 's'] as const) {
      const end = faceOf(b, side);
      louvre(kit, m, end, 0, 4.6, 2.6, 1.1, 0x9aa1a4);
      streak(kit, m, end, 0.3, 4, 1.6, 2.6, STAIN.damp);
    }
    roofPlant(kit, m, b);
  }
  for (const [b, turn] of pair('store')) {
    const road = faceOf(b, turn('n'));
    const court = faceOf(b, turn('s'));
    // Roller shutter to the road.
    kit.cast(m.paint, 3.5, 3.2, 0.1, road.at(2, 1.6, 0.0), 0.02, COAT.black);
    louvre(kit, m, road, 2, 1.58, 3.2, 3.0, COAT.tealDark);
    kit.cast(m.hazard, 0.16, 3.1, 0.06, road.at(0.25, 1.55, 0.03), 0.01);
    kit.cast(m.hazard, 0.16, 3.1, 0.06, road.at(3.75, 1.55, 0.03), 0.01);
    steelDoor(kit, m, court, -2.5);
    wallLamp(kit, m, court.point(-3.4, 2.4, 0).x, 2.4, court.point(-3.4, 2.4, 0).z, court.normal.x, court.normal.z);
    downpipe(kit, m, court, 4.6, b.h - 0.15);
    downpipe(kit, m, road, -4.9, b.h - 0.15);
    stencil(kit, m, road, 'FILTER WALK', -2.6, 2.9, 3.6);
  }
  for (const [b, turn] of pair('gallery')) {
    const court = faceOf(b, turn('s'));
    const road = faceOf(b, turn('n'));
    for (const face of [court, road]) {
      for (let u = -6.9; u <= 7; u += 4.6) louvre(kit, m, face, u, 3.35, 2.6, 0.8, 0x9aa1a4);
      for (let u = -4.6; u <= 5; u += 4.6) streak(kit, m, face, u + kit.range(-1, 1), b.h, kit.range(0.5, 1.2), kit.range(1.2, 3), STAIN.damp);
    }
    steelDoor(kit, m, court, 5.2);
    steelDoor(kit, m, road, -5.2);
    stencil(kit, m, court, 'VALVE COURT', -4, 2.2, 3.6);
    for (const u of [-8.6, 8.6]) outlet(kit, m, court, u, 0.7, 0.16);
    outlet(kit, m, road, 2.5, 0.9, 0.2);
    // Two mains leave through the roof, run along it on saddles and cross to the clarifier rim.
    const s = isTwin(b) ? -1 : 1;
    const top = b.h;
    const cz = (b.z0 + b.z1) / 2;
    const tankX = s * TANK.x;
    const rim = s * (TANK.z - TANK.radius + 0.6);
    [0.34, 0.24].forEach((r, i) => {
      const z = cz + s * (i === 0 ? -0.9 : 0.5);
      const y = top + 0.3 + r;
      const cross = tankX + s * (i === 0 ? -2.4 : 2.2);
      const far = b.x0 + b.x1 - (isTwin(b) ? b.x0 + 0.8 : b.x1 - 0.8);
      pipeRun(kit, m.paint, [V(far, top, z), V(far, y, z), V(cross, y, z), V(cross, y, rim), V(cross, TANK.height - 0.4, rim)], r, i === 0 ? COAT.teal : COAT.tealDark, 3.2, COAT.tealDark);
      for (let x = Math.min(far, cross) + 1.5; x < Math.max(far, cross); x += 3) kit.slab(m.concrete, x - 0.14, x + 0.14, top, top + 0.3, z - r - 0.12, z + r + 0.12, 0.03, 0xd9d6ce);
      placeValve(kit, m.paint, m.paint, V((far + cross) / 2 + i, y, z), r, 0, V(0, 1, 0), COAT.blue, i === 0 ? COAT.yellow : COAT.red);
    });
  }
}

/** Rim kerbs, water, cross walls and a handrail on top of a basin. */
function basinTop(kit: Kit, m: Materials, b: Block, cells: number, railSides: readonly Side[]): void {
  const top = b.h;
  const rim = 0.32;
  const kerb = (x0: number, x1: number, z0: number, z1: number): void => kit.slab(m.concrete, x0, x1, top, top + 0.22, z0, z1, 0.04, 0xdfddd6);
  kerb(b.x0, b.x1, b.z0, b.z0 + rim);
  kerb(b.x0, b.x1, b.z1 - rim, b.z1);
  const alongX = b.x1 - b.x0 > b.z1 - b.z0;
  for (let i = 0; i <= cells; i++) {
    if (alongX) {
      const x = b.x0 + ((b.x1 - b.x0 - rim) * i) / cells;
      kerb(x, x + rim, b.z0 + rim, b.z1 - rim);
    } else {
      const z = b.z0 + rim + ((b.z1 - b.z0 - rim * 3) * i) / cells;
      kerb(b.x0, b.x0 + rim, z, z + rim);
      kerb(b.x1 - rim, b.x1, z, z + rim);
    }
  }
  if (!alongX) {
    kerb(b.x0, b.x0 + rim, b.z0, b.z1);
    kerb(b.x1 - rim, b.x1, b.z0, b.z1);
  }
  const water = new THREE.PlaneGeometry(b.x1 - b.x0 - rim * 2, b.z1 - b.z0 - rim * 2).rotateX(-Math.PI / 2);
  kit.add(m.water, water, new THREE.Matrix4().makeTranslation((b.x0 + b.x1) / 2, top + 0.06, (b.z0 + b.z1) / 2));
  water.dispose();
  for (const side of railSides) {
    const face = faceOf(b, side);
    handrail(kit, m.galvanised, face.point(-face.width / 2 + 0.1, top + 0.22, -0.14), face.point(face.width / 2 - 0.1, top + 0.22, -0.14));
  }
}

/** Filter beds, the two walls that stagger each road, and the terraces: outlets, weirs, ladders and their stains. */
export function dressWaterworks(kit: Kit, m: Materials): void {
  for (const [b, turn] of pair('beds')) {
    const road = faceOf(b, turn('s'));
    basinTop(kit, m, b, 4, [turn('s')]);
    for (let i = 0; i < 4; i++) {
      const u = -road.width / 2 + ((i + 0.5) / 4) * road.width;
      outlet(kit, m, road, u + 1.6, 0.55, 0.13);
      placeValve(kit, m.paint, m.paint, road.point(u + 1.6, 0.55, 0.12), 0.13, 2, V(0, 1, 0), COAT.blue, i % 2 === 0 ? COAT.red : COAT.yellow);
      // Overflow weir notch near the top, with the scale it has left.
      kit.cast(m.concrete, 0.5, 0.16, 0.2, road.at(u - 1.4, b.h - 0.25, 0.08), 0.03, 0xd6d4cd);
      streak(kit, m, road, u - 1.4, b.h - 0.32, kit.range(0.5, 0.9), kit.range(1.2, 1.9), i % 2 === 0 ? STAIN.scale : STAIN.algae);
      streak(kit, m, road, u - 1.4 + kit.range(-0.1, 0.1), b.h - 0.32, 0.22, kit.range(0.7, 1.2), STAIN.scale, 0.016);
    }
    ladder(kit, m, road, road.width / 2 - 1.2, 0, b.h);
  }
  for (const id of ['stagger-a', 'stagger-b']) {
    for (const [b, turn] of pair(id)) {
      const open = id === 'stagger-a' ? turn('s') : turn('n');
      basinTop(kit, m, b, 1, [turn('e'), turn('w'), open]);
      for (const side of [turn('e'), turn('w')]) {
        const face = faceOf(b, side);
        stencil(kit, m, face, id === 'stagger-a' ? 'WASHWATER' : 'RAW WATER', 0, 2.3, Math.min(3.6, face.width - 1));
        outlet(kit, m, face, face.width / 2 - 1.1, 0.6, 0.15);
        for (let k = 0; k < 3; k++) streak(kit, m, face, kit.range(-face.width / 2 + 0.5, face.width / 2 - 0.5), b.h, kit.range(0.3, 1), kit.range(1, 2.6), k === 0 ? STAIN.scale : STAIN.damp);
      }
      ladder(kit, m, faceOf(b, open), 0.8, 0, b.h);
    }
  }
  for (const [b, turn] of pair('deck')) {
    // The terrace's face to its court: two culvert mouths under the parapet and the mess below them.
    const front = faceOf(b, turn('n'));
    for (const u of [-3.4, 2.6]) {
      outlet(kit, m, front, u, 1.2, 0.26);
      streak(kit, m, front, u + 0.2, 0.95, 1.3, 0.95, STAIN.rust, 0.02);
    }
    for (const u of [-5.2, -0.6, 4.8]) {
      kit.tube(m.galvanised, front.point(u, b.h - 0.12, -0.05), front.point(u, b.h - 0.12, 0.14), 0.04, undefined, 8);
      streak(kit, m, front, u, b.h - 0.16, kit.range(0.3, 0.5), kit.range(1.2, 2.1), STAIN.damp);
    }
    stencil(kit, m, front, 'NO ENTRY', 0, 2.05, 2.2, 0x7a2a22);
  }
}

/** Security topping on the perimeter wall: cranked posts and three strands of wire. */
export function dressPerimeter(kit: Kit, m: Materials): void {
  for (const b of BLOCKS.filter((piece) => piece.role === 'perimeter')) {
    const alongX = b.x1 - b.x0 > b.z1 - b.z0;
    const top = b.h + 0.12;
    const inward = alongX ? (b.z0 < 0 ? 1 : -1) : b.x0 < 0 ? 1 : -1;
    const centre = alongX ? (b.z0 + b.z1) / 2 : (b.x0 + b.x1) / 2;
    const [from, to] = alongX ? [b.x0 + 0.4, b.x1 - 0.4] : [b.z0 + 0.4, b.z1 - 0.4];
    const at = (t: number, y: number, lean: number): THREE.Vector3 => (alongX ? V(t, y, centre + inward * lean) : V(centre + inward * lean, y, t));
    const count = Math.round((to - from) / 3);
    for (let i = 0; i <= count; i++) {
      const t = from + ((to - from) * i) / count;
      kit.tube(m.galvanised, at(t, top, 0), at(t, top + 0.45, 0), 0.02, undefined, 5);
      kit.tube(m.galvanised, at(t, top + 0.45, 0), at(t, top + 0.75, 0.28), 0.02, undefined, 5);
    }
    for (const [y, lean] of [
      [0.5, 0.05],
      [0.62, 0.16],
      [0.75, 0.28],
    ] as const) {
      kit.tube(m.galvanised, at(from, top + y, lean), at(to, top + y, lean), 0.006, undefined, 4);
    }
    // Weep pipes through the wall, each with its streak, and a painted number every bay.
    const face = faceOf(b, alongX ? (inward > 0 ? 's' : 'n') : inward > 0 ? 'e' : 'w');
    const weeps = Math.round(face.width / 9);
    for (let i = 0; i < weeps; i++) {
      const u = -face.width / 2 + ((i + kit.range(0.3, 0.7)) / weeps) * face.width;
      if (Math.abs(face.point(u, 0, 0).z) > HALF_Z - 1 && Math.abs(face.point(u, 0, 0).x) < 34) continue;
      kit.tube(m.galvanised, face.point(u, 2.9, -0.02), face.point(u, 2.88, 0.08), 0.03, undefined, 6);
      streak(kit, m, face, u, 2.86, kit.range(0.25, 0.5), kit.range(1.3, 2.6), i % 3 === 0 ? STAIN.rust : STAIN.algae);
    }
  }
  // Doors of the walled yards open onto the lanes; the yard walls carry a lamp and a sign.
  for (const [b] of pair('yard-n')) wallLamp(kit, m, b.x1 - 0.5, 2.5, isTwin(b) ? b.z0 : b.z1, 0, isTwin(b) ? -1 : 1);
  for (const [b] of pair('yard-s')) wallLamp(kit, m, b.x1 - 0.5, 2.5, isTwin(b) ? b.z1 : b.z0, 0, isTwin(b) ? 1 : -1);
}
