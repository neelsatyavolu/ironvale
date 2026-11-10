import * as THREE from 'three/webgpu';
import type { Kit, Vec3 } from './kit';
import { SHED, type Heightfield } from './layout';
import type { PinewoodMaterials } from './materials';
import { stoneGeometry } from './rocks';

/** Local position of the lantern under the shed's front beam. */
export const SHED_LAMP: Vec3 = [1.2, 1.95, 1.0];
/** Local position of the fire's glow. */
export const FIRE_GLOW: Vec3 = [0, 0.35, 0];

/**
 * Stack of round firewood, ends facing +Z. `width` runs along X from the
 * origin; rows are packed like a honeycomb.
 */
function firewood(
  kit: Kit,
  m: PinewoodMaterials,
  random: () => number,
  origin: Vec3,
  width: number,
  height: number,
  length: number,
  bothEnds = false,
): void {
  const [ox, oy, oz] = origin;
  const pitch = 0.2;
  const rows = Math.round(height / (pitch * 0.87));
  const columns = Math.floor(width / pitch);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns - (row % 2); column++) {
      // The top row is uneven.
      if (row === rows - 1 && random() < 0.35) continue;
      const radius = 0.078 + random() * 0.022;
      const x = ox + pitch / 2 + column * pitch + (row % 2) * (pitch / 2);
      const y = oy + pitch / 2 + row * pitch * 0.87;
      const shift = (random() - 0.5) * 0.08;
      kit.pole(m.bark, [x, y, oz - length / 2 + shift], [x, y, oz + length / 2 + shift], radius, 9);
      for (const end of bothEnds ? [1, -1] : [1]) {
        const cap = new THREE.CircleGeometry(radius * 0.97, 9);
        if (end < 0) cap.rotateY(Math.PI);
        kit.geo(m.cutWood, cap, new THREE.Matrix4().makeTranslation(x, y, oz + shift + end * (length / 2 + 0.004)));
      }
    }
  }
  kit.collider([width, rows * pitch * 0.87, length], [ox + width / 2, oy + (rows * pitch * 0.87) / 2, oz], 'wood');
}

/** Open-fronted lean-to with the winter's firewood stacked along the back. Opens to +Z. */
export function buildShed(kit: Kit, m: PinewoodMaterials, random: () => number): { readonly room: THREE.Box3 } {
  const hx = SHED.width / 2;
  const hz = SHED.depth / 2;
  const front = 2.35;
  const back = 1.95;
  for (const x of [-hx + 0.08, hx - 0.08]) {
    kit.box(m.planksDark, [0.13, front, 0.13], [x, front / 2, hz - 0.08], { surface: 'wood' });
    kit.box(m.planksDark, [0.13, back, 0.13], [x, back / 2, -hz + 0.08], { surface: 'wood' });
    kit.box(m.planks, [0.04, 1.75, SHED.depth - 0.3], [x, 0.95, 0], { surface: 'wood', tile: 1.5 });
  }
  kit.box(m.planks, [SHED.width - 0.2, 1.8, 0.04], [0, 0.95, -hz + 0.06], { surface: 'wood', tile: 1.5 });
  kit.box(m.planksDark, [SHED.width, 0.14, 0.1], [0, front - 0.02, hz - 0.08]);
  kit.box(m.planksDark, [SHED.width, 0.12, 0.1], [0, back - 0.02, -hz + 0.08]);
  const pitch = Math.atan((front - back) / SHED.depth);
  kit.box(m.roof, [SHED.width + 0.6, 0.05, SHED.depth + 0.7], [0, (front + back) / 2 + 0.1, 0], {
    rot: [-pitch, 0, 0],
    surface: 'wood',
    tile: 1.6,
  });
  firewood(kit, m, random, [-hx + 0.25, 0.04, -hz + 0.42], SHED.width - 0.5, 1.3, 0.45);

  // Lantern on a hook under the front beam.
  const [lx, ly, lz] = SHED_LAMP;
  kit.pole(m.iron, [lx, front - 0.08, lz], [lx, ly + 0.13, lz], 0.005, 4);
  kit.box(m.iron, [0.12, 0.03, 0.12], [lx, ly + 0.12, lz]);
  kit.box(m.iron, [0.12, 0.03, 0.12], [lx, ly - 0.1, lz]);
  kit.box(m.lampGlow, [0.08, 0.19, 0.08], [lx, ly + 0.01, lz]);
  return { room: new THREE.Box3(new THREE.Vector3(-hx, 0, -hz), new THREE.Vector3(hx, front, hz)) };
}

/** Long outdoor stack of metre logs between four stakes. Chest-high cover. Runs along X, centred. */
export function buildWoodpile(kit: Kit, m: PinewoodMaterials, random: () => number, width: number): void {
  firewood(kit, m, random, [-width / 2, 0.03, 0], width, 1.25, 1.0, true);
  for (const x of [-width / 2 - 0.05, width / 2 + 0.05]) {
    for (const z of [-0.3, 0.3]) kit.pole(m.bark, [x, -0.2, z], [x + (x > 0 ? 0.06 : -0.06), 1.45, z], 0.04, 6);
  }
}

