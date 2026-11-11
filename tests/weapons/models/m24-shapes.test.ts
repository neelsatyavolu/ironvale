import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { block, knurled, merge, place, plain, triangleCount, turned } from '../../../src/weapons/models/lib/m24-shapes';

function bounds(geometry: THREE.BufferGeometry): THREE.Box3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox as THREE.Box3;
}

/** Triangles whose winding disagrees with their stored normals. */
function inwardFaces(geometry: THREE.BufferGeometry): number {
  const { position, normal } = geometry.attributes;
  const [a, b, c, n] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let count = 0;
  for (let index = 0; index < position.count; index += 3) {
    a.fromBufferAttribute(position, index);
    b.fromBufferAttribute(position, index + 1).sub(a);
    c.fromBufferAttribute(position, index + 2).sub(a);
    if (b.cross(c).dot(n.fromBufferAttribute(normal, index)) <= 0) count++;
  }
  return count;
}

function wearValues(geometry: THREE.BufferGeometry): number[] {
  return [...new Set(Array.from(geometry.attributes.wear.array))].sort();
}

describe('turned', () => {
  const cylinder = turned([[0, 0], [0, 0.01], [0.03, 0.01], [0.03, 0]], { segments: 16 });

  it('closes a profile that starts and ends on the axis, facing outward', () => {
    const box = bounds(cylinder);
    expect(box.min.z).toBeCloseTo(0, 6);
    expect(box.max.z).toBeCloseTo(0.03, 6);
    expect(box.max.x).toBeCloseTo(0.01, 6);
    expect(inwardFaces(cylinder)).toBe(0);
    // Two caps of one triangle a step, the wall and two bevels of two.
    expect(triangleCount(cylinder)).toBe(16 * (1 + 2 + 2 + 2 + 1));
  });

  it('bevels outside corners only and marks the bevels as worn', () => {
    expect(wearValues(cylinder)).toEqual([0, 1]);
    const sharp = turned([[0, 0], [0, 0.01], [0.03, 0.01], [0.03, 0]], { segments: 16, chamfer: 0 });
    expect(wearValues(sharp)).toEqual([0]);
    expect(triangleCount(sharp)).toBe(16 * 4);
    // A step has one outside corner and one inside corner: only the outside one is cut.
    const step = turned([[0, 0.01], [0.01, 0.01], [0.01, 0.006], [0.02, 0.006]], { segments: 16 });
    expect(triangleCount(step)).toBe(16 * 2 * 4);
    // A bore is walked toward -Z, and faces the axis.
    const bore = turned([[0.02, 0.006], [0, 0.006]], { segments: 12 });
    expect(inwardFaces(bore)).toBe(0);
    const normal = new THREE.Vector3().fromBufferAttribute(bore.attributes.normal, 0);
    const position = new THREE.Vector3().fromBufferAttribute(bore.attributes.position, 0);
    expect(normal.x * position.x + normal.y * position.y).toBeLessThan(0);
  });

  it('shades smoothly through points marked smooth and flat across a hexagon', () => {
    const cone = turned([[0, 0.01], [0.01, 0.012, true], [0.02, 0.02]], { segments: 8, chamfer: 0 });
    const normals = cone.attributes.normal;
    const positions = cone.attributes.position;
    const atJoin: number[] = [];
    for (let index = 0; index < positions.count; index++) {
      if (Math.abs(positions.getZ(index) - 0.01) < 1e-7 && Math.abs(positions.getY(index)) < 1e-7 && positions.getX(index) > 0) atJoin.push(normals.getZ(index));
    }
    expect(atJoin.length).toBeGreaterThan(1);
    for (const z of atJoin) expect(z).toBeCloseTo(atJoin[0], 6);
    const hex = turned([[0, 0.004], [0.002, 0.004]], { segments: 6, faceted: true, chamfer: 0 });
    const first = new THREE.Vector3().fromBufferAttribute(hex.attributes.normal, 0);
    for (let index = 1; index < 6; index++) expect(new THREE.Vector3().fromBufferAttribute(hex.attributes.normal, index).distanceTo(first)).toBeLessThan(1e-6);
  });
});

describe('block and knurled', () => {
  it('cuts every edge and corner of a box', () => {
    const box = block([0.02, 0.01, 0.03], 0.001);
    expect(triangleCount(box)).toBe(12 + 24 + 8);
    expect(bounds(box).getSize(new THREE.Vector3()).toArray().map((v) => Number(v.toFixed(6)))).toEqual([0.02, 0.01, 0.03]);
    expect(inwardFaces(box)).toBe(0);
    expect(wearValues(box)).toEqual([0, 1]);
  });

  it('makes a closed ring of ridges', () => {
    const ring = knurled(0, 0.01, 0.012, 0.001, 10);
    expect(triangleCount(ring)).toBe(20 * 4);
    expect(inwardFaces(ring)).toBe(0);
    const radii = Array.from({ length: ring.attributes.position.count }, (_, index) => Math.hypot(ring.attributes.position.getX(index), ring.attributes.position.getY(index)));
    expect(Math.max(...radii)).toBeCloseTo(0.012, 6);
    expect(Math.min(...radii.filter((r) => r > 1e-6))).toBeCloseTo(0.011, 6);
  });
});

describe('place, plain and merge', () => {
  it('turns a part to stand along an axis and moves it', () => {
    const post = place(turned([[0, 0.002], [0.01, 0.002]], { segments: 8, chamfer: 0 }), [0.1, 0.2, 0.3], [0, 1, 0]);
    const box = bounds(post);
    expect(box.min.y).toBeCloseTo(0.2, 6);
    expect(box.max.y).toBeCloseTo(0.21, 6);
    expect(box.getCenter(new THREE.Vector3()).x).toBeCloseTo(0.1, 6);
  });

  it('merges builder output with stock three geometry', () => {
    const merged = merge([block([0.01, 0.01, 0.01]), plain(new THREE.TorusGeometry(0.01, 0.002, 6, 12))]);
    expect(Object.keys(merged.attributes).sort()).toEqual(['normal', 'position', 'uv', 'wear']);
    expect(triangleCount(merged)).toBe(44 + 6 * 12 * 2);
  });
});
