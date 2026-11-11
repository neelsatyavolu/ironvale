import * as THREE from 'three/webgpu';
import { MeshBuilder } from './builder';
import type { Kit } from './kit';
import { logoGeometry, type LogoText, type Materials } from './materials';
import { addChamferBox, hose, rod } from './shapes';

const SKID = 0x1e2022;
const CANOPY = 0x3a6a4d;
const TRIM = 0x17191b;
const CABINET = 0x6d7774;
const CABINET_DARK = 0x3d4543;
const CHROME = 0xc9cdd0;
const CABLE = 0x0c0c0d;
const STRIP = 0xfff0c8;
const PLINTH_TILE = 2.71;

function place(kit: Kit, material: THREE.Material, builder: MeshBuilder, at: THREE.Matrix4, color?: number): void {
  if (builder.empty) return;
  const geometry = builder.build();
  kit.add(material, geometry, at, color);
  geometry.dispose();
}

/** Stencilled text on the face of something at `at`; local position, facing local +Z turned by `turn`. */
function label(kit: Kit, m: Materials, at: THREE.Matrix4, text: LogoText, width: number, local: readonly [number, number, number], turn: number, ink: number): void {
  const geometry = logoGeometry(text, width);
  kit.add(m.lettering, geometry, at.clone().multiply(new THREE.Matrix4().makeRotationY(turn).setPosition(...local)), ink);
  geometry.dispose();
}

/**
 * Skid-mounted diesel generator in a weather canopy: fork pockets in the skid,
 * louvred radiator end, door seams and handles, a control panel with a lit
 * status strip, exhaust with a rain cap, lifting eye and filler. Long axis on
 * local X; the control panel faces local +Z.
 */
