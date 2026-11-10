import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tiledBox } from '../../world/geometry';
import type { Surface, World } from '../../world/types';

export type Vec3 = readonly [number, number, number];

/** Collects static geometry per material and turns each bucket into one merged mesh. */
export class Batch {
  private readonly buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();

  /** `geometry` must already be in world space and is owned by the batch from here on. */
  add(material: THREE.Material, geometry: THREE.BufferGeometry): void {
    const list = this.buckets.get(material);
    // Merging needs matching attribute sets; keep only what the materials read.
    const clean = geometry.index ? geometry.toNonIndexed() : geometry;
    for (const name of Object.keys(clean.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') clean.deleteAttribute(name);
    }
    if (clean !== geometry) geometry.dispose();
    if (list) list.push(clean);
    else this.buckets.set(material, [clean]);
  }

  /** Emit one mesh per material under `root`. */
  build(root: THREE.Object3D, castShadow = true): void {
    for (const [material, geometries] of this.buckets) {
      const merged = mergeGeometries(geometries, false);
      for (const geometry of geometries) geometry.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      root.add(mesh);
    }
    this.buckets.clear();
  }
}

export interface PartOptions {
  /** Euler rotation in radians, applied in YXZ order. */
  readonly rot?: Vec3;
  /** Collider surface. Omit for decoration that should not block movement or bullets. */
  readonly surface?: Surface;
  /** Metres covered by one texture repeat. */
  readonly tile?: number;
}

const scratchEuler = new THREE.Euler();
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const UNIT = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

export function transform(pos: Vec3, rot: Vec3 = [0, 0, 0]): THREE.Matrix4 {
  scratchEuler.set(rot[0], rot[1], rot[2], 'YXZ');
  scratchQuat.setFromEuler(scratchEuler);
  return new THREE.Matrix4().compose(scratchPos.set(pos[0], pos[1], pos[2]), scratchQuat, UNIT);
}

/**
 * Places parts of one structure. Positions are local to the structure's
 * `base` matrix; each part goes to the batch and, when it has a surface, to
 * the collision world.
 */
export class Kit {
  constructor(
    private readonly batch: Batch,
    private readonly world: World,
    private readonly base: THREE.Matrix4,
  ) {}

  /** Arbitrary geometry with a local matrix. */
  geo(material: THREE.Material, geometry: THREE.BufferGeometry, local: THREE.Matrix4, surface?: Surface): void {
    const matrix = new THREE.Matrix4().multiplyMatrices(this.base, local);
    if (surface) this.world.addCollider(geometry, matrix, surface);
    geometry.applyMatrix4(matrix);
    this.batch.add(material, geometry);
  }

  /** Box centred on `pos`. */
  box(material: THREE.Material, size: Vec3, pos: Vec3, options: PartOptions = {}): void {
    this.geo(material, tiledBox(size[0], size[1], size[2], options.tile ?? 2), transform(pos, options.rot), options.surface);
  }

  /** Box-section beam from `from` to `to`. */
  beam(material: THREE.Material, from: Vec3, to: Vec3, width: number, depth = width, surface?: Surface): void {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const length = a.distanceTo(b);
    const quat = new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize());
    const local = new THREE.Matrix4().compose(a.add(b).multiplyScalar(0.5), quat, UNIT);
    this.geo(material, tiledBox(width, length, depth, 1.8), local, surface);
  }

  /** Cylinder (or cone frustum) from `from` to `to`. */
  pole(material: THREE.Material, from: Vec3, to: Vec3, radius: number, sides = 8, surface?: Surface, endRadius = radius): void {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const length = a.distanceTo(b);
    const quat = new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize());
    const local = new THREE.Matrix4().compose(a.add(b).multiplyScalar(0.5), quat, UNIT);
    const geometry = new THREE.CylinderGeometry(endRadius, radius, length, sides, 1);
    const uv = geometry.getAttribute('uv');
    const around = Math.max(1, Math.round((radius * Math.PI * 2) / 1.2));
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * around, (uv.getY(i) * length) / 2);
    this.geo(material, geometry, local, surface);
  }

  /** Invisible box collider. */
  collider(size: Vec3, pos: Vec3, surface: Surface, rot?: Vec3): void {
    const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
    this.world.addCollider(geometry, new THREE.Matrix4().multiplyMatrices(this.base, transform(pos, rot)), surface);
    geometry.dispose();
  }

  /** World-space position of a local point. */
  point(local: Vec3): THREE.Vector3 {
    return new THREE.Vector3(...local).applyMatrix4(this.base);
  }
}

/** Assign box-projected UVs so a tiling texture wraps an arbitrary lump without a seam pole. */
export function boxProjectUvs(geometry: THREE.BufferGeometry, tile: number): THREE.BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = flat.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.subVectors(b, a).cross(c.sub(a));
    c.fromBufferAttribute(pos, i + 2);
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c;
      const [u, v] = ay >= ax && ay >= az ? [p.x, p.z] : ax >= az ? [p.z, p.y] : [p.x, p.y];
      uv[(i + k) * 2] = u / tile;
      uv[(i + k) * 2 + 1] = v / tile;
    }
  }
  flat.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return flat;
}

/**
 * Vertex-clustering decimation for scanned props: vertices that share a grid
 * cell collapse to the cell's mean position. UV islands are kept apart so the
 * texture does not smear across seams.
 */
export function clusterDecimate(geometry: THREE.BufferGeometry, cell: number): THREE.BufferGeometry {
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const source = geometry.index;
  if (!source || !uv) return geometry.clone();
  const cellKey = (i: number): string => `${Math.round(pos.getX(i) / cell)},${Math.round(pos.getY(i) / cell)},${Math.round(pos.getZ(i) / cell)}`;
  const sums = new Map<string, [number, number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const key = cellKey(i);
    const sum = sums.get(key);
    if (sum) {
      sum[0] += pos.getX(i);
      sum[1] += pos.getY(i);
      sum[2] += pos.getZ(i);
      sum[3]++;
    } else sums.set(key, [pos.getX(i), pos.getY(i), pos.getZ(i), 1]);
  }
  const ids = new Map<string, number>();
  const remap = new Uint32Array(pos.count);
  const outPos: number[] = [];
  const outUv: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const key = cellKey(i);
    const full = `${key}|${Math.round(uv.getX(i) * 10)},${Math.round(uv.getY(i) * 10)}`;
    let id = ids.get(full);
    if (id === undefined) {
      id = outPos.length / 3;
      ids.set(full, id);
      const sum = sums.get(key) as [number, number, number, number];
      outPos.push(sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]);
      outUv.push(uv.getX(i), uv.getY(i));
    }
    remap[i] = id;
  }
  const outIndex: number[] = [];
  for (let i = 0; i < source.count; i += 3) {
    const a = remap[source.getX(i)] as number;
    const b = remap[source.getX(i + 1)] as number;
    const c = remap[source.getX(i + 2)] as number;
    const same = (p: number, q: number): boolean =>
      outPos[p * 3] === outPos[q * 3] && outPos[p * 3 + 1] === outPos[q * 3 + 1] && outPos[p * 3 + 2] === outPos[q * 3 + 2];
    if (same(a, b) || same(b, c) || same(a, c)) continue;
    outIndex.push(a, b, c);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
  out.setIndex(outIndex);
  out.computeVertexNormals();
  return out;
}
