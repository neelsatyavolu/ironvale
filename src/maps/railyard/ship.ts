import * as THREE from 'three/webgpu';
import type { Kit } from './kit';
import { logoGeometry, type Materials } from './materials';
import { SHIP, YARD } from './plan';

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

const RUST_RED = new THREE.Color(0x5e2a22);
const HULL_GREY = new THREE.Color(0x1c242b);
const BULWARK = new THREE.Color(0xaeb2ae);
const OUTLINE_STEPS = 22;

/**
 * Plan outline of the hull, bow to the west. Shape Y is world -Z. `rake` pulls
 * the stem aft and fines the entry, which is the shape at the waterline; the
 * deck outline has none.
 */
function hullOutline(rake: number): THREE.Shape {
  const near = -SHIP.near;
  const far = -SHIP.far;
  const centre = (near + far) / 2;
  const bow = SHIP.bow + rake;
  const shoulder = SHIP.bow + 15 + rake * 2.8;
  const shape = new THREE.Shape();
  shape.moveTo(bow, centre);
  shape.quadraticCurveTo(bow + 4 + rake * 0.9, near, shoulder, near);
  shape.lineTo(SHIP.stern, near);
  shape.lineTo(SHIP.stern, far);
  shape.lineTo(shoulder, far);
  shape.quadraticCurveTo(bow + 4 + rake * 0.9, far, bow, centre);
  return shape;
}

/**
 * Hull shell lofted from a fine, raked waterline up to the full deck outline,
 * so the bow flares and the stem leans forward. Rows are split at the boot
 * topping and the bulwark so each band has its own colour with a hard edge.
 */