/** Sawn stump with a root flare. */
export function buildStump(kit: Kit, m: PinewoodMaterials, radius: number, height: number): void {
  const profile = [
    [radius * 1.6, -0.35],
    [radius * 1.4, 0],
    [radius * 1.1, 0.14],
    [radius, 0.32],
    [radius * 0.97, height],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const stump = new THREE.LatheGeometry(profile, 10);
  const uv = stump.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 0.5);
  kit.geo(m.barkMossy, stump, new THREE.Matrix4(), 'wood');
  const top = new THREE.CircleGeometry(radius * 0.97, 10);
  top.rotateX(-Math.PI / 2);
  kit.geo(m.cutWood, top, new THREE.Matrix4().makeTranslation(0, height, 0), 'wood');
}

/** Chopping block with an axe left in it and split wood around. */
export function buildChoppingBlock(kit: Kit, m: PinewoodMaterials): void {
  buildStump(kit, m, 0.3, 0.52);
  kit.beam(m.planks, [0.02, 0.56, 0.02], [0.42, 1.12, -0.18], 0.03, 0.045);
  kit.box(m.iron, [0.035, 0.2, 0.1], [0.03, 0.58, 0.02], { rot: [0.3, 0, -0.62] });
  kit.pole(m.cutWood, [0.55, 0.07, 0.4], [0.95, 0.07, 0.25], 0.07, 5);
  kit.pole(m.cutWood, [-0.6, 0.06, 0.1], [-0.5, 0.06, 0.55], 0.06, 5);
  kit.pole(m.bark, [0.2, 0.08, -0.65], [0.7, 0.08, -0.55], 0.08, 6);
}

/** Ring of stones around a fire that has burned down to embers, with two log seats. */
export function buildFirePit(kit: Kit, m: PinewoodMaterials, random: () => number): void {
  const stone = stoneGeometry(random, 401);
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  for (let i = 0; i < 11; i++) {
    const angle = (i / 11) * Math.PI * 2 + (random() - 0.5) * 0.2;
    const s = 0.13 + random() * 0.07;
    euler.set(random() * 3, random() * 6, random() * 3);
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(angle) * 0.62, s * 0.45, Math.sin(angle) * 0.62),
      quat.setFromEuler(euler),
      new THREE.Vector3(s * 1.2, s * 0.8, s),
    );
    kit.geo(m.rock, stone.clone(), local);
  }
  stone.dispose();
  kit.collider([1.4, 0.3, 1.4], [0, 0.15, 0], 'concrete');
  const ash = new THREE.SphereGeometry(0.5, 12, 6);
  ash.scale(1, 0.14, 1);
  kit.geo(m.char, ash, new THREE.Matrix4().makeTranslation(0, 0.01, 0));
  kit.pole(m.char, [-0.38, 0.1, -0.1], [0.36, 0.17, 0.12], 0.06, 6);
  kit.pole(m.char, [0.1, 0.09, -0.4], [-0.08, 0.2, 0.36], 0.055, 6);
  kit.pole(m.char, [0.3, 0.1, -0.28], [-0.25, 0.14, 0.2], 0.045, 6);
  for (const [x, y, z, s] of [
    [0.05, 0.1, 0.02, 0.09],
    [-0.14, 0.09, 0.1, 0.06],
    [0.16, 0.1, -0.1, 0.07],
    [-0.02, 0.12, -0.16, 0.05],
  ] as const) {
    kit.box(m.ember, [s, s * 0.6, s], [x, y, z], { rot: [0.4, x * 9, 0.3] });
  }
  // Seats.
  kit.pole(m.barkMossy, [-1.0, 0.2, 1.35], [0.9, 0.2, 1.5], 0.22, 9, 'wood');
  kit.pole(m.barkMossy, [1.55, 0.19, -0.9], [1.45, 0.19, 0.8], 0.2, 9, 'wood');
}