export function buildGenerator(kit: Kit, m: Materials, x: number, z: number, yaw: number): void {
  const paint = new MeshBuilder();
  const dark = new MeshBuilder();
  const bare = new MeshBuilder();
  const at = kit.transform(x, 0, z, yaw);

  // Skid with fork pockets, then the canopy with a drip rail round the roof.
  for (const sz of [-1, 1]) paint.box(2.5, 0.16, 0.12, 0, 0.08, sz * 0.515, SKID);
  for (const sx of [-1.19, -0.45, 0.45, 1.19]) paint.box(0.12, 0.16, 0.92, sx, 0.08, 0, SKID);
  for (const sx of [-0.45, 0.45]) dark.box(0.34, 0.1, 1.16, sx, 0.08, 0, 0x050505);
  addChamferBox(paint, [2.3, 1.2, 1.05], [0, 0.78, 0], CANOPY, 0.05);
  addChamferBox(paint, [2.38, 0.05, 1.13], [0, 1.4, 0], 0x2c5440, 0.02);

  // Radiator end: a framed grille of angled slats. Opposite end: air intake slots.
  dark.box(0.02, 0.86, 0.84, -1.156, 0.8, 0, 0x08090a);
  for (let i = 0; i < 10; i++) paint.box(0.05, 0.012, 0.84, -1.17, 0.42 + i * 0.086, 0, 0x24282a, [0, 0, 0.5]);
  for (const sz of [-0.44, 0.44]) paint.box(0.05, 0.92, 0.04, -1.17, 0.8, sz, CANOPY);
  for (const sy of [0.35, 1.25]) paint.box(0.05, 0.04, 0.92, -1.17, sy, 0, CANOPY);
  for (let i = 0; i < 6; i++) dark.box(0.012, 0.02, 0.6, 1.153, 0.5 + i * 0.07, 0, 0x08090a);

  // Both long sides: door seams, hinges and recessed handles.
  for (const sz of [-1, 1]) {
    for (const sx of [-0.62, 0.1]) dark.box(0.012, 1.02, 0.008, sx, 0.78, sz * 0.527, 0x0c0d0e);
    dark.box(1.5, 0.012, 0.008, -0.26, 1.29, sz * 0.527, 0x0c0d0e);
    dark.box(1.5, 0.012, 0.008, -0.26, 0.27, sz * 0.527, 0x0c0d0e);
    for (const sx of [-0.55, 0.03]) {
      dark.box(0.12, 0.05, 0.012, sx, 0.8, sz * 0.53, TRIM);
      for (const sy of [0.45, 1.1]) bare.box(0.03, 0.09, 0.02, sx - 0.5 + 0.44, sy, sz * 0.532, 0x6b7072);
    }
  }
  // Control panel behind a window on the +Z side, with its lit strip and three status lamps.
  dark.box(0.62, 0.46, 0.012, 0.72, 0.9, 0.53, TRIM);
  dark.box(0.2, 0.14, 0.014, 0.6, 0.98, 0.532, 0x1f2a24);
  for (const sx of [0.84, 0.92]) rod(dark, [sx, 0.84, 0.53], [sx, 0.84, 0.552], 0.022, 0x2a2c2e, 8);
  dark.box(0.07, 0.07, 0.03, 0.6, 0.78, 0.54, 0x7a1512);

  // Exhaust stack with a flap, lifting eye, fuel filler and the earth stake lead.
  rod(bare, [0.82, 1.4, -0.26], [0.82, 1.92, -0.26], 0.05, 0x3b3835, 10);
  bare.box(0.14, 0.012, 0.14, 0.84, 1.95, -0.26, 0x3b3835, [0, 0, 0.5]);
  const eye = new THREE.TorusGeometry(0.07, 0.016, 6, 12);
  bare.add(eye, new THREE.Matrix4().makeTranslation(0, 1.49, 0), 0x6b7072);
  eye.dispose();
  rod(dark, [-0.7, 1.42, 0.3], [-0.7, 1.47, 0.3], 0.05, TRIM, 10);

  place(kit, m.steel, paint, at);
  place(kit, m.matte, dark, at);
  place(kit, m.rawSteel, bare, at);

  const local = (lx: number, ly: number, lz: number): THREE.Matrix4 => at.clone().multiply(new THREE.Matrix4().makeTranslation(lx, ly, lz));
  const strip = new THREE.BoxGeometry(0.5, 0.035, 0.01);
  kit.add(m.lamp, strip, local(0.72, 1.09, 0.537), STRIP);
  strip.dispose();
  const led = new THREE.BoxGeometry(0.03, 0.03, 0.01);
  [0x35ff5a, 0x35ff5a, 0xffa01a].forEach((color, i) => kit.add(m.lamp, led, local(0.76 + i * 0.07, 0.98, 0.537), color));
  led.dispose();
  const warning = new THREE.BoxGeometry(0.16, 0.16, 0.008);
  kit.add(m.hazard, warning, local(-0.9, 1.05, 0.531));
  warning.dispose();
  label(kit, m, at, 'DANGER', 0.5, [-0.26, 1.12, 0.532], 0, 0xe6e3da);
  label(kit, m, at, 'FUEL', 0.34, [-0.72, 1.12, -0.532], Math.PI, 0xe6e3da);

  kit.collide(2.5, 1.42, 1.15, x, 0, z, 'metal', yaw);
}

/**
 * Relay cabinet on a concrete plinth: double doors with louvred vents, a lit
 * strip under the rain cap, status lamps, a warning plate and a short whip
 * aerial. The doors face local +Z.
 */
