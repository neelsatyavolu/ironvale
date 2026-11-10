import * as THREE from 'three/webgpu';
import type { Kit } from './kit';
import { logoGeometry, type Materials } from './materials';
import { SHIP, YARD } from './plan';

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Plan outline of the hull, bow to the west. Shape Y is world -Z. */
function hullOutline(grow: number): THREE.Shape {
  const near = -SHIP.near - grow;
  const far = -SHIP.far + grow;
  const centre = (near + far) / 2;
  const shoulder = SHIP.bow + 27;
  const shape = new THREE.Shape();
  shape.moveTo(SHIP.bow - grow, centre);
  shape.quadraticCurveTo(SHIP.bow + 9, near, shoulder, near);
  shape.lineTo(SHIP.stern + grow, near);
  shape.lineTo(SHIP.stern + grow, far);
  shape.lineTo(shoulder, far);
  shape.quadraticCurveTo(SHIP.bow + 9, far, SHIP.bow - grow, centre);
  return shape;
}

/** Vertical-sided slab of the hull outline between two heights. */
function hullBand(grow: number, bottom: number, top: number): THREE.BufferGeometry {
  const geometry = new THREE.ExtrudeGeometry(hullOutline(grow), { depth: top - bottom, bevelEnabled: false, curveSegments: 10 });
  return geometry.rotateX(-Math.PI / 2).translate(0, bottom, 0);
}

/**
 * Moored container ship beyond the quay edge: scenery only, so it has no
 * colliders. Hull with boot topping and bulwark, deckhouse with lit windows,
 * funnel, masts and mooring lines down to the quay bollards.
 */
export function buildShip(kit: Kit, m: Materials): void {
  const identity = new THREE.Matrix4();
  const bands: readonly [number, number, number, number][] = [
    [0, SHIP.waterline - 2, SHIP.deck + 1.1, 0x1c242b],
    [0.04, SHIP.waterline - 2, SHIP.waterline + 1.5, 0x5e2a22],
    [0.05, SHIP.deck + 0.75, SHIP.deck + 1.15, 0xaeb2ae],
  ];
  for (const [grow, bottom, top, color] of bands) {
    const band = hullBand(grow, bottom, top);
    kit.add(m.steel, band, identity, color);
    band.dispose();
  }

  // Name on the bow quarter facing the quay, and draught marks.
  const name = logoGeometry('SKERRYVORE', 13);
  kit.add(m.lettering, name, new THREE.Matrix4().makeTranslation(SHIP.bow + 38, SHIP.deck - 1.6, SHIP.near + 0.06), 0xd9d6cc);
  name.dispose();
  for (let i = 0; i < 9; i++) {
    kit.box(m.matte, 0.5, 0.12, 0.02, SHIP.bow + 29, SHIP.waterline + 2 + i * 0.6, SHIP.near + 0.03, { color: 0xd9d6cc });
  }
  // Hawse pipe and anchor.
  kit.box(m.steel, 1.4, 1.6, 0.3, SHIP.bow + 22, SHIP.deck - 3.6, SHIP.near + 0.4, { color: 0x101316 });
  kit.box(m.steel, 0.5, 2.6, 0.25, SHIP.bow + 22, SHIP.deck - 5.8, SHIP.near + 0.3, { color: 0x101316 });

  // Deckhouse aft: stepped white block, bridge with wings, funnel.
  const white = 0xc6c8c2;
  const houseX = SHIP.stern - 16;
  const midZ = (SHIP.near + SHIP.far) / 2;
  const beam = SHIP.near - SHIP.far;
  kit.box(m.steel, 16, 13, beam - 3, houseX, SHIP.deck, midZ, { color: white });
  kit.box(m.steel, 12, 3.2, beam + 3, houseX - 1, SHIP.deck + 13, midZ, { color: white });
  kit.box(m.steel, 6, 7, 6, houseX + 5, SHIP.deck + 13, midZ, { color: 0x20262b });
  kit.box(m.steel, 6.1, 1.2, 6.1, houseX + 5, SHIP.deck + 17.5, midZ, { color: 0xa3352a });
  kit.box(m.glass, 12.1, 1.3, beam + 3.1, houseX - 1, SHIP.deck + 14.4, midZ);
  for (let deck = 0; deck < 4; deck++) {
    for (let i = 0; i < 9; i++) {
      // Most cabins are dark; a few are lit.
      const lit = kit.random() < 0.3;
      const y = SHIP.deck + 1.6 + deck * 3;
      const z = SHIP.near - 1.48;
      if (lit) kit.box(m.lamp, 0.9, 0.7, 0.02, houseX - 6.4 + i * 1.6, y, z, { color: 0xffd28c });
      else kit.box(m.matte, 0.9, 0.7, 0.02, houseX - 6.4 + i * 1.6, y, z, { color: 0x10161a });
      kit.box(m.lamp, 0.02, 0.7, 0.9, houseX - 8.02, y, SHIP.near - 4 - i * 2.2, { color: lit ? 0xffd28c : 0x0c1013 });
    }
  }
  // Foremast and radar mast with navigation lights.
  kit.post(m.steel, 0.25, 14, SHIP.bow + 14, SHIP.deck + 1, midZ, white, 8);
  kit.box(m.lamp, 0.3, 0.3, 0.3, SHIP.bow + 14, SHIP.deck + 15, midZ, { color: 0xfff4e0 });
  kit.post(m.steel, 0.2, 7, houseX - 2, SHIP.deck + 16.2, midZ, white, 8);
  kit.box(m.lamp, 0.3, 0.3, 0.3, houseX - 2, SHIP.deck + 23.3, midZ, { color: 0xfff4e0 });
  kit.box(m.lamp, 0.25, 0.25, 0.25, houseX - 1, SHIP.deck + 15.2, SHIP.near + 1.3, { color: 0xff2a14 });
  // Deck crane pedestals between the cargo bays.
  for (const x of [SHIP.bow + 30, SHIP.bow + 58]) {
    kit.box(m.steel, 2.4, 9, 2.4, x, SHIP.deck, SHIP.near - 4, { color: 0xc79a1c });
    kit.beam(m.steel, V(x, SHIP.deck + 8.4, SHIP.near - 4), V(x + 14, SHIP.deck + 12, SHIP.near - 5), 0.9, 0.9, 0xc79a1c);
  }

  // Mooring lines to the quay bollards.
  const rope = 0x6f6857;
  const bollardZ = YARD.quay + 1.1;
  const lines: readonly [THREE.Vector3, THREE.Vector3][] = [
    [V(SHIP.bow + 7, SHIP.deck + 0.4, SHIP.near - 4), V(24, 0.5, bollardZ)],
    [V(SHIP.bow + 10, SHIP.deck + 0.4, SHIP.near - 2.4), V(36, 0.5, bollardZ)],
    [V(SHIP.bow + 12, SHIP.deck + 0.4, SHIP.near - 1.6), V(12, 0.5, bollardZ)],
  ];
  for (const [from, to] of lines) kit.beam(m.matte, from, to, 0.07, 0.07, rope);
}