/** Low dry-stone wall running along +X from the origin: chest-high cover with a ragged top. */
export function buildStoneWall(kit: Kit, m: PinewoodMaterials, random: () => number, length: number, tumbled: 'start' | 'end' | 'none' = 'end'): void {
  const stone = stoneGeometry(random, 433);
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  let x = 0;
  while (x < length - 0.3) {
    const piece = Math.min(length - x, 0.8 + random() * 0.6);
    const t = (x + piece / 2) / length;
    const ruin = tumbled === 'end' ? Math.max(0, t - 0.7) / 0.3 : tumbled === 'start' ? Math.max(0, 0.3 - t) / 0.3 : 0;
    const height = (1.0 + random() * 0.22) * (1 - ruin * 0.7);
    kit.box(m.stone, [piece + 0.03, height + 0.3, 0.52 + random() * 0.08], [x + piece / 2, (height + 0.3) / 2 - 0.3, (random() - 0.5) * 0.06], {
      rot: [0, (random() - 0.5) * 0.05, 0],
      surface: 'concrete',
      tile: 2,
    });
    // Loose capstones break the straight top edge.
    for (let i = 0; i < 2; i++) {
      if (random() < 0.3) continue;
      const s = 0.14 + random() * 0.1;
      euler.set(random() * 0.6, random() * 6, random() * 0.6);
      const local = new THREE.Matrix4().compose(
        new THREE.Vector3(x + piece * (0.25 + i * 0.5) + (random() - 0.5) * 0.2, height + s * 0.25, (random() - 0.5) * 0.25),
        quat.setFromEuler(euler),
        new THREE.Vector3(s * 1.5, s * 0.75, s * 1.2),
      );
      kit.geo(m.rock, stone.clone(), local);
    }
    x += piece;
  }
  // Fallen stones lie around the tumbled end.
  const pile = tumbled === 'end' ? length : tumbled === 'start' ? 0 : -1;
  for (let i = 0; pile >= 0 && i < 9; i++) {
    const s = 0.12 + random() * 0.12;
    euler.set(random() * 3, random() * 6, random() * 3);
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(pile + (random() - 0.5) * 2.2, s * 0.4, (random() - 0.5) * 2),
      quat.setFromEuler(euler),
      new THREE.Vector3(s * 1.4, s * 0.8, s * 1.1),
    );
    kit.geo(m.rock, stone.clone(), local);
  }
  stone.dispose();
}

/**
 * Fallen trunk lying on the terrain between two points, with a few snapped
 * branch stubs. `kit` must be in world space.
 */
export function buildLog(kit: Kit, m: PinewoodMaterials, field: Heightfield, random: () => number, from: readonly [number, number], to: readonly [number, number], radius: number): void {
  const a: Vec3 = [from[0], field.sample(from[0], from[1]) + radius * 0.72, from[1]];
  const b: Vec3 = [to[0], field.sample(to[0], to[1]) + radius * 0.6, to[1]];
  kit.pole(m.barkMossy, a, b, radius, 10, 'wood', radius * 0.78);
  const stubs = 2 + Math.floor(random() * 3);
  for (let i = 0; i < stubs; i++) {
    const t = 0.2 + random() * 0.7;
    const base: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + radius * 0.5, a[2] + (b[2] - a[2]) * t];
    const reach = 0.3 + random() * 0.6;
    kit.pole(m.bark, base, [base[0] + (random() - 0.5) * reach, base[1] + reach, base[2] + (random() - 0.5) * reach], 0.045, 5, undefined, 0.012);
  }
}

/**
 * Odds and ends around the cabin, in the cabin's local frame: a ladder against
 * the south eaves, a sawhorse with a log on it, a bench by the door and a
 * couple of crates under the north window.
 */
export function buildYardProps(kit: Kit, m: PinewoodMaterials): void {
  // Ladder leaning on the south wall.
  for (const x of [1.9, 2.35]) kit.beam(m.planks, [x, 0, 3.75], [x, 2.75, 2.82], 0.05, 0.07);
  for (let i = 1; i <= 8; i++) {
    const t = i / 9;
    kit.beam(m.planksDark, [1.88, 2.75 * t, 3.75 - 0.93 * t], [2.37, 2.75 * t, 3.75 - 0.93 * t], 0.03, 0.045);
  }
  kit.collider([0.6, 2.7, 0.2], [2.12, 1.35, 3.3], 'wood', [0.33, 0, 0]);

  // Sawhorse east of the door with a half-cut log.
  for (const z of [-3.9, -2.9]) {
    kit.beam(m.planksDark, [6.35, 0, z], [6.75, 0.8, z], 0.06, 0.06);
    kit.beam(m.planksDark, [7.15, 0, z], [6.75, 0.8, z], 0.06, 0.06);
  }
  kit.box(m.planksDark, [0.09, 0.09, 1.3], [6.75, 0.78, -3.4]);
  kit.pole(m.bark, [6.75, 0.93, -4.2], [6.75, 0.93, -2.5], 0.1, 8, undefined, 0.09);
  kit.collider([0.9, 1.0, 1.7], [6.75, 0.5, -3.4], 'wood');

  // Bench against the east wall, north of the door.
  kit.box(m.planks, [0.34, 0.05, 1.5], [3.95, 0.45, -1.7], { tile: 1.3 });
  for (const z of [-2.35, -1.05]) kit.box(m.planksDark, [0.3, 0.44, 0.06], [3.95, 0.22, z]);
  kit.collider([0.36, 0.48, 1.5], [3.95, 0.24, -1.7], 'wood');

  // Crates under the north window.
  kit.box(m.planks, [0.75, 0.55, 0.6], [1.5, 0.275, -3.15], { rot: [0, 0.12, 0], surface: 'wood', tile: 1.1 });
  kit.box(m.planksDark, [0.55, 0.45, 0.5], [0.72, 0.225, -3.1], { rot: [0, -0.2, 0], surface: 'wood', tile: 0.9 });
}