export function buildRelay(kit: Kit, m: Materials, x: number, z: number, yaw: number, name: LogoText): void {
  const paint = new MeshBuilder();
  const dark = new MeshBuilder();
  const bare = new MeshBuilder();
  const at = kit.transform(x, 0, z, yaw);

  kit.box(m.wall, 1.06, 0.12, 0.62, x, 0, z, { yaw, tile: PLINTH_TILE });
  addChamferBox(paint, [0.92, 1.5, 0.5], [0, 0.87, 0], CABINET, 0.03);
  addChamferBox(paint, [1.04, 0.07, 0.62], [0, 1.655, 0], CABINET_DARK, 0.025);
  // Recess for the strip, door seam, vents, hinges and handles.
  dark.box(0.82, 0.09, 0.012, 0, 1.55, 0.251, 0x08090a);
  dark.box(0.012, 1.34, 0.008, 0, 0.8, 0.252, 0x0c0d0e);
  for (const sx of [-1, 1]) {
    for (const base of [0.3, 0.95]) {
      dark.box(0.32, 0.36, 0.008, sx * 0.23, base + 0.18, 0.252, 0x0e0f10);
      for (let i = 0; i < 6; i++) paint.box(0.32, 0.01, 0.03, sx * 0.23, base + 0.04 + i * 0.058, 0.262, CABINET_DARK, [0.6, 0, 0]);
    }
    bare.box(0.025, 0.16, 0.03, sx * 0.045, 0.86, 0.268, CHROME);
    for (const sy of [0.3, 0.86, 1.4]) bare.box(0.02, 0.07, 0.02, sx * 0.452, sy, 0.256, 0x6b7072);
    // Conduits down the sides into the plinth.
    rod(bare, [sx * 0.49, 0.12, -0.12], [sx * 0.49, 1.2, -0.12], 0.02, 0x8f9394, 6);
  }
  // Back: a bolted cover plate and the gland box the cables leave through.
  dark.box(0.7, 1.1, 0.008, 0, 0.9, -0.252, 0x2d3432);
  paint.box(0.3, 0.22, 0.09, 0, 0.3, -0.29, CABINET_DARK);
  for (const sx of [-0.31, 0.31]) {
    for (const sy of [0.42, 0.9, 1.38]) bare.box(0.025, 0.025, 0.012, sx, sy, -0.258, 0x8f9394);
  }
  rod(bare, [0.34, 1.69, -0.14], [0.34, 2.5, -0.14], 0.008, 0x2a2c2e, 5);
  rod(dark, [0.34, 1.69, -0.14], [0.34, 1.78, -0.14], 0.024, 0x17191b, 8);

  place(kit, m.steel, paint, at);
  place(kit, m.matte, dark, at);
  place(kit, m.rawSteel, bare, at);

  const local = (lx: number, ly: number, lz: number): THREE.Matrix4 => at.clone().multiply(new THREE.Matrix4().makeTranslation(lx, ly, lz));
  const cells = new THREE.BoxGeometry(0.12, 0.055, 0.01);
  for (let i = 0; i < 6; i++) kit.add(m.lamp, cells, local(-0.335 + i * 0.134, 1.55, 0.258), STRIP);
  cells.dispose();
  const led = new THREE.BoxGeometry(0.025, 0.025, 0.01);
  [0x35ff5a, 0xffa01a].forEach((color, i) => kit.add(m.lamp, led, local(-0.36 + i * 0.06, 1.42, 0.256), color));
  led.dispose();
  const warning = new THREE.BoxGeometry(0.15, 0.15, 0.006);
  kit.add(m.hazard, warning, local(-0.23, 0.82, 0.256).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 4)));
  warning.dispose();
  label(kit, m, at, name, 0.4, [0.23, 0.82, 0.257], 0, 0xd6a41a);
  label(kit, m, at, 'HIGH VOLTAGE', 0.4, [0.23, 0.74, 0.257], 0, 0xe6e3da);

  kit.collide(0.96, 1.7, 0.56, x, 0, z, 'metal', yaw);
}

/** Power cable lying on the ground through `points` ([x, z] pairs). No collider. */
export function groundCable(kit: Kit, m: Materials, points: readonly (readonly [number, number])[], radius = 0.022): void {
  const geometry = hose(points.map(([px, pz]) => [px, radius * 0.9, pz] as const), radius);
  kit.add(m.matte, geometry, new THREE.Matrix4(), CABLE);
  geometry.dispose();
}

