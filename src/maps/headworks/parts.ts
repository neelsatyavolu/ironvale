import * as THREE from 'three/webgpu';
import { MeshBuilder } from './builder';
import { V, type Kit } from './kit';

/**
 * Pipework parts. Each builder returns one merged geometry with the pipe axis
 * along local Y, sized for a pipe of radius `r`, so a part can be dropped on
 * any run with one matrix.
 */

const SEGMENTS = 14;
const at = (x: number, y: number, z: number): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(x, y, z);
const turned = (rx: number, ry: number, rz: number, x = 0, y = 0, z = 0): THREE.Matrix4 =>
  new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)).setPosition(x, y, z);

/** Pair of bolted flanges with a gasket gap, centred on the origin. */
export function flangeGeometry(r: number, bolts = 8): THREE.BufferGeometry {
  const builder = new MeshBuilder();
  const plate = new THREE.CylinderGeometry(r * 1.62, r * 1.62, r * 0.2, SEGMENTS + 4);
  const hub = new THREE.CylinderGeometry(r * 1.2, r * 1.2, r * 0.75, SEGMENTS);
  const nut = new THREE.CylinderGeometry(r * 0.1, r * 0.1, r * 0.72, 6);
  for (const s of [-1, 1]) builder.add(plate, at(0, s * r * 0.12, 0));
  builder.add(hub, at(0, 0, 0));
  for (let i = 0; i < bolts; i++) {
    const a = (i / bolts) * Math.PI * 2;
    builder.add(nut, at(Math.cos(a) * r * 1.38, 0, Math.sin(a) * r * 1.38));
  }
  for (const g of [plate, hub, nut]) g.dispose();
  return builder.build();
}

/** Spoked handwheel in the XY plane, facing +Z, with its hub at the origin. */
export function handwheelGeometry(radius: number): THREE.BufferGeometry {
  const builder = new MeshBuilder();
  const rim = new THREE.TorusGeometry(radius, radius * 0.09, 6, 20);
  const spoke = new THREE.CylinderGeometry(radius * 0.06, radius * 0.06, radius * 2, 6);
  const hub = new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, radius * 0.3, 10);
  builder.add(rim, at(0, 0, 0));
  for (let i = 0; i < 3; i++) builder.add(spoke, turned(0, 0, (i / 3) * Math.PI));
  builder.add(hub, turned(Math.PI / 2, 0, 0));
  for (const g of [rim, spoke, hub]) g.dispose();
  return builder.build();
}

/**
 * Gate valve in a run along Y: flanged body, bonnet and yoke rising along +Z
 * to the stem. The handwheel is separate (it is a different colour); it sits
 * at `valveWheelOffset(r)` along +Z.
 */
export function valveGeometry(r: number): THREE.BufferGeometry {
  const builder = new MeshBuilder();
  const body = new THREE.CylinderGeometry(r * 1.25, r * 1.25, r * 2.6, SEGMENTS);
  const waist = new THREE.SphereGeometry(r * 1.55, SEGMENTS, 8);
  const bonnet = new THREE.CylinderGeometry(r * 0.9, r * 1.15, r * 1.0, SEGMENTS);
  const cap = new THREE.CylinderGeometry(r * 1.35, r * 1.35, r * 0.22, SEGMENTS);
  const yoke = new THREE.BoxGeometry(r * 0.2, r * 0.2, r * 1.1);
  const stem = new THREE.CylinderGeometry(r * 0.14, r * 0.14, r * 1.5, 8);
  const flange = flangeGeometry(r);
  builder.add(body, at(0, 0, 0));
  builder.add(waist, new THREE.Matrix4().makeScale(1, 0.8, 1));
  builder.add(bonnet, turned(Math.PI / 2, 0, 0, 0, 0, r * 1.5));
  builder.add(cap, turned(Math.PI / 2, 0, 0, 0, 0, r * 2.05));
  for (const s of [-1, 1]) builder.add(yoke, at(s * r * 0.55, 0, r * 2.6));
  builder.add(stem, turned(Math.PI / 2, 0, 0, 0, 0, r * 2.75));
  for (const s of [-1, 1]) builder.add(flange, at(0, s * r * 1.5, 0));
  for (const g of [body, waist, bonnet, cap, yoke, stem, flange]) g.dispose();
  return builder.build();
}

