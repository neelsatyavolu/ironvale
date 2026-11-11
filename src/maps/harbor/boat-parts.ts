import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { projectUv } from './kit';

/** What a boat vertex is, read by the boat material: fittings take plain paint, the hull weathers, decals are lettering. */
export const PART = { fitting: 0, hull: 1, decal: 2 } as const;
export type PartKind = (typeof PART)[keyof typeof PART];

/**
 * Makes a geometry mergeable into a boat: non-indexed, with a `paint`
 * attribute (rgb colour, a = part kind), box-projected `uv` for the wood
 * grain and a `duv` lettering coordinate that is off the atlas unless given.
 */
export function painted(geometry: THREE.BufferGeometry, hex: number, kind: PartKind = PART.fitting, duv?: Float32Array): THREE.BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  if (!flat.getAttribute('normal')) flat.computeVertexNormals();
  const count = flat.getAttribute('position').count;
  const c = new THREE.Color(hex);
  const paint = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) paint.set([c.r, c.g, c.b, kind], i * 4);
  flat.setAttribute('paint', new THREE.BufferAttribute(paint, 4));
  projectUv(flat, 1);
  flat.setAttribute('duv', new THREE.BufferAttribute(duv ?? new Float32Array(count * 2).fill(-1), 2));
  for (const name of Object.keys(flat.attributes)) {
    if (!['position', 'normal', 'uv', 'paint', 'duv'].includes(name)) flat.deleteAttribute(name);
  }
  return flat;
}

export interface Placement {
  readonly yaw?: number;
  readonly pitch?: number;
  readonly roll?: number;
}

const euler = new THREE.Euler();
const matrix = new THREE.Matrix4();

function place(geometry: THREE.BufferGeometry, x: number, y: number, z: number, turn: Placement): THREE.BufferGeometry {
  if (turn.yaw || turn.pitch || turn.roll) {
    geometry.applyMatrix4(matrix.makeRotationFromEuler(euler.set(turn.pitch ?? 0, turn.yaw ?? 0, turn.roll ?? 0, 'YXZ')));
  }
  geometry.translate(x, y, z);
  return geometry;
}

export function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number, turn: Placement = {}): THREE.BufferGeometry {
  return painted(place(new THREE.BoxGeometry(w, h, d), x, y, z, turn), hex);
}

/** Cylinder standing on Y unless turned. */
export function rod(radiusTop: number, radiusBottom: number, length: number, x: number, y: number, z: number, hex: number, turn: Placement = {}, sides = 8): THREE.BufferGeometry {
  return painted(place(new THREE.CylinderGeometry(radiusTop, radiusBottom, length, sides), x, y, z, turn), hex);
}

/** Round-ended cylinder: fenders, floats, furled canvas. */
export function capsule(radius: number, length: number, x: number, y: number, z: number, hex: number, turn: Placement = {}): THREE.BufferGeometry {
  return painted(place(new THREE.CapsuleGeometry(radius, length, 3, 10), x, y, z, turn), hex);
}

export function ball(radius: number, x: number, y: number, z: number, hex: number, squash: readonly [number, number, number] = [1, 1, 1]): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, 10, 7);
  geometry.scale(squash[0], squash[1], squash[2]);
  geometry.translate(x, y, z);
  return painted(geometry, hex);
}

export type Point = readonly [number, number, number];

/** Rope or wire through a list of points. */
export function line(points: readonly Point[], radius: number, hex: number, sides = 5): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  return painted(new THREE.TubeGeometry(curve, Math.max(4, points.length * 3), radius, sides, false), hex);
}

/** Rope hanging between two points with `sag` metres of droop at the middle. */
export function slackLine(a: Point, b: Point, sag: number, radius: number, hex: number): THREE.BufferGeometry {
  const points: Point[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - Math.sin(t * Math.PI) * sag, a[2] + (b[2] - a[2]) * t]);
  }
  return line(points, radius, hex);
}

/**
 * Rectangular timber swept along a polyline: gunwale caps, rub rails, ribs,
 * stem posts. `width` lies across the path in the horizontal plane where the
 * path allows, `height` is the other dimension.
 */
export function sweep(points: readonly Point[], width: number, height: number, hex: number, kind: PartKind = PART.fitting): THREE.BufferGeometry {
  const path = points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const up = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const sideways = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const rings: THREE.Vector3[][] = path.map((p, i) => {
    tangent.subVectors(path[Math.min(i + 1, path.length - 1)]!, path[Math.max(i - 1, 0)]!).normalize();
    sideways.crossVectors(tangent, Math.abs(tangent.y) > 0.92 ? new THREE.Vector3(0, 0, 1) : up).normalize();
    normal.crossVectors(sideways, tangent).normalize();
    return [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([a, b]) => p.clone().addScaledVector(sideways, (a! * width) / 2).addScaledVector(normal, (b! * height) / 2));
  });
  const positions: number[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void => {
    for (const v of [a, b, c, a, c, d]) positions.push(v.x, v.y, v.z);
  };
  for (let i = 0; i < rings.length - 1; i++) {
    const r0 = rings[i]!;
    const r1 = rings[i + 1]!;
    for (let k = 0; k < 4; k++) quad(r0[k]!, r0[(k + 1) % 4]!, r1[(k + 1) % 4]!, r1[k]!);
  }
  const first = rings[0]!;
  const last = rings[rings.length - 1]!;
  quad(first[3]!, first[2]!, first[1]!, first[0]!);
  quad(last[0]!, last[1]!, last[2]!, last[3]!);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return painted(geometry, hex, kind);
}

export function mergeBoat(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const geometry of parts) geometry.dispose();
  if (!merged) throw new Error('Harbor: could not merge boat geometry');
  return merged;
}
