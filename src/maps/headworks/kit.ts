import * as THREE from 'three/webgpu';
import type { MapBuildContext } from '../../game/contracts';
import { MeshBuilder } from './builder';

export interface ShadowFlags {
  readonly cast: boolean;
  readonly receive: boolean;
}

const DEFAULT_SHADOWS: ShadowFlags = { cast: true, receive: true };
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

export const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/**
 * Level-building helper for Headworks. Static geometry is baked to world
 * space and merged into one mesh per material when `finish` runs. Collision
 * is not handled here: it comes straight from the plan (see colliders.ts).
 */
export class Kit {
  readonly root = new THREE.Group();
  readonly random: () => number;
  /** 0 - 1 from the graphics settings. Only small decoration may depend on it. */
  readonly detail: number;
  private readonly batches = new Map<THREE.Material, MeshBuilder>();
  private readonly shadows = new Map<THREE.Material, ShadowFlags>();
  private readonly projected = new Map<THREE.Material, number>();
  private readonly disposables: { dispose(): void }[] = [];
  private readonly quaternion = new THREE.Quaternion();

  constructor(readonly ctx: MapBuildContext) {
    this.random = ctx.random;
    this.detail = ctx.detailDensity;
  }

  range(min: number, max: number): number {
    return min + this.random() * (max - min);
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)] as T;
  }

  setShadows(material: THREE.Material, cast: boolean, receive: boolean): void {
    this.shadows.set(material, { cast, receive });
  }

  /**
   * Give everything drawn with `material` UVs projected from world position,
   * `tile` metres per repeat, so its texture runs unbroken from piece to piece.
   */
  project(material: THREE.Material, tile: number): void {
    this.projected.set(material, tile);
  }

  own<T extends { dispose(): void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  transform(x: number, y: number, z: number, yaw = 0, scale = 1): THREE.Matrix4 {
    this.quaternion.setFromAxisAngle(UP, yaw);
    return new THREE.Matrix4().compose(V(x, y, z), this.quaternion, V(scale, scale, scale));
  }

  /** Bake `geometry` into the merged mesh for `material`. The geometry is not kept. */
  add(material: THREE.Material, geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, color?: number): void {
    let batch = this.batches.get(material);
    if (!batch) {
      batch = new MeshBuilder();
      this.batches.set(material, batch);
    }
    batch.add(geometry, matrix, color);
  }

  /** Sharp box with its centre at (x, z) and its underside at `y`. For small parts. */
  box(material: THREE.Material, width: number, height: number, depth: number, x: number, y: number, z: number, color?: number, yaw = 0): void {
    this.quaternion.setFromAxisAngle(UP, yaw);
    this.add(material, UNIT_BOX, new THREE.Matrix4().compose(V(x, y + height / 2, z), this.quaternion, V(width, height, depth)), color);
  }

  /** Box with chamfered edges, given by its extents. For anything cast in concrete or folded from plate. */
  slab(material: THREE.Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, bevel = 0.04, color?: number): void {
    const geometry = bevelBox(x1 - x0, y1 - y0, z1 - z0, bevel);
    this.add(material, geometry, new THREE.Matrix4().makeTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), color);
    geometry.dispose();
  }

  /** Chamfered box centred on the origin of `matrix`, for cast pieces that are turned or tilted. */
  cast(material: THREE.Material, width: number, height: number, depth: number, matrix: THREE.Matrix4, bevel = 0.04, color?: number): void {
    const geometry = bevelBox(width, height, depth, bevel);
    this.add(material, geometry, matrix, color);
    geometry.dispose();
  }

  /** Square-section member running from `a` to `b`. */
  beam(material: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, width: number, depth = width, color?: number): void {
    this.add(material, UNIT_BOX, beamMatrix(a, b, width, depth), color);
  }

  /** Round member running from `a` to `b` (pipes, rails, posts). */
  tube(material: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, radius: number, color?: number, segments = 10): void {
    const geometry = new THREE.CylinderGeometry(radius, radius, 1, segments, 1, true);
    this.add(material, geometry, beamMatrix(a, b, 1, 1), color);
    geometry.dispose();
  }

  instances(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    matrices: readonly THREE.Matrix4[],
    shadows: ShadowFlags = DEFAULT_SHADOWS,
  ): THREE.InstancedMesh | null {
    if (matrices.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = shadows.cast;
    mesh.receiveShadow = shadows.receive;
    this.root.add(mesh);
    return mesh;
  }

  /** Merge every batch into one mesh per material and attach them to the root. */
  finish(): void {
    for (const [material, batch] of this.batches) {
      const geometry = batch.build();
      const tile = this.projected.get(material);
      if (tile !== undefined) projectUvs(geometry, tile);
      const mesh = new THREE.Mesh(geometry, material);
      const flags = this.shadows.get(material) ?? DEFAULT_SHADOWS;
      mesh.castShadow = flags.cast;
      mesh.receiveShadow = flags.receive;
      this.root.add(mesh);
    }
    this.batches.clear();
  }

  dispose(): void {
    this.root.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
    for (const item of this.disposables) item.dispose();
  }
}

