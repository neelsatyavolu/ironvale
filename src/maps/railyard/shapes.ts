import * as THREE from 'three/webgpu';
import type { MeshBuilder } from './builder';
import { beamMatrix } from './kit';

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/**
 * Box centred on the origin with every edge cut back by `chamfer`, so pressed
 * and cast parts catch a highlight along their edges instead of ending in a
 * razor line. Faces are flat shaded.
 */
export function chamferBox(width: number, height: number, depth: number, chamfer: number): THREE.BufferGeometry {
  const c = Math.min(chamfer, width / 2 - 0.001, height / 2 - 0.001, depth / 2 - 0.001);
  const w = width / 2;
  const h = height / 2;
  const outline = new THREE.Shape();
  outline.moveTo(-w + c, -h);
  outline.lineTo(w - c, -h);
  outline.lineTo(w, -h + c);
  outline.lineTo(w, h - c);
  outline.lineTo(w - c, h);
  outline.lineTo(-w + c, h);
  outline.lineTo(-w, h - c);
  outline.lineTo(-w, -h + c);
  outline.closePath();
  const geometry = new THREE.ExtrudeGeometry(outline, {
    depth: depth - c * 2,
    bevelEnabled: true,
    bevelThickness: c,
    bevelSize: c,
    bevelOffset: -c,
    bevelSegments: 1,
    curveSegments: 1,
  });
  return geometry.translate(0, 0, -(depth - c * 2) / 2);
}

/** Add a chamfered box to `builder`, centred on (x, y, z), optionally rotated (Euler XYZ). */
export function addChamferBox(
  builder: MeshBuilder,
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  color: number,
  chamfer = 0.03,
  rotation: readonly [number, number, number] = [0, 0, 0],
): void {
  const geometry = chamferBox(size[0], size[1], size[2], chamfer);
  const matrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation)).setPosition(...at);
  builder.add(geometry, matrix, color);
  geometry.dispose();
}

/** Straight member from `a` to `b` with a rectangular section. */
export function strut(
  builder: MeshBuilder,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  width: number,
  color: number,
  depth = width,
): void {
  builder.add(UNIT_BOX, beamMatrix(V(...a), V(...b), width, depth), color);
}

/** Round bar from `a` to `b` (hydraulic rams, exhausts, handles). */
export function rod(
  builder: MeshBuilder,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  radius: number,
  color: number,
  segments = 10,
): void {
  const from = V(...a);
  const to = V(...b);
  const geometry = new THREE.CylinderGeometry(radius, radius, from.distanceTo(to), segments);
  const turn = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), to.clone().sub(from).normalize());
  builder.add(geometry, new THREE.Matrix4().compose(from.add(to).multiplyScalar(0.5), turn, V(1, 1, 1)), color);
  geometry.dispose();
}

export interface WheelPaint {
  readonly tyre: number;
  readonly rim: number;
  readonly hub: number;
}

/**
 * Road wheel with its axle along X, centred on (x, y, z): a tyre with rounded
 * shoulders, a dished rim on both faces, and a hub with a ring of wheel nuts
 * on the face that points along `outward` (+1 or -1 on X). Rubber goes to
 * `rubber`, metal to `metal`.
 */
export function addWheel(
  rubber: MeshBuilder,
  metal: MeshBuilder,
  at: readonly [number, number, number],
  radius: number,
  width: number,
  outward: number,
  paint: WheelPaint,
): void {
  const half = width / 2;
  const section: readonly (readonly [number, number])[] = [
    [radius * 0.6, -half * 0.82],
    [radius * 0.8, -half],
    [radius * 0.94, -half * 0.94],
    [radius, -half * 0.74],
    [radius * 1.012, -half * 0.5],
    [radius * 1.012, half * 0.5],
    [radius, half * 0.74],
    [radius * 0.94, half * 0.94],
    [radius * 0.8, half],
    [radius * 0.6, half * 0.82],
  ];
  const toAxle = new THREE.Matrix4().makeRotationZ(-Math.PI / 2).setPosition(...at);
  const tyre = new THREE.LatheGeometry(section.map(([r, y]) => new THREE.Vector2(r, y)), 22);
  rubber.add(tyre, toAxle, paint.tyre);
  tyre.dispose();

  // Rim: a dish set back from each face. The profile runs rim to centre so it faces outward.
  const dish = new THREE.LatheGeometry(
    [
      new THREE.Vector2(radius * 0.6, half * 0.62),
      new THREE.Vector2(radius * 0.48, half * 0.22),
      new THREE.Vector2(radius * 0.26, half * 0.3),
      new THREE.Vector2(radius * 0.22, half * 0.5),
      new THREE.Vector2(0.001, half * 0.5),
    ],
    20,
  );
  // LatheGeometry turns about Y; rotate that onto the X direction each face points along.
  const face = new THREE.Matrix4().makeRotationZ((-outward * Math.PI) / 2).setPosition(...at);
  metal.add(dish, face, paint.rim);
  metal.add(dish, new THREE.Matrix4().makeRotationZ((outward * Math.PI) / 2).setPosition(...at), paint.rim);
  dish.dispose();
  const cap = new THREE.CylinderGeometry(radius * 0.13, radius * 0.16, half * 0.3, 10);
  metal.add(cap, face.clone().multiply(new THREE.Matrix4().makeTranslation(0, half * 0.62, 0)), paint.hub);
  cap.dispose();
  const nut = new THREE.CylinderGeometry(radius * 0.035, radius * 0.035, half * 0.16, 6);
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const offset = new THREE.Matrix4().makeTranslation(Math.cos(angle) * radius * 0.36, half * 0.34, Math.sin(angle) * radius * 0.36);
    metal.add(nut, face.clone().multiply(offset), paint.hub);
  }
  nut.dispose();
}

/** Round cable or hose following `points` (a smooth curve through them). */
export function hose(points: readonly (readonly [number, number, number])[], radius: number, sides = 5): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => V(...point)), false, 'catmullrom', 0.5);
  return new THREE.TubeGeometry(curve, Math.max(6, points.length * 6), radius, sides, false);
}
