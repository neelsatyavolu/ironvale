import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { World } from '../../world/types';
import { boxProjectUvs } from './kit';
import {
  CREEK,
  CREEK_BED_HALF,
  PLAY,
  TRAIL,
  distanceToPath,
  isKeptOut,
  ridgeEdge,
  valueNoise,
  type Heightfield,
  type KeepOut,
  type Point,
} from './layout';

const VARIANTS = 4;

interface Cut {
  readonly normal: THREE.Vector3;
  readonly offset: number;
}

/** Shape of one boulder variant: lumpy noise plus a few flat fracture planes. */
interface BoulderShape {
  readonly seed: number;
  readonly cuts: readonly Cut[];
}

function shapeBoulder(shape: BoulderShape, detail: number): THREE.BufferGeometry {
  const source = new THREE.IcosahedronGeometry(1, detail);
  source.deleteAttribute('uv');
  source.deleteAttribute('normal');
  const geometry = mergeVertices(source, 1e-4);
  source.dispose();
  const position = geometry.getAttribute('position');
  const p = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i).normalize();
    const lump =
      (valueNoise(p.x * 1.4 + p.y * 1.9, p.z * 1.4 - p.y * 1.3, shape.seed) - 0.5) * 0.5 +
      (valueNoise(p.x * 3.6 - p.y * 2.3, p.z * 3.6 + p.y * 3.1, shape.seed + 7) - 0.5) * 0.2;
    p.multiplyScalar(1 + lump);
    for (const cut of shape.cuts) {
      const over = p.dot(cut.normal) - cut.offset;
      if (over > 0) p.addScaledVector(cut.normal, -over * 0.88);
    }
    position.setXYZ(i, p.x, p.y, p.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function randomShape(random: () => number, seed: number): BoulderShape {
  const cuts: Cut[] = [];
  const count = 4 + Math.floor(random() * 3);
  for (let i = 0; i < count; i++) {
    const normal = new THREE.Vector3(random() - 0.5, random() * 0.9 - 0.15, random() - 0.5).normalize();
    cuts.push({ normal, offset: 0.62 + random() * 0.26 });
  }
  return { seed, cuts };
}

export interface BoulderSpec extends Point {
  /** Half-extents in metres before the boulder is sunk into the ground. */
  readonly size: readonly [number, number, number];
  readonly yaw?: number;
  /** Fraction of the height buried. */
  readonly sink?: number;
}

const big = (x: number, z: number, w: number, h: number, d: number, yaw = 0): BoulderSpec => ({ x, z, size: [w, h, d], yaw });

/**
 * Boulders placed by hand: cover along each route, outcrops on the ridge
 * edge, and rockfalls that close the ends of the trail and the creek.
 */
export function handPlacedBoulders(): readonly BoulderSpec[] {
  const ridge = (z: number, offset: number): number => ridgeEdge(z) + offset;
  return [
    // Rockfall behind the player spawn and at the north end of the trail.
    big(4, 56.5, 3.2, 2.8, 2.6, 0.4), big(8.5, 57.5, 2.6, 2.3, 2.4, 1.2), big(6, 59.5, 3.4, 3.4, 3, 2.1), big(0.5, 58, 2, 1.7, 1.9, 0.7),
    big(5.5, -56.5, 3.1, 2.7, 2.5, 0.9), big(9.5, -57.5, 2.4, 2.2, 2.6, 2.4), big(7, -59.5, 3.4, 3.2, 3, 0.2), big(2, -58, 2.1, 1.8, 2, 1.6),
    // Two outcrops the trail winds between, screening the player spawn from the long view up the trail.
    big(3.4, 45.6, 2.8, 2.3, 1.3, 0.08), big(7.0, 40.4, 3.0, 2.4, 1.4, -0.12),
    // Creek ends.
    big(-37.5, 56.5, 2.8, 2.4, 2.4, 0.5), big(-34.5, 58, 2.2, 2, 2.2, 1.9), big(-40.5, 58.5, 2.4, 2.6, 2.2, 2.6),
    big(-27.5, -56.5, 2.8, 2.5, 2.5, 1.1), big(-24, -58, 2.2, 2.1, 2.3, 0.3), big(-30.5, -58.5, 2.5, 2.4, 2.2, 2.2),
    // Trail side cover, south to north.
    big(9.2, 38.5, 1.5, 1.25, 1.2, 0.6), big(-1.6, 33, 1.3, 1.15, 1.5, 1.4), big(6.3, 24.5, 1.1, 0.95, 1.3, 0.2),
    big(-9, 21, 1.9, 1.5, 1.5, 2.3), big(3.2, 5.5, 1.5, 1.3, 1.2, 0.9), big(4.6, 3.6, 1, 0.8, 0.9, 2.8),
    big(-7.5, -19.5, 1.4, 1.2, 1.7, 0.3), big(1.8, -20, 1.2, 1.3, 1.1, 1.9), big(10.5, -34, 1.8, 1.45, 1.4, 0.8), big(0.6, -41, 1.4, 1.2, 1.5, 2.6),
    // The knoll: a stepped outcrop the player can stand behind or on.
    big(13, -8, 2.6, 1.9, 2.2, 0.5), big(16.2, -10.5, 2.1, 1.5, 1.8, 1.7), big(14.4, -5, 1.5, 1.1, 1.4, 2.9), big(11, -11.5, 1.3, 1, 1.2, 0.1),
    // Ridge edge outcrops: cover for anyone climbing the slope, and ledges on top.
    big(ridge(-36, 0.5), -36, 2.6, 2.2, 2, 0.4), big(ridge(-33, 2.5), -33, 1.9, 1.6, 1.7, 1.3),
    big(ridge(-18, -0.5), -18, 2.2, 1.7, 2.4, 2.2), big(ridge(-15, 2), -15.4, 1.5, 1.3, 1.3, 0.7),
    big(ridge(18, 0), 18, 2.4, 1.9, 2.1, 1), big(ridge(21, 2.4), 21, 1.7, 1.4, 1.6, 2.5),
    big(ridge(36, 0.5), 36, 2.5, 2, 2.2, 0.2), big(ridge(39, 2.6), 39.5, 1.6, 1.3, 1.5, 1.8),
    // Ridge top.
    big(40, -14, 1.7, 1.35, 1.4, 0.6), big(38.5, -30, 1.4, 1.2, 1.6, 2), big(41, 14, 1.8, 1.4, 1.5, 1.2), big(37, 28, 1.3, 1.15, 1.2, 0.3), big(43.5, 44, 2, 1.7, 1.8, 2.7),
    // Creek bed and banks.
    big(-27.6, -36, 1.3, 1, 1.2, 0.5), big(-21.2, -22, 1.5, 1.2, 1.3, 1.7), big(-27.5, -3, 1.2, 0.95, 1.4, 2.4),
    big(-34.8, 13, 1.6, 1.25, 1.3, 0.9), big(-30.2, 30, 1.3, 1.05, 1.2, 2.1), big(-37.6, 41, 1.5, 1.2, 1.5, 0.2),
    // West bank and the north-west corner.
    big(-42, 20, 1.8, 1.5, 1.6, 1.5), big(-18.5, 15.5, 1.6, 1.3, 1.4, 0.4), big(-40, -20, 2, 1.6, 1.7, 2.9), big(-15, -33, 1.7, 1.35, 1.5, 1.1),
    // North centre.
    big(15, -42, 1.9, 1.5, 1.6, 0.7), big(21, -20, 1.5, 1.25, 1.3, 2.2), big(-4, -48, 1.6, 1.3, 1.4, 1.4),
    // South flanks.
    big(-17, 40, 1.9, 1.5, 1.7, 0.8), big(20, 44, 1.7, 1.4, 1.5, 2), big(18, 30, 1.4, 1.2, 1.3, 0.1), big(-22, 47, 1.5, 1.2, 1.4, 2.5),
  ];
}

export interface RockField {
  readonly root: THREE.Group;
  readonly keepOuts: readonly KeepOut[];
  dispose(): void;
}

/** Instanced procedural boulders with matching low-poly colliders. */
export function buildBoulders(
  field: Heightfield,
  world: World,
  material: THREE.Material,
  specs: readonly BoulderSpec[],
  random: () => number,
): RockField {
  const root = new THREE.Group();
  const shapes = Array.from({ length: VARIANTS }, (_, i) => randomShape(random, 101 + i * 13));
  const visual = shapes.map((shape) => boxProjectUvs(shapeBoulder(shape, 4), 1));
  const collision = shapes.map((shape) => shapeBoulder(shape, 2));
  const byVariant: THREE.Matrix4[][] = shapes.map(() => []);
  const keepOuts: KeepOut[] = [];
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();

  for (const spec of specs) {
    const variant = Math.floor(random() * VARIANTS);
    const [w, h, d] = spec.size;
    euler.set((random() - 0.5) * 0.3, spec.yaw ?? random() * Math.PI * 2, (random() - 0.5) * 0.3);
    quat.setFromEuler(euler);
    const y = field.sample(spec.x, spec.z) + h * (1 - 2 * (spec.sink ?? 0.24));
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(spec.x, y, spec.z), quat, new THREE.Vector3(w, h, d));
    (byVariant[variant] as THREE.Matrix4[]).push(matrix);
    world.addCollider(collision[variant] as THREE.BufferGeometry, matrix, 'concrete');
    keepOuts.push({ x: spec.x, z: spec.z, radius: Math.max(w, d) * 0.95 });
  }

  byVariant.forEach((matrices, variant) => {
    if (matrices.length === 0) return;
    const mesh = new THREE.InstancedMesh(visual[variant] as THREE.BufferGeometry, material, matrices.length);
    matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    root.add(mesh);
  });
  for (const geometry of collision) geometry.dispose();
  return { root, keepOuts, dispose: () => visual.forEach((geometry) => geometry.dispose()) };
}

