import * as THREE from 'three/webgpu';
import { signGeometry, type SignText } from './decals';
import { V, type Kit } from './kit';
import { COAT, TILE_FORMED, type Materials } from './materials';
import { handrail, pipeRun, placeValve } from './parts';
import { BRIDGE, DRUMS, isTwin, type Drum } from './plan';

const SEGMENTS = 72;
const ALGAE = 0x2a2d24;
const SCALE = 0xdcddd4;
const RUST = 0x5e3b22;

/**
 * One straight run of a turned profile, from (r0, y0) to (r1, y1). Each run
 * is its own surface so the corners between runs stay sharp, and its UVs are
 * in metres so the concrete keeps its scale all the way round.
 */
function ring(kit: Kit, material: THREE.Material, x: number, z: number, r0: number, y0: number, r1: number, y1: number, color?: number): void {
  const geometry = new THREE.LatheGeometry([new THREE.Vector2(r0, y0), new THREE.Vector2(r1, y1)], SEGMENTS);
  const uv = geometry.getAttribute('uv');
  const around = Math.round((Math.PI * (r0 + r1)) / TILE_FORMED);
  const length = Math.hypot(r1 - r0, y1 - y0);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * around, (y0 + uv.getY(i) * length) / TILE_FORMED);
  kit.add(material, geometry, new THREE.Matrix4().makeTranslation(x, 0, z), color);
  geometry.dispose();
}

/** Upright decal against a round wall at `angle`, `width` across and hanging `drop` below `top`. */
function wallStreak(kit: Kit, m: Materials, d: Drum, angle: number, radius: number, top: number, width: number, drop: number, color: number): void {
  const geometry = new THREE.PlaneGeometry(width, drop);
  const out = V(Math.sin(angle), 0, Math.cos(angle));
  const matrix = new THREE.Matrix4()
    .makeRotationY(angle)
    .setPosition(d.x + out.x * (radius + 0.02), top - drop / 2, d.z + out.z * (radius + 0.02));
  kit.add(m.runOff, geometry, matrix, color);
  geometry.dispose();
}

/**
 * Clarifier: a round concrete tank with stiffening ribs, a corbelled walkway
 * at the rim, overflow spouts that have stained the wall below them and a
 * handrail all the way round.
 */
function buildClarifier(kit: Kit, m: Materials, d: Drum, name: SignText): void {
  const { x, z, r, h } = d;
  const tone = isTwin(d) ? 0xf2efe8 : 0xffffff;
  const round = m.concreteRound;
  ring(kit, round, x, z, r, 0, r, h - 0.9, tone);
  ring(kit, round, x, z, r, h - 0.9, r + 0.2, h - 0.7, tone);
  ring(kit, round, x, z, r + 0.2, h - 0.7, r + 0.2, h - 0.05, tone);
  ring(kit, round, x, z, r + 0.2, h - 0.05, r + 0.15, h, tone);
  ring(kit, round, x, z, r + 0.15, h, r - 0.45, h, tone);
  ring(kit, round, x, z, r - 0.45, h, r - 0.5, h - 0.05, tone);
  ring(kit, round, x, z, r - 0.5, h - 0.05, r - 0.5, h - 1.3, tone);
  const water = new THREE.CircleGeometry(r - 0.5, 48);
  water.rotateX(-Math.PI / 2);
  kit.add(m.water, water, new THREE.Matrix4().makeTranslation(x, h - 0.7, z));
  water.dispose();

  // Ribs, and a sign plate on the two that face the courts.
  const ribs = 18;
  const turn = isTwin(d) ? Math.PI : 0;
  for (let i = 0; i < ribs; i++) {
    const angle = turn + ((i + 0.5) / ribs) * Math.PI * 2;
    const out = V(Math.sin(angle), 0, Math.cos(angle));
    const matrix = new THREE.Matrix4().makeRotationY(angle).setPosition(x + out.x * (r + 0.04), (h - 0.9) / 2, z + out.z * (r + 0.04));
    kit.cast(m.concrete, 0.55, h - 0.9, 0.3, matrix, 0.05, isTwin(d) ? 0xe9e6de : 0xf3f3f0);
    if (i % 6 === 2) {
      const sign = signGeometry(name, 1.5);
      kit.add(m.sign, sign, new THREE.Matrix4().makeRotationY(angle).setPosition(x + out.x * (r + 0.2), 2.5, z + out.z * (r + 0.2)));
      sign.dispose();
    }
  }

  // Overflow spouts: where water has run for years the wall is black with growth, edged with pale scale.
  const spouts = 7;
  for (let i = 0; i < spouts; i++) {
    const angle = turn + ((i + kit.range(0.2, 0.8)) / spouts) * Math.PI * 2;
    const out = V(Math.sin(angle), 0, Math.cos(angle));
    const top = h - 1.05;
    const spout = new THREE.Matrix4().makeRotationY(angle).setPosition(x + out.x * (r + 0.1), top, z + out.z * (r + 0.1));
    kit.cast(m.concrete, 0.34, 0.2, 0.36, spout, 0.03, 0xd8d6cf);
    const drop = kit.range(2.2, 3.5);
    wallStreak(kit, m, d, angle, r, top - 0.08, kit.range(0.7, 1.2), drop, ALGAE);
    wallStreak(kit, m, d, angle + kit.range(-0.03, 0.03), r + 0.004, top - 0.08, kit.range(0.25, 0.45), drop * kit.range(0.5, 0.8), SCALE);
  }
  // Rust weeping from the handrail fixings and the corbel's drip edge.
  const weeps = Math.round(16 * (0.4 + kit.detail * 0.6));
  for (let i = 0; i < weeps; i++) {
    const angle = kit.range(0, Math.PI * 2);
    wallStreak(kit, m, d, angle, r + 0.2, h - 0.1, kit.range(0.12, 0.3), kit.range(0.4, 0.62), RUST);
    wallStreak(kit, m, d, angle + 0.01, r, h - 0.92, kit.range(0.2, 0.5), kit.range(0.8, 2), i % 3 === 0 ? SCALE : ALGAE);
  }

  // Handrail on the rim: posts with two rails bent to the curve.
  const posts = 44;
  const rimRadius = r + 0.08;
  for (let i = 0; i < posts; i++) {
    const angle = (i / posts) * Math.PI * 2;
    const px = x + Math.sin(angle) * rimRadius;
    const pz = z + Math.cos(angle) * rimRadius;
    kit.tube(m.galvanised, V(px, h, pz), V(px, h + 1.1, pz), 0.022, undefined, 6);
  }
  for (const [lift, tube] of [
    [1.1, 0.022],
    [0.57, 0.018],
  ] as const) {
    const rail = new THREE.TorusGeometry(rimRadius, tube, 6, 96);
    rail.rotateX(Math.PI / 2);
    kit.add(m.galvanised, rail, new THREE.Matrix4().makeTranslation(x, h + lift, z));
    rail.dispose();
  }
}

