import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Surface, World } from '../../world/types';

export interface BoxOptions {
  /** Metres covered by one texture repeat. */
  readonly tile?: number;
  /** Rotation about Y, applied after `pitch`. */
  readonly yaw?: number;
  /** Rotation about X. */
  readonly pitch?: number;
  /** Rotation about Z, applied before `pitch`. */
  readonly roll?: number;
  /** Swap U and V, to turn a plank or tile texture by 90 degrees. */
  readonly swap?: boolean;
}

/**
 * Box-projects UVs from positions: each face is mapped along its dominant
 * axis in metres, so neighbouring pieces of one wall share a continuous
 * texture without visible seams.
 */
export function projectUv(geometry: THREE.BufferGeometry, tile: number, swap = false): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const ax = Math.abs(normal.getX(i));
    const ay = Math.abs(normal.getY(i));
    const az = Math.abs(normal.getZ(i));
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) {
      u = position.getX(i);
      v = -position.getZ(i);
    } else if (ax >= az) {
      u = position.getZ(i);
      v = position.getY(i);
    } else {
      u = position.getX(i);
      v = position.getY(i);
    }
    uv[i * 2] = (swap ? v : u) / tile;
    uv[i * 2 + 1] = (swap ? u : v) / tile;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Strips a geometry to position, normal and uv, non-indexed, so any two can be merged. */
function normalise(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') flat.deleteAttribute(name);
  }
  if (!flat.getAttribute('normal')) flat.computeVertexNormals();
  if (!flat.getAttribute('uv')) projectUv(flat, 2);
  flat.morphAttributes = {};
  return flat;
}

const scratchMatrix = new THREE.Matrix4();
const scratchEuler = new THREE.Euler();
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();

/**
 * Collects static geometry per material and merges it into one mesh per
 * material, which keeps the whole town to a few dozen draw calls.
 */
export class Batch {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();

  /** Add a geometry that is already in world space. The batch takes ownership. */
  add(material: THREE.Material, geometry: THREE.BufferGeometry): void {
    const list = this.parts.get(material);
    const ready = normalise(geometry);
    if (list) list.push(ready);
    else this.parts.set(material, [ready]);
  }

  /**
   * Add a geometry authored around the origin, placed with a position and yaw.
   * Pass `tile` to re-project its UVs in world space once it is placed.
   */
  place(
    material: THREE.Material,
    geometry: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    yaw = 0,
    scale = 1,
    tile?: number,
  ): void {
    const copy = geometry.clone();
    scratchMatrix.compose(
      scratchPos.set(x, y, z),
      scratchQuat.setFromEuler(scratchEuler.set(0, yaw, 0)),
      scratchScale.setScalar(scale),
    );
    copy.applyMatrix4(scratchMatrix);
    if (tile !== undefined) projectUv(copy, tile);
    this.add(material, copy);
  }

  /** Box given by size and centre. Rotated boxes keep UVs in their own frame. */
  box(
    material: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    options: BoxOptions = {},
  ): void {
    const geometry = new THREE.BoxGeometry(w, h, d);
    const tile = options.tile ?? 2;
    const rotated = options.yaw !== undefined || options.pitch !== undefined || options.roll !== undefined;
    if (rotated) {
      projectUv(geometry, tile, options.swap);
      scratchEuler.set(options.pitch ?? 0, options.yaw ?? 0, options.roll ?? 0, 'YXZ');
      scratchMatrix.compose(scratchPos.set(x, y, z), scratchQuat.setFromEuler(scratchEuler), scratchScale.setScalar(1));
      geometry.applyMatrix4(scratchMatrix);
    } else {
      geometry.translate(x, y, z);
      projectUv(geometry, tile, options.swap);
    }
    this.add(material, geometry);
  }

  /** Axis-aligned box given by its extents. */
  span(
    material: THREE.Material,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    options: BoxOptions = {},
  ): void {
    this.box(material, x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, options);
  }

