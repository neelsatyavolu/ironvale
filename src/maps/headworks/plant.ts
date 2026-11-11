import * as THREE from 'three/webgpu';
import { signGeometry } from './decals';
import { V, type Kit } from './kit';
import { COAT, type Materials } from './materials';
import { flangeGeometry, pipeRun, placeValve } from './parts';
import { BLOCKS, HOUSE, isTwin, type Block } from './plan';

/** Local frame of a block: `u` along its long side, `w` across, origin at the middle of its base. */
function frameOf(b: Block): { length: number; width: number; p(u: number, y: number, w: number): THREE.Vector3; m(u: number, y: number, w: number): THREE.Matrix4 } {
  const alongX = b.x1 - b.x0 >= b.z1 - b.z0;
  // The twin is turned half a turn, so its frame is too and both sides are dressed alike.
  const turn = (alongX ? 0 : -Math.PI / 2) + (isTwin(b) ? Math.PI : 0);
  const basis = new THREE.Matrix4().makeRotationY(turn).setPosition((b.x0 + b.x1) / 2, b.y, (b.z0 + b.z1) / 2);
  return {
    length: alongX ? b.x1 - b.x0 : b.z1 - b.z0,
    width: alongX ? b.z1 - b.z0 : b.x1 - b.x0,
    p: (u, y, w) => V(u, y, w).applyMatrix4(basis),
    m: (u, y, w) => basis.clone().multiply(new THREE.Matrix4().makeTranslation(u, y, w)),
  };
}

const lying = new THREE.Matrix4().makeRotationZ(Math.PI / 2);

/**
 * Valve manifold: two teal headers stacked on each side of a concrete spine,
 * tied together by risers, with gate valves facing out and gauges on the
 * spine. Taller manifolds carry actuator boxes on top.
 */
function buildManifold(kit: Kit, m: Materials, b: Block): void {
  const f = frameOf(b);
  const tall = b.h > 2.4;
  const top = b.h;
  const half = f.length / 2;
  kit.cast(m.concrete, f.length, 0.3, f.width, f.m(0, 0.15, 0), 0.05, 0xdedcd5);
  const spineWidth = Math.max(0.4, f.width - 2.3);
  kit.cast(m.concrete, f.length - 0.5, top - 0.3, spineWidth, f.m(0, 0.3 + (top - 0.3) / 2, 0), 0.05, 0xe9e7e1);
  const r = Math.min(0.38, (f.width - spineWidth) / 4 - 0.06);
  for (const s of [-1, 1]) {
    const w = s * (spineWidth / 2 + r + 0.12);
    const levels = tall ? [0.3 + r + 0.2, top - r - 0.25] : [0.3 + r + 0.3];
    levels.forEach((y, level) => {
      const coat = level === 0 ? COAT.teal : COAT.tealDark;
      pipeRun(kit, m.paint, [f.p(-half + 0.25, 0.02, w), f.p(-half + 0.25, y, w), f.p(half - 0.25, y, w), f.p(half - 0.25, 0.02, w)], r, coat, 1.7, COAT.tealDark);
      // Gate valves stand on the lower header only, stems up, so nothing reaches out past the plinth.
      const valves = level === 0 ? Math.max(1, Math.round(f.length / 2.6)) : 0;
      for (let i = 0; i < valves; i++) {
        const u = -half + ((i + 0.5) / valves) * f.length + s * 0.3;
        const axis: 0 | 2 = Math.abs(f.p(1, 0, 0).x - f.p(0, 0, 0).x) > 0.5 ? 0 : 2;
        placeValve(kit, m.paint, m.paint, f.p(u, y, w), r * 0.8, axis, V(0, 1, 0), COAT.blue, i % 2 === 0 ? COAT.yellow : COAT.red);
      }
      // Saddles carry the header off the plinth.
      for (let u = -half + 0.9; u < half - 0.6; u += 1.6) kit.cast(m.concrete, 0.24, y - r - 0.3, r * 1.6, f.m(u, 0.3 + (y - r - 0.3) / 2, w), 0.03, 0xd6d4cd);
    });
    // Pressure gauges on stalks along the spine.
    for (let u = -half + 1.1; u < half - 0.8; u += 2.1) {
      const y = top - 0.5;
      const face = s * (spineWidth / 2);
      kit.tube(m.stainless, f.p(u, y - 0.25, face), f.p(u, y, face + s * 0.07), 0.012, undefined, 6);
      const dial = new THREE.CylinderGeometry(0.075, 0.075, 0.04, 14).rotateX(Math.PI / 2);
      kit.add(m.matte, dial, f.m(u, y, face + s * 0.09), 0xecece8);
      dial.dispose();
    }
  }
  if (tall) {
    for (let u = -half + 1.2; u < half - 0.8; u += 1.9) {
      kit.cast(m.paint, 0.5, 0.42, 0.4, f.m(u, top + 0.21 - 0.42, 0), 0.03, COAT.yellow);
      kit.add(m.lamp, new THREE.BoxGeometry(0.06, 0.06, 0.02), f.m(u + 0.12, top - 0.2, 0.21), 0x58ff7a);
    }
  }
}