function hullShell(): THREE.BufferGeometry {
  const bottom = SHIP.waterline - 2;
  const top = SHIP.deck + 1.1;
  const boot = SHIP.waterline + 1.5;
  const bulwark = SHIP.deck + 0.75;
  const low = hullOutline(6.5).getPoints(OUTLINE_STEPS);
  const high = hullOutline(0).getPoints(OUTLINE_STEPS);
  const heights = [bottom, boot, (boot + bulwark) * 0.42, (boot + bulwark) * 0.7, bulwark, top];
  const rows = heights.map((y) => {
    // Most of the flare is in the upper half of the side.
    const t = ((y - bottom) / (top - bottom)) ** 1.8;
    return low.map((point, i) => {
      const upper = high[i] as THREE.Vector2;
      return new THREE.Vector3(point.x + (upper.x - point.x) * t, y, -(point.y + (upper.y - point.y) * t));
    });
  });
  const colors = [RUST_RED, HULL_GREY, HULL_GREY, HULL_GREY, BULWARK];
  const position: number[] = [];
  const normal: number[] = [];
  const color: number[] = [];
  const uv: number[] = [];
  const count = low.length;
  const at = (row: number, i: number): THREE.Vector3 => (rows[row] as THREE.Vector3[])[(i + count) % count] as THREE.Vector3;
  const normalAt = (row: number, i: number): THREE.Vector3 => {
    const along = at(row, i + 1).clone().sub(at(row, i - 1));
    const up = at(Math.min(row + 1, rows.length - 1), i).clone().sub(at(Math.max(row - 1, 0), i));
    return up.cross(along).normalize();
  };
  for (let row = 0; row < rows.length - 1; row++) {
    const tint = colors[row] as THREE.Color;
    for (let i = 0; i < count - 1; i++) {
      const corners: readonly (readonly [number, number])[] = [[row, i], [row + 1, i + 1], [row, i + 1], [row, i], [row + 1, i], [row + 1, i + 1]];
      for (const [r, c] of corners) {
        const p = at(r, c);
        const n = normalAt(r, c);
        position.push(p.x, p.y, p.z);
        normal.push(n.x, n.y, n.z);
        color.push(tint.r, tint.g, tint.b);
        uv.push(0, 0);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geometry;
}

/**
 * Moored container ship beyond the quay edge: scenery only, so it has no
 * colliders. Flared hull with boot topping, bulwark and guard rail, deckhouse with lit windows,
 * funnel, masts and mooring lines down to the quay bollards.
 */
export function buildShip(kit: Kit, m: Materials): void {
  const identity = new THREE.Matrix4();
  const shell = hullShell();
  kit.add(m.steel, shell, identity);
  shell.dispose();
  const deck = new THREE.ShapeGeometry(hullOutline(0), OUTLINE_STEPS).rotateX(-Math.PI / 2).translate(0, SHIP.deck + 0.75, 0);
  kit.add(m.steel, deck, identity, 0x4a2f28);
  deck.dispose();

  // Guard rail along the near side and round the bow: stanchions and two wires.
  const edge = hullOutline(0).getPoints(OUTLINE_STEPS).map((point) => V(point.x, SHIP.deck + 1.1, -point.y)).filter((point) => point.x < 70 && point.z > (SHIP.near + SHIP.far) / 2 - 2);
  const railing: THREE.Vector3[] = [];
  for (let i = 0; i < edge.length - 1; i++) {
    const from = edge[i] as THREE.Vector3;
    const to = edge[i + 1] as THREE.Vector3;
    const steps = Math.max(1, Math.round(from.distanceTo(to) / 2.2));
    for (let step = 0; step < steps; step++) railing.push(from.clone().lerp(to, step / steps));
  }
  railing.forEach((post, i) => {
    kit.post(m.steel, 0.04, 1.0, post.x, post.y, post.z, 0xaeb2ae, 6);
    const next = railing[i + 1];
    if (!next) return;
    for (const lift of [0.5, 0.98]) kit.beam(m.steel, V(post.x, post.y + lift, post.z), V(next.x, next.y + lift, next.z), 0.035, 0.035, 0xaeb2ae);
  });

  // Name on the bow quarter facing the quay, and draught marks.
  const name = logoGeometry('SKERRYVORE', 13);
  kit.add(m.lettering, name, new THREE.Matrix4().makeTranslation(SHIP.bow + 38, SHIP.deck - 1.6, SHIP.near + 0.06), 0xd9d6cc);
  name.dispose();
  for (let i = 0; i < 9; i++) {
    kit.box(m.matte, 0.5, 0.12, 0.02, SHIP.bow + 41, SHIP.waterline + 2 + i * 0.6, SHIP.near + 0.03, { color: 0xd9d6cc });
  }
  // Hawse pipe with its rust-stained anchor housed in it, and a rubbing strake along the side.
  const hawse = new THREE.TorusGeometry(0.62, 0.16, 8, 16);
  kit.add(m.steel, hawse, new THREE.Matrix4().makeTranslation(SHIP.bow + 28, SHIP.deck - 2.4, SHIP.near + 0.12), 0x101316);
  hawse.dispose();
  const anchorAt = V(SHIP.bow + 28, SHIP.deck - 3.2, SHIP.near + 0.3);
  kit.box(m.steel, 0.3, 2.4, 0.22, anchorAt.x, anchorAt.y - 1.6, anchorAt.z, { color: 0x3a2018 });
  for (const side of [-1, 1]) {
    kit.beam(m.steel, V(anchorAt.x, anchorAt.y - 1.6, anchorAt.z), V(anchorAt.x + side * 1.0, anchorAt.y - 0.5, anchorAt.z + 0.05), 0.26, 0.2, 0x3a2018);
  }
  kit.box(m.steel, 1.1, 0.3, 0.3, anchorAt.x, anchorAt.y - 1.75, anchorAt.z, { color: 0x3a2018 });
  kit.box(m.steel, SHIP.stern - SHIP.bow - 30, 0.22, 0.14, (SHIP.stern + SHIP.bow + 30) / 2, SHIP.deck - 0.6, SHIP.near + 0.05, { color: 0x10161a });

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
  const guard = new THREE.CylinderGeometry(0.34, 0.34, 0.02, 14);
  for (const [from, to] of lines) {
    // Each line hangs in a shallow curve and carries a rat guard near the ship.
    let previous = from;
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      const point = from.clone().lerp(to, t);
      point.y -= 1.6 * 4 * t * (1 - t);
      kit.beam(m.matte, previous, point, 0.07, 0.07, rope);
      if (i === 3) {
        const turn = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), point.clone().sub(previous).normalize());
        kit.add(m.steel, guard, new THREE.Matrix4().compose(point, turn, V(1, 1, 1)), 0x8f9394);
      }
      previous = point;
    }
  }
  guard.dispose();
}
