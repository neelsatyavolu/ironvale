import * as THREE from 'three/webgpu';
import type { MapBuildContext } from '../../game/contracts';
import { tiledBox } from '../../world/geometry';
import type { Surface } from '../../world/types';
import { MeshBuilder } from './builder';

export interface BoxOptions {
  readonly yaw?: number;
  /** Vertex colour; multiplies the material colour on materials that use vertex colours. */
  readonly color?: number;
  /** Metres per texture repeat. Leave out for untextured materials. */
  readonly tile?: number;
  /** Register a matching box collider with this surface. */
  readonly surface?: Surface;
}

export interface ShadowFlags {
  readonly cast: boolean;
  readonly receive: boolean;
}

const DEFAULT_SHADOWS: ShadowFlags = { cast: true, receive: true };
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Level-building helper. Static geometry is baked to world space and merged
 * into one mesh per material when `finish` runs, so the whole map costs a few
 * dozen draw calls. Colliders are registered separately as plain boxes.
 */
export class Kit {
  readonly root = new THREE.Group();
  readonly random: () => number;
  /** 0 - 1 from the graphics settings. Only decoration without colliders may depend on it. */
  readonly detail: number;
  private readonly batches = new Map<THREE.Material, MeshBuilder>();
  private readonly shadows = new Map<THREE.Material, ShadowFlags>();
  private readonly disposables: { dispose(): void }[] = [];
  private readonly quaternion = new THREE.Quaternion();

  constructor(readonly ctx: MapBuildContext) {
    this.random = ctx.random;
    this.detail = ctx.detailDensity;
  }

  /** Random number in [min, max). */
  range(min: number, max: number): number {
    return min + this.random() * (max - min);
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)] as T;
  }

  /** Set whether the merged mesh for a material casts and receives sun shadows. */
  setShadows(material: THREE.Material, cast: boolean, receive: boolean): void {
    this.shadows.set(material, { cast, receive });
  }

  /** Track something to dispose with the map (textures, prototype geometry). */
  own<T extends { dispose(): void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  /** Transform from a position, a yaw and an optional uniform scale. */
  transform(x: number, y: number, z: number, yaw = 0, scale = 1): THREE.Matrix4 {
    this.quaternion.setFromAxisAngle(UP, yaw);
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), this.quaternion, new THREE.Vector3(scale, scale, scale));
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

  /** Box with its centre at (x, z) and its underside at `y`, which is how level pieces are measured. */
  box(
    material: THREE.Material,
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    options: BoxOptions = {},
  ): void {
    const yaw = options.yaw ?? 0;
    this.quaternion.setFromAxisAngle(UP, yaw);
    const centre = new THREE.Vector3(x, y + height / 2, z);
    if (options.tile !== undefined) {
      const geometry = tiledBox(width, height, depth, options.tile);
      if (yaw === 0) anchorUvs(geometry, width, height, depth, x, y, z, options.tile);
      this.add(material, geometry, new THREE.Matrix4().compose(centre, this.quaternion, new THREE.Vector3(1, 1, 1)), options.color);
      geometry.dispose();
    } else {
      const matrix = new THREE.Matrix4().compose(centre, this.quaternion, new THREE.Vector3(width, height, depth));
      this.add(material, UNIT_BOX, matrix, options.color);
    }
    if (options.surface) this.collide(width, height, depth, x, y, z, options.surface, yaw);
  }

  /** Square-section member running from `a` to `b` (braces, rafters, handrails, booms). */
  beam(material: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, width: number, depth = width, color?: number): void {
    this.add(material, UNIT_BOX, beamMatrix(a, b, width, depth), color);
  }

  /** Upright cylinder with its base at `y`. */
  post(material: THREE.Material, radius: number, height: number, x: number, y: number, z: number, color?: number, segments = 10): void {
    const geometry = new THREE.CylinderGeometry(radius, radius, height, segments, 1);
    this.add(material, geometry, new THREE.Matrix4().makeTranslation(x, y + height / 2, z), color);
    geometry.dispose();
  }

  /** Box collider with its underside at `y`. */
  collide(width: number, height: number, depth: number, x: number, y: number, z: number, surface: Surface, yaw = 0): void {
    this.quaternion.setFromAxisAngle(UP, yaw);
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y + height / 2, z),
      this.quaternion,
      new THREE.Vector3(width, height, depth),
    );
    this.ctx.world.addCollider(UNIT_BOX, matrix, surface);
  }

  /** Slab collider running from `a` to `b` (ramps and stairs). `thickness` hangs below the line. */
  collideRamp(a: THREE.Vector3, b: THREE.Vector3, width: number, thickness: number, surface: Surface): void {
    const drop = new THREE.Vector3(0, -thickness / 2, 0);
    const matrix = beamMatrix(a.clone().add(drop), b.clone().add(drop), width, thickness);
    this.ctx.world.addCollider(UNIT_BOX, matrix, surface);
  }

  /** Instanced copies of one geometry. `colors` tints each instance when given. */
  instances(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    matrices: readonly THREE.Matrix4[],
    colors?: readonly THREE.Color[],
    shadows: ShadowFlags = DEFAULT_SHADOWS,
  ): THREE.InstancedMesh | null {
    if (matrices.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    colors?.forEach((color, i) => mesh.setColorAt(i, color));
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
      const mesh = new THREE.Mesh(batch.build(), material);
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
 * Shift the UVs of an axis-aligned tiled box so they follow world position.
 * Neighbouring boxes then continue each other's texture: a wall built from
 * several sheets shows one unbroken run of ribs. BoxGeometry face order is
 * +x, -x, +y, -y, +z, -z with four vertices each.
 */
function anchorUvs(
  geometry: THREE.BufferGeometry,
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  tile: number,
): void {
  const west = x - width / 2;
  const east = x + width / 2;
  const north = z - depth / 2;
  const south = z + depth / 2;
  // [u offset, v offset] per face, matching the direction each face's U and V run in.
  const offsets: readonly (readonly [number, number])[] = [
    [-south, y],
    [north, y],
    [west, -south],
    [west, north],
    [west, y],
    [-east, y],
  ];
  const uv = geometry.getAttribute('uv');
  offsets.forEach(([du, dv], face) => {
    for (let i = 0; i < 4; i++) {
      const index = face * 4 + i;
      uv.setXY(index, uv.getX(index) + du / tile, uv.getY(index) + dv / tile);
    }
  });
}

/**
 * Matrix that stretches a unit cube from `a` to `b`: local Y runs along the
 * member, `width` is across it horizontally and `depth` is the remaining axis.
 */
export function beamMatrix(a: THREE.Vector3, b: THREE.Vector3, width: number, depth: number): THREE.Matrix4 {
  const along = new THREE.Vector3().subVectors(b, a);
  const length = along.length();
  along.normalize();
  // Keep the cross-section level: X stays horizontal unless the member is vertical.
  const side = new THREE.Vector3().crossVectors(UP, along);
  if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
  side.normalize();
  const normal = new THREE.Vector3().crossVectors(side, along).normalize();
  const basis = new THREE.Matrix4().makeBasis(side, along, normal);
  const centre = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  return basis.scale(new THREE.Vector3(width, length, depth)).setPosition(centre);
}