/**
 * End-suction pump set on its plinth: finned motor, guarded coupling, volute
 * casing with the suction on the end, and a discharge riser with a gate valve
 * that climbs to the ceiling and leaves through the wall.
 */
function buildPumpSet(kit: Kit, m: Materials, b: Block, index: number): void {
  const f = frameOf(b);
  const half = f.length / 2;
  kit.cast(m.concrete, f.length, 0.36, f.width, f.m(0, 0.18, 0), 0.05, 0xdad8d0);
  kit.cast(m.paint, f.length - 0.5, 0.12, f.width - 0.5, f.m(0, 0.42, 0), 0.02, COAT.black);
  const axis = 1.02;
  const motor = new THREE.CylinderGeometry(0.4, 0.4, 1.15, 20);
  kit.add(m.paint, motor, f.m(-half + 1.0, axis, 0).multiply(lying), COAT.teal);
  motor.dispose();
  const fin = new THREE.CylinderGeometry(0.46, 0.46, 0.025, 20);
  for (let i = 0; i < 9; i++) kit.add(m.paint, fin, f.m(-half + 0.55 + i * 0.105, axis, 0).multiply(lying), COAT.tealDark);
  fin.dispose();
  const cowl = new THREE.CylinderGeometry(0.43, 0.38, 0.22, 20);
  kit.add(m.paint, cowl, f.m(-half + 0.32, axis, 0).multiply(lying), COAT.black);
  cowl.dispose();
  kit.cast(m.paint, 0.34, 0.2, 0.3, f.m(-half + 1.0, axis + 0.48, 0), 0.03, COAT.grey);
  for (const s of [-1, 1]) kit.cast(m.paint, 0.9, axis - 0.5, 0.1, f.m(-half + 1.0, 0.48 + (axis - 0.5) / 2, s * 0.3), 0.02, COAT.tealDark);
  // Coupling guard, bearing housing and volute.
  kit.cast(m.paint, 0.42, 0.5, 0.56, f.m(-half + 1.82, axis, 0), 0.08, COAT.yellow);
  const bearing = new THREE.CylinderGeometry(0.24, 0.24, 0.5, 16);
  kit.add(m.paint, bearing, f.m(-half + 2.3, axis, 0).multiply(lying), COAT.tealDark);
  bearing.dispose();
  kit.cast(m.paint, 0.4, axis - 0.5, 0.5, f.m(-half + 2.3, 0.48 + (axis - 0.5) / 2, 0), 0.03, COAT.tealDark);
  const volute = new THREE.CylinderGeometry(0.58, 0.58, 0.42, 24);
  kit.add(m.paint, volute, f.m(half - 0.82, axis, 0).multiply(lying), COAT.teal);
  volute.dispose();
  const flange = flangeGeometry(0.2);
  kit.add(m.paint, flange, f.m(half - 0.5, axis, 0).multiply(lying), COAT.tealDark);
  flange.dispose();
  // Suction comes up out of the floor at the end; discharge rises off the top of the volute.
  pipeRun(kit, m.paint, [f.p(half - 0.6, axis, 0), f.p(half - 0.06, axis, 0)], 0.2, COAT.teal, 9);
  const ceiling = HOUSE.height - 0.5;
  // To the house's back wall, which is the perimeter wall; in this frame that is always +w.
  const wall = HOUSE.z1 - Math.abs((b.z0 + b.z1) / 2) + 0.1;
  pipeRun(kit, m.paint, [f.p(half - 0.82, axis + 0.5, 0), f.p(half - 0.82, ceiling, 0), f.p(half - 0.82, ceiling, wall)], 0.16, COAT.teal, 1.6, COAT.tealDark);
  const run = f.p(1, 0, 0).sub(f.p(0, 0, 0));
  placeValve(kit, m.paint, m.paint, f.p(half - 0.82, 2.45, 0), 0.16, 1, run.negate(), COAT.blue, COAT.red);
  const label = signGeometry(index % 2 === 0 ? 'P-101' : 'P-102', 0.6);
  kit.add(m.sign, label, f.m(0, 0.2, f.width / 2 + 0.006));
  label.dispose();
}