/** A few turns of spare cable dropped in a loose coil, with a tail leading off toward (tx, tz). */
export function cableCoil(kit: Kit, m: Materials, x: number, z: number, radius: number, tx: number, tz: number): void {
  const ring = new THREE.TorusGeometry(radius, 0.02, 5, 22).rotateX(Math.PI / 2);
  for (let i = 0; i < 3; i++) {
    const squash = new THREE.Matrix4().makeScale(1 - i * 0.07, 1, 0.86 + i * 0.05);
    kit.add(m.matte, ring, kit.transform(x + i * 0.035, 0.02 + i * 0.036, z - i * 0.02, i * 0.7).multiply(squash), CABLE);
  }
  ring.dispose();
  const toward = Math.atan2(tz - z, tx - x);
  const side = toward + Math.PI / 2;
  groundCable(kit, m, [
    [x + Math.cos(toward) * radius, z + Math.sin(toward) * radius],
    [x + (tx - x) * 0.4 + Math.cos(side) * 0.35, z + (tz - z) * 0.4 + Math.sin(side) * 0.35],
    [x + (tx - x) * 0.75 - Math.cos(side) * 0.25, z + (tz - z) * 0.75 - Math.sin(side) * 0.25],
    [tx, tz],
  ]);
}

/**
 * Tarpaulin thrown over a load `width` x `height` x `depth` standing at
 * (x, z): flat on top, hanging down the sides in folds and stopping short of
 * the ground. No collider; the load under it has one.
 */
export function buildTarp(kit: Kit, m: Materials, x: number, z: number, width: number, height: number, depth: number, yaw: number, color: number): void {
  const skirt = height - 0.14;
  const cells = 22;
  const geometry = new THREE.PlaneGeometry(1, 1, cells, cells);
  const position = geometry.getAttribute('position');
  const halfW = width / 2 + 0.03;
  const halfD = depth / 2 + 0.03;
  for (let i = 0; i < position.count; i++) {
    const s = position.getX(i) * 2 * (halfW + skirt);
    const t = position.getY(i) * 2 * (halfD + skirt);
    const overX = Math.max(Math.abs(s) - halfW, 0);
    const overZ = Math.max(Math.abs(t) - halfD, 0);
    const drop = Math.min(Math.hypot(overX, overZ) * 1.08, skirt + Math.sin(i * 12.9898) * 0.05);
    // Folds: the cloth bulges in and out as it hangs, more the further it has dropped.
    const fold = Math.sin(s * 9.1 + t * 2.3) * Math.sin(t * 8.3 - s * 1.7) * 0.05 * Math.min(drop * 3, 1);
    const px = Math.sign(s) * (Math.min(Math.abs(s), halfW) + (overX > 0 ? 0.03 + fold : 0));
    const pz = Math.sign(t) * (Math.min(Math.abs(t), halfD) + (overZ > 0 ? 0.03 + fold : 0));
    const sag = overX === 0 && overZ === 0 ? Math.sin(s * 3.3) * Math.sin(t * 2.9) * 0.012 : 0;
    position.setXYZ(i, px, height + 0.02 + sag - drop, -pz);
  }
  geometry.computeVertexNormals();
  kit.add(m.matte, geometry, kit.transform(x, 0, z, yaw), color);
  geometry.dispose();
  // Two ratchet straps over the top.
  for (const offset of [-width * 0.25, width * 0.25]) {
    const strap = hose(
      [
        [offset, 0.2, halfD + 0.07],
        [offset, height + 0.035, halfD + 0.02],
        [offset, height + 0.04, 0],
        [offset, height + 0.035, -halfD - 0.02],
        [offset, 0.2, -halfD - 0.07],
      ],
      0.016,
      4,
    );
    kit.add(m.matte, strap, kit.transform(x, 0, z, yaw), 0xb9861a);
    strap.dispose();
  }
}
