/**
 * Test fixture for the guns-b models: reads a processed gun GLB with
 * gltf-transform and rebuilds its node tree as Three objects (real vertex
 * positions, placeholder materials), so `GunModule.build` can run in Node
 * where GLTFLoader cannot decode textures.
 */
import { NodeIO, type Document, type Node as GltfNode } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as THREE from 'three/webgpu';
import type { Assets } from '../../../src/core/assets';

/** The project has no Node type definitions, so the path comes from the module URL rather than node:path. */
const GUNS = decodeURIComponent(new URL('../../../public/assets/local/guns/', import.meta.url).pathname);

export interface GunFile {
  readonly document: Document;
  /** Size of the GLB when written back out; within a few bytes of the file on disk. */
  readonly bytes: number;
  readonly triangles: number;
  readonly textureTypes: readonly string[];
  readonly textureSizes: readonly number[];
  readonly extensions: readonly string[];
  /** Stands in for `Assets`: `model(id)` returns a clone that shares geometry and materials. */
  readonly assets: Assets;
}

function convert(node: GltfNode, materials: Map<string, THREE.Material>): THREE.Object3D {
  const mesh = node.getMesh();
  let object: THREE.Object3D = new THREE.Object3D();
  if (mesh) {
    const group = new THREE.Group();
    for (const prim of mesh.listPrimitives()) {
      const geometry = new THREE.BufferGeometry();
      const position = prim.getAttribute('POSITION');
      const indices = prim.getIndices();
      if (!position || !indices) throw new Error(`${node.getName()}: primitive without positions or indices`);
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(position.getArray() ?? []), 3));
      geometry.setIndex(new THREE.BufferAttribute(indices.getArray() ?? new Uint16Array(), 1));
      const name = prim.getMaterial()?.getName() ?? 'none';
      const material = materials.get(name) ?? new THREE.MeshStandardMaterial({ name });
      materials.set(name, material);
      group.add(new THREE.Mesh(geometry, material));
    }
    // GLTFLoader gives a single-primitive mesh node the Mesh itself.
    object = group.children.length === 1 ? group.children[0] : group;
  }
  object.name = node.getName();
  object.position.fromArray(node.getTranslation());
  object.quaternion.fromArray(node.getRotation());
  object.scale.fromArray(node.getScale());
  for (const child of node.listChildren()) object.add(convert(child, materials));
  return object;
}

export async function loadGunFile(file: string, assetId: string): Promise<GunFile> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(GUNS + file);
  const root = document.getRoot();
  const scene = new THREE.Group();
  const materials = new Map<string, THREE.Material>();
  for (const node of root.listScenes()[0].listChildren()) scene.add(convert(node, materials));
  const triangles = root
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .reduce((sum, prim) => sum + (prim.getIndices()?.getCount() ?? 0) / 3, 0);
  const assets = {
    model: (id: string) => {
      if (id !== assetId) throw new Error(`unexpected asset id "${id}"`);
      return scene.clone(true);
    },
  } as unknown as Assets;
  return {
    document,
    bytes: (await io.writeBinary(document)).byteLength,
    triangles,
    textureTypes: root.listTextures().map((texture) => texture.getMimeType()),
    textureSizes: root.listTextures().map((texture) => Math.max(...(texture.getSize() ?? [0, 0]))),
    extensions: root.listExtensionsUsed().map((extension) => extension.extensionName),
    assets,
  };
}

/** World-space position of a point given in `object`'s local space. */
export function worldPoint(object: THREE.Object3D, local = new THREE.Vector3()): THREE.Vector3 {
  object.updateWorldMatrix(true, false);
  return local.clone().applyMatrix4(object.matrixWorld);
}

/** World-space direction of one of `object`'s local axes. */
export function worldAxis(object: THREE.Object3D, axis: THREE.Vector3): THREE.Vector3 {
  object.updateWorldMatrix(true, false);
  return axis.clone().transformDirection(object.matrixWorld);
}

/** World-space vertices of every mesh under `root` that passes `pick` (default: all). */
export function worldVertices(root: THREE.Object3D, pick: (mesh: THREE.Mesh) => boolean = () => true): THREE.Vector3[] {
  root.updateWorldMatrix(true, true);
  const points: THREE.Vector3[] = [];
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !pick(node)) return;
    const position = node.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld));
  });
  return points;
}

/** Picks meshes by the name of their (single) material. */
export function withMaterial(name: string): (mesh: THREE.Mesh) => boolean {
  return (mesh) => (mesh.material as THREE.Material).name === name;
}

export function centroid(points: readonly THREE.Vector3[]): THREE.Vector3 {
  if (points.length === 0) throw new Error('No points');
  return points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(points.length);
}

/**
 * World-space points spread over the triangles of every mesh under `root` that
 * passes `pick`: the corners plus a grid inside each face, so long low-poly
 * faces are measured along their whole length rather than only at their ends.
 */
export function surfacePoints(root: THREE.Object3D, pick: (mesh: THREE.Mesh) => boolean = () => true, steps = 8): THREE.Vector3[] {
  root.updateWorldMatrix(true, true);
  const points: THREE.Vector3[] = [];
  const corner = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !pick(node)) return;
    const position = node.geometry.getAttribute('position');
    const index = node.geometry.getIndex();
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i += 3) {
      corner.forEach((point, k) => point.fromBufferAttribute(position, index ? index.getX(i + k) : i + k).applyMatrix4(node.matrixWorld));
      for (let a = 0; a <= steps; a++) {
        for (let b = 0; b <= steps - a; b++) {
          const u = a / steps;
          const v = b / steps;
          points.push(
            new THREE.Vector3()
              .addScaledVector(corner[0], 1 - u - v)
              .addScaledVector(corner[1], u)
              .addScaledVector(corner[2], v),
          );
        }
      }
    }
  });
  return points;
}