/**
 * Service bridge between the two clarifiers: two deep edge girders under a
 * deck, solid parapets, pipes and a cable tray slung between the girders, and
 * a scraper drive on each end over the middle of its tank.
 */
function buildBridge(kit: Kit, m: Materials): void {
  const frame = new THREE.Matrix4().makeRotationY(BRIDGE.yaw);
  const place = (x: number, y: number, z: number): THREE.Matrix4 => frame.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z));
  const point = (x: number, y: number, z: number): THREE.Vector3 => V(x, y, z).applyMatrix4(frame);
  const length = BRIDGE.length + 3;
  const half = BRIDGE.width / 2;
  const deck = BRIDGE.underside + 1.8;
  for (const s of [-1, 1]) {
    kit.cast(m.concrete, length, 1.8, 0.5, place(0, BRIDGE.underside + 0.9, s * (half - 0.25)), 0.06, 0xf1efe9);
    kit.cast(m.concrete, length, BRIDGE.depth - 2.1, 0.2, place(0, deck + 0.3 + (BRIDGE.depth - 2.1) / 2, s * (half - 0.1)), 0.04, 0xe9e7e0);
  }
  kit.cast(m.concrete, length, 0.3, BRIDGE.width, place(0, deck + 0.15, 0), 0.04, 0xe2e0da);
  for (let x = -length / 2 + 1.5; x < length / 2; x += 3.6) kit.cast(m.concrete, 0.3, 1.3, BRIDGE.width - 1, place(x, deck - 0.65, 0), 0.04, 0xdedcd5);

  // Services under the deck.
  for (const [z, r] of [
    [-0.42, 0.15],
    [0.1, 0.11],
  ] as const) {
    pipeRun(kit, m.stainless, [point(-length / 2, deck - 0.75, z), point(length / 2, deck - 0.75, z)], r, undefined, 3.4);
  }
  kit.beam(m.galvanised, point(-length / 2, deck - 0.4, 0.55), point(length / 2, deck - 0.4, 0.55), 0.3, 0.05);
  for (const z of [0.42, 0.48, 0.55, 0.63]) kit.tube(m.matte, point(-length / 2, deck - 0.36, z), point(length / 2, deck - 0.36, z), 0.016, COAT.black, 5);

  // Deck drains through the girders, each with its stain, and bulkhead lamps under the span.
  const drains = 9;
  for (let i = 0; i < drains; i++) {
    const x = -length / 2 + ((i + 0.5) / drains) * length + kit.range(-0.5, 0.5);
    const s = i % 2 === 0 ? 1 : -1;
    kit.tube(m.galvanised, point(x, deck - 0.1, s * (half - 0.05)), point(x, deck - 0.1, s * (half + 0.16)), 0.035, undefined, 8);
    const streak = new THREE.PlaneGeometry(kit.range(0.3, 0.6), 1.5);
    const facing = new THREE.Matrix4().makeRotationY(s > 0 ? 0 : Math.PI);
    kit.add(m.runOff, streak, place(x, deck - 0.9, s * (half + 0.012)).multiply(facing), i % 3 === 0 ? SCALE : ALGAE);
    streak.dispose();
  }
  for (const x of [-2.2, 2.2]) {
    kit.cast(m.paint, 0.5, 0.1, 0.22, place(x, deck - 0.08, 0), 0.02, COAT.black);
    kit.add(m.lamp, new THREE.BoxGeometry(0.42, 0.03, 0.16), place(x, deck - 0.14, 0), 0xfff1d8);
  }

  // Scraper drives: gearbox drum, motor and a small cabinet at each end.
  for (const s of [-1, 1]) {
    const end = s * (BRIDGE.length / 2);
    const drum = new THREE.CylinderGeometry(0.75, 0.85, 1.1, 20);
    kit.add(m.paint, drum, place(end, deck + 0.3 + 0.55, 0), COAT.teal);
    drum.dispose();
    const motor = new THREE.CylinderGeometry(0.28, 0.28, 0.9, 14);
    kit.add(m.paint, motor, place(end, deck + 0.3 + 1.55, 0), COAT.tealDark);
    motor.dispose();
    kit.cast(m.paint, 0.5, 1.1, 0.35, place(end - s * 1.3, deck + 0.85, 0.7), 0.02, COAT.grey);
    kit.add(m.lamp, new THREE.BoxGeometry(0.05, 0.05, 0.02), place(end - s * 1.3, deck + 1.2, 0.885), 0x58ff7a);
  }
  for (const s of [-1, 1]) {
    handrail(kit, m.galvanised, point(-length / 2, BRIDGE.underside + BRIDGE.depth, s * (half - 0.1)), point(length / 2, BRIDGE.underside + BRIDGE.depth, s * (half - 0.1)), 0.5);
  }
}

