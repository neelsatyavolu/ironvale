/**
 * Triangle-level queries on a processed gun file, for the tests that check
 * anchors against the mesh itself (m1911, mp5, r870). Everything is in gun
 * space: metres, barrel along -Z, with every part at rest.
 */
import type { Document } from '@gltf-transform/core';
import { Vector3 } from 'three/webgpu';

export interface PartMesh {
  /** Node name, for example `part_slide`. */
  readonly part: string;
  /** Vertex positions in gun space, three numbers per vertex. */
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export interface RayHit {
  readonly part: string;
  readonly distance: number;
  readonly point: Vector3;
}

/** Every mesh primitive of the file's top-level nodes, moved into gun space. */
export function readParts(document: Document): PartMesh[] {
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  const parts: PartMesh[] = [];
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const offset = node.getTranslation();
    for (const primitive of mesh.listPrimitives()) {
      const source = primitive.getAttribute('POSITION')!.getArray()!;
      const positions = new Float32Array(source.length);
      for (let i = 0; i < source.length; i++) positions[i] = source[i] + offset[i % 3];
      parts.push({ part: node.getName(), positions, indices: Uint32Array.from(primitive.getIndices()!.getArray()!) });
    }
  }
  return parts;
}

/** Every vertex of the chosen parts as a point. */
export function verticesOf(parts: readonly PartMesh[], only?: (part: string) => boolean): Vector3[] {
  const points: Vector3[] = [];
  for (const { part, positions } of parts) {
    if (only && !only(part)) continue;
    for (let i = 0; i < positions.length; i += 3) points.push(new Vector3(positions[i], positions[i + 1], positions[i + 2]));
  }
  return points;
}

const EPSILON = 1e-12;

/** Distance along the ray to triangle abc, or null (Möller-Trumbore, both faces). */
function hitTriangle(origin: Vector3, direction: Vector3, a: Vector3, b: Vector3, c: Vector3): number | null {
  const edge1 = b.clone().sub(a);
  const edge2 = c.clone().sub(a);
  const p = direction.clone().cross(edge2);
  const determinant = edge1.dot(p);
  if (Math.abs(determinant) < EPSILON) return null;
  const t = origin.clone().sub(a);
  const u = t.dot(p) / determinant;
  if (u < 0 || u > 1) return null;
  const q = t.cross(edge1);
  const v = direction.dot(q) / determinant;
  if (v < 0 || u + v > 1) return null;
  const distance = edge2.dot(q) / determinant;
  return distance > 0 ? distance : null;
}

/** The first thing a ray from `origin` along unit `direction` hits within `reach`, or null. */
export function castRay(parts: readonly PartMesh[], origin: Vector3, direction: Vector3, reach = Infinity): RayHit | null {
  let best: { part: string; distance: number } | null = null;
  const corner = [new Vector3(), new Vector3(), new Vector3()];
  for (const { part, positions, indices } of parts) {
    for (let i = 0; i < indices.length; i += 3) {
      for (let k = 0; k < 3; k++) corner[k].fromArray(positions, indices[i + k] * 3);
      const distance = hitTriangle(origin, direction, corner[0], corner[1], corner[2]);
      if (distance !== null && distance <= reach && (!best || distance < best.distance)) best = { part, distance };
    }
  }
  return best ? { ...best, point: origin.clone().addScaledVector(direction, best.distance) } : null;
}

/** Closest point to `p` on triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: Vector3, a: Vector3, b: Vector3, c: Vector3): Vector3 {
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const ap = p.clone().sub(a);
  const d1 = ab.dot(ap);
  const d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return a.clone();
  const bp = p.clone().sub(b);
  const d3 = ab.dot(bp);
  const d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return b.clone();
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return a.clone().addScaledVector(ab, d1 / (d1 - d3));
  const cp = p.clone().sub(c);
  const d5 = ab.dot(cp);
  const d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return c.clone();
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return a.clone().addScaledVector(ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return b.clone().addScaledVector(c.clone().sub(b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  }
  const denominator = 1 / (va + vb + vc);
  return a.clone().addScaledVector(ab, vb * denominator).addScaledVector(ac, vc * denominator);
}

/** Distance from `point` to the nearest surface of the chosen parts. */
export function distanceToSurface(parts: readonly PartMesh[], point: Vector3, only?: (part: string) => boolean): number {
  let best = Infinity;
  const corner = [new Vector3(), new Vector3(), new Vector3()];
  for (const { part, positions, indices } of parts) {
    if (only && !only(part)) continue;
    for (let i = 0; i < indices.length; i += 3) {
      for (let k = 0; k < 3; k++) corner[k].fromArray(positions, indices[i + k] * 3);
      best = Math.min(best, closestOnTriangle(point, corner[0], corner[1], corner[2]).distanceTo(point));
    }
  }
  return best;
}
