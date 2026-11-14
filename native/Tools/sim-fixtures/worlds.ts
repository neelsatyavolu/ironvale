/**
 * Collision worlds for the sim fixtures, built with the real TypeScript CollisionWorld:
 *  - the small test worlds of tests/weapons/*.test.ts and a box world for PlayerController, exported
 *    as triangle soups so the Swift tests build the very same geometry;
 *  - each map, rebuilt from its exported collision.bin / boundary.bin (native/MapPackages), which hold
 *    the triangles in registration order, so the TS world here equals the one the map's build() made.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BoxGeometry, BufferAttribute, BufferGeometry, Matrix4, PlaneGeometry } from 'three/webgpu';
import type { MeshBVH } from 'three-mesh-bvh';
import { CollisionWorld } from '../../../src/world/collision';
import type { Surface } from '../../../src/world/types';

export const SURFACES: readonly Surface[] = [
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
];

export interface ExportedWorld {
  /** xyz per vertex, three vertices per triangle, registration order. */
  readonly triangles: number[];
  /** Surface index per triangle. */
  readonly surfaces: number[];
}

interface Internals {
  bvh: MeshBVH | null;
  surfaceAttr: BufferAttribute | null;
}

/** The triangle soup and per-triangle surfaces a built world holds. */
export function exportWorld(world: CollisionWorld): ExportedWorld {
  const internals = world as unknown as Internals;
  const positions = internals.bvh!.geometry.getAttribute('position').array as Float32Array;
  const perVertex = internals.surfaceAttr!.array as Uint8Array;
  const surfaces: number[] = [];
  for (let v = 0; v < perVertex.length; v += 3) surfaces.push(perVertex[v]!);
  return { triangles: Array.from(positions), surfaces };
}

type Piece = readonly [geometry: BufferGeometry, matrix: Matrix4, surface: Surface];

function build(pieces: readonly Piece[]): CollisionWorld {
  const world = new CollisionWorld();
  for (const [geometry, matrix, surface] of pieces) world.addCollider(geometry, matrix, surface);
  world.build();
  return world;
}

function ground(size: number): BufferGeometry {
  const plane = new PlaneGeometry(size, size);
  plane.rotateX(-Math.PI / 2);
  return plane;
}

const at = (x: number, y: number, z: number) => new Matrix4().makeTranslation(x, y, z);

/** tests/weapons/grenade-math.test.ts: 200 m ground, 3 m metal wall at z = -5. */
export function grenadeMathWorld(): CollisionWorld {
  return build([
    [ground(200), new Matrix4(), 'concrete'],
    [new BoxGeometry(10, 3, 0.4), at(0, 1.5, -5), 'metal'],
  ]);
}

/** tests/weapons/grenades.test.ts: the same layout, all concrete. */
export function grenadesWorld(): CollisionWorld {
  return build([
    [ground(200), new Matrix4(), 'concrete'],
    [new BoxGeometry(10, 3, 0.4), at(0, 1.5, -5), 'concrete'],
  ]);
}

/**
 * PlayerController box world: ground, a wall, a kerb to step over, a crate to jump on, a low roof
 * to crouch under, and a ramp; the interior zone covers the roofed bay.
 */
export function boxWorld(): CollisionWorld {
  const ramp = new BoxGeometry(4, 0.3, 8);
  ramp.rotateX(-0.32);
  return build([
    [ground(120), new Matrix4(), 'dirt'],
    [new BoxGeometry(12, 3, 0.4), at(0, 1.5, -8), 'metal'],
    [new BoxGeometry(3, 0.15, 3), at(6, 0.075, 0), 'wood'],
    [new BoxGeometry(2, 0.9, 2), at(-6, 0.45, -2), 'wood'],
    [new BoxGeometry(4, 0.3, 4), at(0, 1.45, 6), 'concrete'],
    [new BoxGeometry(0.4, 1.3, 4), at(-2.2, 0.65, 6), 'plaster'],
    [new BoxGeometry(0.4, 1.3, 4), at(2.2, 0.65, 6), 'plaster'],
    [ramp, at(12, 1.2, 4), 'concrete'],
  ]);
}

export const BOX_INTERIOR = { min: [-2, 0, 4], max: [2, 1.3, 8] };

function readTriangles(data: Buffer, magic: string, withSurfaces: boolean): { positions: Float32Array; surfaces: Uint8Array } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.subarray(0, 4).toString('ascii') !== magic) throw new Error(`expected ${magic}`);
  if (view.getUint32(4, true) !== 1) throw new Error(`${magic}: unsupported version`);
  const count = view.getUint32(8, true);
  const positions = new Float32Array(count * 9);
  for (let i = 0; i < positions.length; i++) positions[i] = view.getFloat32(16 + i * 4, true);
  const surfaces = withSurfaces ? Uint8Array.from(data.subarray(16 + count * 36, 16 + count * 36 + count)) : new Uint8Array();
  return { positions, surfaces };
}

function soup(positions: Float32Array): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return geometry;
}

/** The TS CollisionWorld for an exported map package. */
export function mapWorld(repoRoot: string, mapId: string): CollisionWorld {
  const dir = resolve(repoRoot, 'native/MapPackages', mapId);
  const main = readTriangles(readFileSync(resolve(dir, 'collision.bin')), 'IVC1', true);
  const boundary = readTriangles(readFileSync(resolve(dir, 'boundary.bin')), 'IVB1', false);
  const world = new CollisionWorld();
  const identity = new Matrix4();
  // One collider per run of triangles with the same surface, in order: the merged soup is identical.
  let start = 0;
  const count = main.surfaces.length;
  for (let t = 1; t <= count; t++) {
    if (t < count && main.surfaces[t] === main.surfaces[start]) continue;
    world.addCollider(soup(main.positions.slice(start * 9, t * 9)), identity, SURFACES[main.surfaces[start]!]!);
    start = t;
  }
  if (boundary.positions.length > 0) world.addBoundary(soup(boundary.positions), identity);
  world.build();
  return world;
}