/** Stack of precast concrete pipe sections on timber bearers, chocked: two below, one above, two lengths deep. */
function buildPipeStack(kit: Kit, m: Materials, b: Block): void {
  const f = frameOf(b);
  const outer = 0.6;
  const length = f.length / 2 - 0.08;
  const profile = [
    new THREE.Vector2(outer - 0.11, -length / 2),
    new THREE.Vector2(outer, -length / 2),
    new THREE.Vector2(outer, length / 2 - 0.3),
    new THREE.Vector2(outer + 0.07, length / 2 - 0.26),
    new THREE.Vector2(outer + 0.07, length / 2),
    new THREE.Vector2(outer - 0.02, length / 2),
    new THREE.Vector2(outer - 0.11, length / 2 - 0.2),
    new THREE.Vector2(outer - 0.11, -length / 2),
  ];
  const section = new THREE.LatheGeometry(profile, 28);
  const uv = section.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 3);
  const rise = Math.sqrt(3) * (outer + 0.02);
  const spots: readonly (readonly [number, number])[] = [
    [-(outer + 0.02), outer + 0.1],
    [outer + 0.02, outer + 0.1],
    [0, outer + 0.1 + rise],
  ];
  for (const end of [-1, 1]) {
    for (const [w, y] of spots) {
      if (y + outer > b.h + 0.2) continue;
      const tone = [0xdedcd6, 0xd0cec7, 0xe8e6e0][Math.floor(kit.random() * 3)] as number;
      kit.add(m.concreteRound, section, f.m(end * (length / 2 + 0.04), y, w).multiply(lying).multiply(new THREE.Matrix4().makeRotationY(kit.range(0, 6))), tone);
    }
    for (const u of [0.35, length - 0.35]) {
      kit.cast(m.matte, 0.12, 0.1, f.width - 0.1, f.m(end * u + (end > 0 ? 0.04 : -0.04), 0.05, 0), 0.01, 0x6b5238);
      for (const s of [-1, 1]) kit.cast(m.matte, 0.12, 0.16, 0.24, f.m(end * u + (end > 0 ? 0.04 : -0.04), 0.18, s * (outer * 2 + 0.1)), 0.03, 0x7a5f42);
    }
  }
  section.dispose();
}

/** Pipework plant from the plan: manifolds, pump sets and the stacks of spare pipe. */
export function buildPlant(kit: Kit, m: Materials): void {
  let pumps = 0;
  for (const b of BLOCKS) {
    if (b.role === 'manifold') buildManifold(kit, m, b);
    else if (b.role === 'pumpset') buildPumpSet(kit, m, b, pumps++);
    else if (b.role === 'pipes') buildPipeStack(kit, m, b);
  }
}