/** Chemical storage tank on a plinth, with a ladder, bands, a dished head and an outlet valve. */
function buildSilo(kit: Kit, m: Materials, d: Drum, index: number): void {
  const { x, z, r, h } = d;
  const facing = isTwin(d) ? Math.PI : 0;
  ring(kit, m.concreteRound, x, z, r, 0, r, 0.26, 0xdedbd2);
  ring(kit, m.concreteRound, x, z, r, 0.26, r - 0.06, 0.3, 0xdedbd2);
  const body = new THREE.CylinderGeometry(r - 0.1, r - 0.1, h - 0.9, 28, 1, true);
  kit.add(m.paint, body, new THREE.Matrix4().makeTranslation(x, 0.3 + (h - 0.9) / 2, z), index % 2 === 0 ? COAT.cream : 0xb9c2c1);
  body.dispose();
  const head = new THREE.SphereGeometry(r - 0.1, 28, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  kit.add(m.paint, head, new THREE.Matrix4().makeScale(1, 0.42, 1).setPosition(x, h - 0.6, z), COAT.cream);
  head.dispose();
  for (const y of [0.9, 2, 3.1]) {
    const band = new THREE.TorusGeometry(r - 0.085, 0.03, 5, 40);
    band.rotateX(Math.PI / 2);
    kit.add(m.galvanised, band, new THREE.Matrix4().makeTranslation(x, y, z));
    band.dispose();
  }
  const manway = new THREE.CylinderGeometry(0.32, 0.32, 0.14, 14);
  kit.add(m.galvanised, manway, new THREE.Matrix4().makeTranslation(x + 0.4, h - 0.12, z));
  manway.dispose();
  // Ladder up the side that faces the yard, and the outlet beside it.
  const side = Math.cos(facing);
  const lz = z - side * (r - 0.04);
  for (const s of [-0.22, 0.22]) kit.tube(m.galvanised, V(x + s, 0.3, lz), V(x + s, h - 0.3, lz), 0.018, undefined, 6);
  for (let y = 0.6; y < h - 0.4; y += 0.3) kit.tube(m.galvanised, V(x - 0.22, y, lz), V(x + 0.22, y, lz), 0.012, undefined, 5);
  const out = z - side * (r + 0.02);
  pipeRun(kit, m.stainless, [V(x + 0.8, 0.75, out + side * 0.3), V(x + 0.8, 0.75, out - side * 0.5), V(x + 0.8, 0.02, out - side * 0.5)], 0.06, undefined, 9);
  placeValve(kit, m.paint, m.paint, V(x + 0.8, 0.75, out - side * 0.16), 0.06, 2, V(0, 1, 0), COAT.blue, COAT.red);
  const plate = signGeometry(index % 2 === 0 ? 'RAW WATER' : 'WASHWATER', 0.9);
  kit.add(m.sign, plate, new THREE.Matrix4().makeRotationY(side > 0 ? Math.PI : 0).setPosition(x - 0.75, 1.9, z - side * (r - 0.09) * 0.86));
  plate.dispose();
}

export function buildTanks(kit: Kit, m: Materials): void {
  let silo = 0;
  for (const d of DRUMS) {
    if (d.role === 'clarifier') buildClarifier(kit, m, d, isTwin(d) ? 'CLARIFIER 2' : 'CLARIFIER 1');
    else buildSilo(kit, m, d, silo++);
  }
  buildBridge(kit, m);
}