  /** Merge everything and attach one mesh per material to `parent`. */
  build(parent: THREE.Object3D, castShadow = true): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [material, geometries] of this.parts) {
      const merged = mergeGeometries(geometries, false);
      for (const geometry of geometries) geometry.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.parts.clear();
    return meshes;
  }
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/** Registers box colliders and sloped walkable quads on the collision world. */
export class Colliders {
  constructor(private readonly world: World) {}

  span(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, surface: Surface): void {
    this.box(x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, surface);
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, surface: Surface, yaw = 0): void {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
      new THREE.Vector3(w, h, d),
    );
    this.world.addCollider(UNIT_BOX, matrix, surface);
  }

  /** Invisible limit of the playable area: stops bodies, lets bullets and sight lines through. */
  boundary(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
      new THREE.Quaternion(),
      new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0),
    );
    this.world.addBoundary(UNIT_BOX, matrix);
  }

  /** Any geometry authored around the origin (cylinders for round props), moved to a position. */
  shape(geometry: THREE.BufferGeometry, x: number, y: number, z: number, surface: Surface): void {
    this.world.addCollider(geometry, new THREE.Matrix4().makeTranslation(x, y, z), surface);
  }

  /** Flat or sloped quad from four corners (any winding; the world is double-sided). */
  quad(corners: readonly [number, number, number][], surface: Surface): void {
    const [a, b, c, d] = corners;
    if (!a || !b || !c || !d) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]), 3),
    );
    this.world.addCollider(geometry, new THREE.Matrix4(), surface);
    geometry.dispose();
  }
}

/** Sloped quad with world-projected UVs, for ramps and slipways. */
export function slopedQuad(corners: readonly [number, number, number][], tile: number): THREE.BufferGeometry {
  const [a, b, c, d] = corners;
  const geometry = new THREE.BufferGeometry();
  if (!a || !b || !c || !d) return geometry;
  const positions = new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  projectUv(geometry, tile);
  return geometry;
}

/** One InstancedMesh per mesh inside a glTF scene, sharing its geometry and material. */
export function instanceModel(
  parent: THREE.Object3D,
  model: THREE.Object3D,
  transforms: readonly THREE.Matrix4[],
  castShadow = true,
): void {
  if (transforms.length === 0) return;
  model.updateWorldMatrix(true, true);
  const local = new THREE.Matrix4();
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const instanced = new THREE.InstancedMesh(child.geometry, child.material, transforms.length);
    transforms.forEach((transform, i) => {
      local.multiplyMatrices(transform, child.matrixWorld);
      instanced.setMatrixAt(i, local);
    });
    instanced.instanceMatrix.needsUpdate = true;
    instanced.castShadow = castShadow;
    instanced.receiveShadow = true;
    instanced.computeBoundingSphere();
    parent.add(instanced);
  });
}

/** InstancedMesh from a geometry and a list of transforms. */
export function instanced(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  transforms: readonly THREE.Matrix4[],
): THREE.InstancedMesh | null {
  if (transforms.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
  transforms.forEach((transform, i) => mesh.setMatrixAt(i, transform));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  parent.add(mesh);
  return mesh;
}

export function transform(x: number, y: number, z: number, yaw = 0, scale = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
    new THREE.Vector3(scale, scale, scale),
  );
}

/** Merge geometries authored around the origin into one (for instanced props). */
export function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts.map(normalise), false);
  if (!merged) throw new Error('Harbor: could not merge prop geometry');
  return merged;
}

/**
 * Net hung from a rail by its top edge: it sags between the ends and billows
 * more toward the foot. Centred on the origin, facing +Z.
 */
export function drapedNet(width: number, height: number, sag: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(width, height, 14, 6);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const u = position.getX(i) / width + 0.5;
    const down = 0.5 - position.getY(i) / height;
    const droop = Math.sin(u * Math.PI) * sag;
    position.setY(i, position.getY(i) - droop * (0.4 + 0.6 * down));
    position.setZ(i, (Math.sin(u * 9.4) * 0.07 + Math.sin(u * 23) * 0.025) * down + droop * 0.25 * down);
  }
  geometry.computeVertexNormals();
  return geometry;
}