/**
 * Box centred on the origin with every edge chamfered by `bevel`, flat shaded
 * so each chamfer catches the light as its own facet. 44 triangles.
 */
export function bevelBox(width: number, height: number, depth: number, bevel: number): THREE.BufferGeometry {
  const b = Math.min(bevel, width / 2.01, height / 2.01, depth / 2.01);
  const half = [width / 2, height / 2, depth / 2] as const;
  /** The vertex of corner `s` that lies on the face of `axis`. */
  const vertex = (s: readonly number[], axis: number): THREE.Vector3 => {
    const p = [0, 1, 2].map((i) => (s[i] as number) * ((half[i] as number) - (i === axis ? 0 : b)));
    return V(p[0] as number, p[1] as number, p[2] as number);
  };
  const positions: number[] = [];
  const normals: number[] = [];
  const normal = new THREE.Vector3();
  const face = (points: THREE.Vector3[]): void => {
    const [p0, p1, p2] = points as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
    normal.crossVectors(p1.clone().sub(p0), p2.clone().sub(p0)).normalize();
    // The solid is convex about the origin, so a face is outward when its normal points away from it.
    const flip = normal.dot(p0) < 0;
    if (flip) normal.negate();
    for (let i = 1; i + 1 < points.length; i++) {
      const triangle = flip ? [p0, points[i + 1], points[i]] : [p0, points[i], points[i + 1]];
      for (const p of triangle as THREE.Vector3[]) {
        positions.push(p.x, p.y, p.z);
        normals.push(normal.x, normal.y, normal.z);
      }
    }
  };
  const signs = [-1, 1];
  for (let axis = 0; axis < 3; axis++) {
    const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
    for (const s of signs) {
      // Main face: the four corners that share this side, in order round the face.
      const ring = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([su, sv]) => {
        const corner = [0, 0, 0];
        corner[axis] = s;
        corner[u] = su as number;
        corner[v] = sv as number;
        return vertex(corner, axis);
      });
      face(ring);
      // Chamfer between this face and the next axis's faces, along the third axis.
      for (const su of signs) {
        const quad = [-1, 1].map((sv) => {
          const corner = [0, 0, 0];
          corner[axis] = s;
          corner[u] = su;
          corner[v] = sv;
          return corner;
        }) as [number[], number[]];
        face([vertex(quad[0], axis), vertex(quad[1], axis), vertex(quad[1], u), vertex(quad[0], u)]);
      }
    }
  }
  for (const sx of signs) for (const sy of signs) for (const sz of signs) face([0, 1, 2].map((axis) => vertex([sx, sy, sz], axis)));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((positions.length / 3) * 2), 2));
  return geometry;
}

/** Replace the UVs of a baked, non-indexed geometry with a box projection of its world position. */
function projectUvs(geometry: THREE.BufferGeometry, tile: number): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < position.count; i += 3) {
    // One projection per triangle, picked from its average normal, so no triangle straddles two.
    const nx = Math.abs(normal.getX(i) + normal.getX(i + 1) + normal.getX(i + 2));
    const ny = Math.abs(normal.getY(i) + normal.getY(i + 1) + normal.getY(i + 2));
    const nz = Math.abs(normal.getZ(i) + normal.getZ(i + 1) + normal.getZ(i + 2));
    for (let k = i; k < i + 3; k++) {
      const x = position.getX(k);
      const y = position.getY(k);
      const z = position.getZ(k);
      if (ny > nx * 1.01 && ny > nz * 1.01) uv.setXY(k, x / tile, z / tile);
      else if (nx > nz) uv.setXY(k, z / tile, y / tile);
      else uv.setXY(k, x / tile, y / tile);
    }
  }
  uv.needsUpdate = true;
}

/**
 * Matrix that stretches a unit shape from `a` to `b`: local Y runs along the
 * member, `width` is across it horizontally and `depth` is the remaining axis.
 */
export function beamMatrix(a: THREE.Vector3, b: THREE.Vector3, width: number, depth: number): THREE.Matrix4 {
  const along = new THREE.Vector3().subVectors(b, a);
  const length = along.length();
  along.normalize();
  const side = new THREE.Vector3().crossVectors(UP, along);
  if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
  side.normalize();
  const normal = new THREE.Vector3().crossVectors(side, along).normalize();
  const basis = new THREE.Matrix4().makeBasis(side, along, normal);
  const centre = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  return basis.scale(V(width, length, depth)).setPosition(centre);
}
