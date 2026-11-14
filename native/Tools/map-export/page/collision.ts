// Captures the collision world a map build() produced, in the map package binary layout that
// native/IronvaleKit/Sources/IronvaleWorld/MapPackageFormat.swift reads.
//
// collision.bin  "IVC1" u32 version=1, u32 triangleCount, u32 0,
//                f32 xyz * 3 * triangleCount (original registration order),
//                u8 surface index per triangle (CollisionWorld SURFACES order), zero padding to 4.
// boundary.bin   "IVB1" u32 version=1, u32 triangleCount, u32 0, f32 xyz * 3 * triangleCount.
// bvh.bin        "IVT1" u32 version=1, u32 treeCount=2, u32 0, then per tree (main, boundary):
//                u32 present, u32 indexCount, u32 nodeByteLength, u32 0,
//                u32 index[indexCount] (MeshBVH reordered index), node bytes (MeshBVH.serialize root 0).
import { MeshBVH } from 'three-mesh-bvh';
import type { BufferAttribute } from 'three/webgpu';
import type { CollisionWorld } from '../../../../src/world/collision';
import { ByteWriter } from './io';

export const SURFACES = [
  'concrete',
  'cobble',
  'asphalt',
  'gravel',
  'dirt',
  'grass',
  'sand',
  'wood',
  'metal',
  'plaster',
  'glass',
  'water',
  'foliage',
  'flesh',
] as const;

interface WorldInternals {
  bvh: MeshBVH | null;
  boundary: MeshBVH | null;
  surfaceAttr: BufferAttribute | null;
}

export interface CollisionFiles {
  readonly collision: Uint8Array;
  readonly boundary: Uint8Array;
  readonly bvh: Uint8Array;
  readonly triangleCount: number;
  readonly boundaryTriangleCount: number;
}

function header(writer: ByteWriter, magic: string, count: number): void {
  writer.ascii(magic);
  writer.u32(1);
  writer.u32(count);
  writer.u32(0);
}

function positionsOf(bvh: MeshBVH): Float32Array {
  const attr = bvh.geometry.getAttribute('position');
  if (!(attr.array instanceof Float32Array) || attr.itemSize !== 3) throw new Error('collision positions must be Float32 xyz');
  return attr.array;
}

function writeTree(writer: ByteWriter, bvh: MeshBVH | null): void {
  if (!bvh) {
    writer.u32(0);
    writer.u32(0);
    writer.u32(0);
    writer.u32(0);
    return;
  }
  const data = MeshBVH.serialize(bvh);
  if (data.roots.length !== 1) throw new Error(`expected one BVH root, got ${data.roots.length}`);
  if (data.indirectBuffer) throw new Error('indirect BVHs are not supported');
  if (!data.index) throw new Error('BVH has no index');
  const index = Uint32Array.from(data.index);
  const root = new Uint8Array(data.roots[0]);
  writer.u32(1);
  writer.u32(index.length);
  writer.u32(root.byteLength);
  writer.u32(0);
  writer.raw(index);
  writer.raw(root);
}

export function captureCollision(world: CollisionWorld): CollisionFiles {
  const internals = world as unknown as WorldInternals;
  const { bvh, boundary, surfaceAttr } = internals;
  if (!bvh || !surfaceAttr) throw new Error('world was not built');

  const positions = positionsOf(bvh);
  const triangleCount = positions.length / 9;
  const surfaces = new Uint8Array(triangleCount);
  for (let t = 0; t < triangleCount; t++) surfaces[t] = surfaceAttr.getX(t * 3);

  const collision = new ByteWriter();
  header(collision, 'IVC1', triangleCount);
  collision.raw(positions);
  collision.raw(surfaces);
  collision.align(4);

  const boundaryPositions = boundary ? positionsOf(boundary) : new Float32Array(0);
  const boundaryWriter = new ByteWriter();
  header(boundaryWriter, 'IVB1', boundaryPositions.length / 9);
  boundaryWriter.raw(boundaryPositions);

  const trees = new ByteWriter();
  header(trees, 'IVT1', 2);
  writeTree(trees, bvh);
  writeTree(trees, boundary);

  return {
    collision: collision.finish(),
    boundary: boundaryWriter.finish(),
    bvh: trees.finish(),
    triangleCount,
    boundaryTriangleCount: boundaryPositions.length / 9,
  };
}