export const valveWheelOffset = (r: number): number => r * 3.4;

const AXES = [V(1, 0, 0), V(0, 1, 0), V(0, 0, 1)];

/**
 * Pipe along a path of axis-aligned legs, with a swept elbow at each corner
 * and a flange pair every `flangeEvery` metres of straight. Returns nothing;
 * the parts are baked into the kit.
 */
export function pipeRun(
  kit: Kit,
  material: THREE.Material,
  points: readonly THREE.Vector3[],
  r: number,
  color?: number,
  flangeEvery = 3,
  flangeColor = color,
): void {
  const bend = r * 2.1;
  const flange = flangeGeometry(r);
  const elbow = new THREE.TorusGeometry(bend, r, 10, 8, Math.PI / 2);
  const up = V(0, 1, 0);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as THREE.Vector3;
    const b = points[i + 1] as THREE.Vector3;
    const dir = b.clone().sub(a).normalize();
    const from = i > 0 ? a.clone().addScaledVector(dir, bend) : a.clone();
    const to = i + 2 < points.length ? b.clone().addScaledVector(dir, -bend) : b.clone();
    kit.tube(material, from, to, r, color, SEGMENTS);
    const length = from.distanceTo(to);
    const joints = Math.max(i > 0 || i + 2 < points.length ? 1 : 0, Math.floor(length / flangeEvery));
    const spin = new THREE.Quaternion().setFromUnitVectors(up, dir);
    for (let k = 1; k <= joints; k++) {
      const p = from.clone().lerp(to, k / (joints + 1));
      kit.add(material, flange, new THREE.Matrix4().compose(p, spin, V(1, 1, 1)), flangeColor);
    }
    const next = points[i + 2];
    if (!next) continue;
    const out = next.clone().sub(b).normalize();
    // Arc from (corner - dir * bend) to (corner + out * bend); see the torus's local frame.
    const centre = b.clone().addScaledVector(dir, -bend).addScaledVector(out, bend);
    const basis = new THREE.Matrix4().makeBasis(out.clone().negate(), dir, dir.clone().cross(out)).setPosition(centre);
    kit.add(material, elbow, basis, color);
  }
  flange.dispose();
  elbow.dispose();
}

/** Valve with its handwheel on a run along axis 0, 1 or 2 (x, y, z), stem pointing along `stem`. */
export function placeValve(
  kit: Kit,
  material: THREE.Material,
  wheelMaterial: THREE.Material,
  position: THREE.Vector3,
  r: number,
  axis: 0 | 1 | 2,
  stem: THREE.Vector3,
  color: number,
  wheelColor: number,
): void {
  const along = AXES[axis] as THREE.Vector3;
  const side = along.clone().cross(stem).normalize();
  const basis = new THREE.Matrix4().makeBasis(side, along, stem).setPosition(position);
  const valve = valveGeometry(r);
  const wheel = handwheelGeometry(Math.min(r * 1.5, 0.34));
  kit.add(material, valve, basis, color);
  kit.add(wheelMaterial, wheel, basis.clone().multiply(at(0, 0, valveWheelOffset(r))), wheelColor);
  valve.dispose();
  wheel.dispose();
}

/** Two-rail tubular handrail with posts and a kick plate, from `a` to `b` at floor level. */
export function handrail(kit: Kit, material: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, height = 1.1, color?: number): void {
  const length = a.distanceTo(b);
  const bays = Math.max(1, Math.round(length / 1.4));
  const lift = (p: THREE.Vector3, h: number): THREE.Vector3 => p.clone().add(V(0, h, 0));
  for (let i = 0; i <= bays; i++) {
    const p = a.clone().lerp(b, i / bays);
    kit.tube(material, p, lift(p, height), 0.022, color, 6);
    kit.box(material, 0.1, 0.012, 0.1, p.x, p.y, p.z, color);
  }
  kit.tube(material, lift(a, height), lift(b, height), 0.022, color, 6);
  kit.tube(material, lift(a, height * 0.52), lift(b, height * 0.52), 0.018, color, 6);
  kit.beam(material, lift(a, 0.06), lift(b, 0.06), 0.008, 0.1, color);
}