/** Smaller boulders scattered where the hand placement left room. */
export function scatterBoulders(random: () => number, keepOuts: readonly KeepOut[], count: number): BoulderSpec[] {
  const out: BoulderSpec[] = [];
  for (let attempt = 0; attempt < count * 30 && out.length < count; attempt++) {
    const x = PLAY.minX + 2 + random() * (PLAY.maxX - PLAY.minX - 4);
    const z = PLAY.minZ + 2 + random() * (PLAY.maxZ - PLAY.minZ - 4);
    const r = 0.45 + random() * random() * 0.9;
    if (distanceToPath(TRAIL, x, z) < 2.6 + r) continue;
    if (isKeptOut(keepOuts, x, z, r + 1.2)) continue;
    if (isKeptOut(out.map((o) => ({ x: o.x, z: o.z, radius: o.size[0] })), x, z, r + 1)) continue;
    out.push({ x, z, size: [r * (0.85 + random() * 0.4), r * (0.6 + random() * 0.35), r * (0.85 + random() * 0.4)], sink: 0.3 });
  }
  return out;
}

/** Fist-to-head sized stones: thick in the creek bed, sparse on the forest floor. Decoration only. */
export function buildPebbles(
  field: Heightfield,
  material: THREE.Material,
  random: () => number,
  count: number,
): { readonly mesh: THREE.InstancedMesh; dispose(): void } {
  const geometry = boxProjectUvs(shapeBoulder(randomShape(random, 311), 1), 0.6);
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  let placed = 0;
  for (let attempt = 0; attempt < count * 12 && placed < count; attempt++) {
    const inCreek = random() < 0.72;
    let x: number;
    let z: number;
    if (inCreek) {
      const p = CREEK[Math.floor(random() * (CREEK.length - 1))] as Point;
      x = p.x + (random() - 0.5) * (CREEK_BED_HALF * 2 + 3);
      z = p.z + (random() - 0.5) * 3;
    } else {
      x = PLAY.minX + random() * (PLAY.maxX - PLAY.minX);
      z = PLAY.minZ + random() * (PLAY.maxZ - PLAY.minZ);
      if (distanceToPath(TRAIL, x, z) < 1.2) continue;
    }
    if (Math.abs(x) > PLAY.maxX + 4 || Math.abs(z) > PLAY.maxZ + 4) continue;
    const s = inCreek ? 0.07 + random() * random() * 0.3 : 0.06 + random() * 0.12;
    euler.set(random() * 3, random() * 6.3, random() * 3);
    pos.set(x, field.sample(x, z) + s * 0.15, z);
    scale.set(s * (0.8 + random() * 0.6), s * (0.5 + random() * 0.4), s * (0.8 + random() * 0.6));
    mesh.setMatrixAt(placed++, matrix.compose(pos, quat.setFromEuler(euler), scale));
  }
  mesh.count = placed;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return { mesh, dispose: () => geometry.dispose() };
}

/** One small stone (unit radius) for hand-built details such as a fire ring or rubble. */
export function stoneGeometry(random: () => number, seed: number): THREE.BufferGeometry {
  return boxProjectUvs(shapeBoulder(randomShape(random, seed), 2), 0.5);
}
