import * as THREE from 'three/webgpu';
import type { World } from '../../world/types';
import {
  CREEK,
  CREEK_BED_HALF,
  FIELD,
  PLAY,
  TRAIL,
  distanceOutside,
  distanceToPath,
  isKeptOut,
  valueNoise,
  type Heightfield,
  type KeepOut,
} from './layout';
import { SAPLING_SPEC, TREE_SPECS, crownGeometry, trunkGeometry, type TreeSpec } from './tree-geometry';

/** Trees nearer than this get the detailed trunk and the full crown: 24 m at no detail, 38 m at full. */
const nearDistance = (detail: number): number => 24 + 14 * detail;
/** Past this the fog has swallowed a tree and it is not drawn at all. */
const cullDistance = (detail: number): number => 84 + 26 * detail;
/** Below this detail density, trees in the far bucket stop casting shadows. */
const FAR_SHADOW_DETAIL = 0.5;
const SAPLING_CULL = 75;
const REBUCKET_SECONDS = 0.3;
const TREE_COUNT = 880;
const SAPLING_COUNT = 150;
const TREE_MARGIN = 5;
/** Saplings crowd the strip between this rectangle and the boundary bank. */
const INNER = { minX: PLAY.minX + 5, maxX: PLAY.maxX - 5, minZ: PLAY.minZ + 5, maxZ: PLAY.maxZ - 5 };

interface Lod {
  readonly trunk: THREE.InstancedMesh;
  readonly crown: THREE.InstancedMesh | null;
}

interface Species {
  readonly near: Lod;
  readonly far: Lod | null;
  readonly nearRange: number;
  readonly cull: number;
  /** 16 floats per tree. */
  readonly matrices: Float32Array;
  /** RGB per tree for the crown. */
  readonly tints: Float32Array;
  readonly count: number;
}

export interface ForestMaterials {
  readonly bark: THREE.Material;
  readonly needles: THREE.Material;
}

/** A crown as a cone of foliage, for estimating where sunlight gets through. */
export interface Crown {
  readonly x: number;
  readonly z: number;
  /** World height where the crown starts and where the tree ends. */
  readonly bottom: number;
  readonly top: number;
  /** Bough length at the bottom of the crown. */
  readonly reach: number;
}

export interface Forest {
  readonly root: THREE.Group;
  readonly crowns: readonly Crown[];
  /** Trunk positions, for scatter that should avoid or hug trees. */
  readonly trunks: readonly KeepOut[];
  update(dt: number): void;
  dispose(): void;
}

interface Placement {
  readonly x: number;
  readonly z: number;
  readonly species: number;
  readonly scale: number;
  /** Extra vertical stretch on top of `scale`. */
  readonly stretch: number;
}

/** Scatter trunks: clumped inside the play area with clear lanes, a dense wall outside it. */
function placeTrees(random: () => number, keepOuts: readonly KeepOut[]): Placement[] {
  const placed: Placement[] = [];
  const maxAttempts = TREE_COUNT * 40;
  for (let attempt = 0; attempt < maxAttempts && placed.length < TREE_COUNT; attempt++) {
    const x = FIELD.minX + TREE_MARGIN + random() * (FIELD.maxX - FIELD.minX - TREE_MARGIN * 2);
    const z = FIELD.minZ + TREE_MARGIN + random() * (FIELD.maxZ - FIELD.minZ - TREE_MARGIN * 2);
    const species = random() < 0.42 ? 0 : random() < 0.62 ? 1 : 2;
    const scale = 0.8 + random() * 0.42;
    const outside = distanceOutside(PLAY, x, z);
    const inPlay = outside < 0.5;
    if (inPlay) {
      if (random() > 0.3 + 0.7 * valueNoise(x / 19, z / 19, 91)) continue;
      if (distanceToPath(TRAIL, x, z) < 3.3) continue;
      if (distanceToPath(CREEK, x, z) < CREEK_BED_HALF + 2.4) continue;
      if (isKeptOut(keepOuts, x, z, 0.6)) continue;
    } else if (distanceToPath(CREEK, x, z) < CREEK_BED_HALF) continue;
    const spacing = inPlay ? 3.4 : 2.5;
    if (placed.some((other) => (other.x - x) ** 2 + (other.z - z) ** 2 < spacing * spacing)) continue;
    placed.push({ x, z, species, scale, stretch: 0.9 + random() * 0.25 });
  }
  return placed;
}

/** Saplings thicken the boundary and dot the floor away from the routes. */
function placeSaplings(random: () => number, keepOuts: readonly KeepOut[], trees: readonly Placement[], count: number): Placement[] {
  const placed: Placement[] = [];
  for (let attempt = 0; attempt < count * 30 && placed.length < count; attempt++) {
    const x = PLAY.minX - 12 + random() * (PLAY.maxX - PLAY.minX + 24);
    const z = PLAY.minZ - 12 + random() * (PLAY.maxZ - PLAY.minZ + 24);
    const edge = distanceOutside(INNER, x, z) > 0;
    if (!edge && random() > 0.14) continue;
    if (distanceToPath(TRAIL, x, z) < 4.2 || distanceToPath(CREEK, x, z) < CREEK_BED_HALF + 2.6) continue;
    if (isKeptOut(keepOuts, x, z, 1.4)) continue;
    if (trees.some((tree) => (tree.x - x) ** 2 + (tree.z - z) ** 2 < 1.6 * 1.6)) continue;
    if (placed.some((other) => (other.x - x) ** 2 + (other.z - z) ** 2 < 1.8 * 1.8)) continue;
    placed.push({ x, z, species: 0, scale: 0.55 + random() * 0.75, stretch: 0.9 + random() * 0.25 });
  }
  return placed;
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, tinted: boolean): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Instances are re-sorted between LOD meshes, so a cached bounding sphere would be wrong.
  mesh.frustumCulled = false;
  if (tinted) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }
  mesh.count = 0;
  return mesh;
}

function buildSpecies(
  spec: TreeSpec,
  placements: readonly Placement[],
  field: Heightfield,
  materials: ForestMaterials,
  random: () => number,
  twoLods: boolean,
  nearRange: number,
  cull: number,
  farShadows: boolean,
  root: THREE.Group,
): Species {
  const count = placements.length;
  const near: Lod = {
    trunk: instanced(trunkGeometry(spec, twoLods ? 9 : 5, random), materials.bark, count, false),
    crown: instanced(crownGeometry(spec, 1, random), materials.needles, count, true),
  };
  const far: Lod | null = twoLods
    ? {
        trunk: instanced(trunkGeometry(spec, 5, null), materials.bark, count, false),
        crown: instanced(crownGeometry(spec, 0.62, random), materials.needles, count, true),
      }
    : null;

  if (far && !farShadows) {
    far.trunk.castShadow = false;
    if (far.crown) far.crown.castShadow = false;
  }
  for (const lod of [near, far]) {
    if (!lod) continue;
    root.add(lod.trunk);
    if (lod.crown) root.add(lod.crown);
  }

  const matrices = new Float32Array(count * 16);
  const tints = new Float32Array(count * 3);
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  placements.forEach((tree, i) => {
    // A slight lean and an uneven stretch keep repeated geometry from reading as copies.
    euler.set((random() - 0.5) * 0.07, random() * Math.PI * 2, (random() - 0.5) * 0.07);
    quat.setFromEuler(euler);
    pos.set(tree.x, field.sample(tree.x, tree.z) - 0.05, tree.z);
    scale.set(tree.scale, tree.scale * tree.stretch, tree.scale);
    matrix.compose(pos, quat, scale).toArray(matrices, i * 16);
    const shade = 0.72 + random() * 0.4;
    tints.set([shade * (0.9 + random() * 0.2), shade, shade * (0.82 + random() * 0.2)], i * 3);
  });
  return { near, far, nearRange, cull, matrices, tints, count };
}

/** Sort a species' trees into its near and far meshes by distance from the viewer. */
function rebucket(species: Species, placements: readonly Placement[], viewer: THREE.Vector3): void {
  const { near, far, matrices, tints } = species;
  let n = 0;
  let f = 0;
  const nearSq = species.nearRange * species.nearRange;
  const cullSq = species.cull * species.cull;
  for (let i = 0; i < species.count; i++) {
    const tree = placements[i] as Placement;
    const d = (tree.x - viewer.x) ** 2 + (tree.z - viewer.z) ** 2;
    if (d > cullSq) continue;
    const lod = far && d > nearSq ? far : near;
    const slot = lod === near ? n++ : f++;
    (lod.trunk.instanceMatrix.array as Float32Array).set(matrices.subarray(i * 16, i * 16 + 16), slot * 16);
    if (lod.crown) {
      (lod.crown.instanceMatrix.array as Float32Array).set(matrices.subarray(i * 16, i * 16 + 16), slot * 16);
      (lod.crown.instanceColor?.array as Float32Array).set(tints.subarray(i * 3, i * 3 + 3), slot * 3);
    }
  }
  const finish = (lod: Lod | null, count: number): void => {
    if (!lod) return;
    for (const mesh of [lod.trunk, lod.crown]) {
      if (!mesh) continue;
      mesh.count = count;
      mesh.visible = count > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  };
  finish(near, n);
  finish(far, f);
}

export function buildForest(
  field: Heightfield,
  world: World,
  materials: ForestMaterials,
  keepOuts: readonly KeepOut[],
  random: () => number,
  detailDensity: number,
  viewerStart: THREE.Vector3,
): Forest {
  const root = new THREE.Group();
  const trees = placeTrees(random, keepOuts);
  // Saplings hide the foot of the boundary bank, so even the lowest tier keeps most of them.
  const saplings = placeSaplings(random, keepOuts, trees, Math.round(SAPLING_COUNT * (0.7 + 0.3 * detailDensity)));
  const groups = TREE_SPECS.map((_, index) => trees.filter((tree) => tree.species === index));
  const species = TREE_SPECS.map((spec, index) =>
    buildSpecies(
      spec,
      groups[index] as Placement[],
      field,
      materials,
      random,
      true,
      nearDistance(detailDensity),
      cullDistance(detailDensity),
      detailDensity >= FAR_SHADOW_DETAIL,
      root,
    ),
  );
  species.push(buildSpecies(SAPLING_SPEC, saplings, field, materials, random, false, SAPLING_CULL, SAPLING_CULL, true, root));
  const lists: readonly (readonly Placement[])[] = [...groups, saplings];

  // Trunk colliders for every tree a player or a bullet can reach.
  const collider = new THREE.CylinderGeometry(0.8, 1.2, 12, 6, 1, true);
  const matrix = new THREE.Matrix4();
  for (const tree of trees) {
    if (distanceOutside(PLAY, tree.x, tree.z) > 6) continue;
    const radius = (TREE_SPECS[tree.species] as TreeSpec).radius * tree.scale * 1.05;
    matrix.makeScale(radius, 1, radius).setPosition(tree.x, field.sample(tree.x, tree.z) + 5.7, tree.z);
    world.addCollider(collider, matrix, 'wood');
  }
  collider.dispose();

  // The update hook has no camera, so read it from the draw call of one always-visible mesh.
  const viewer = viewerStart.clone();
  const probe = new THREE.Mesh(
    new THREE.PlaneGeometry(0.01, 0.01),
    new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false }),
  );
  probe.frustumCulled = false;
  probe.position.set(0, -50, 0);
  root.add(probe);
  probe.onBeforeRender = (_renderer, _scene, camera) => {
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) viewer.setFromMatrixPosition(camera.matrixWorld);
  };
  const sortAll = (): void => species.forEach((entry, index) => rebucket(entry, lists[index] as Placement[], viewer));
  sortAll();

  const crowns = trees.map((tree): Crown => {
    const spec = TREE_SPECS[tree.species] as TreeSpec;
    const ground = field.sample(tree.x, tree.z);
    const height = spec.height * tree.scale * tree.stretch;
    return { x: tree.x, z: tree.z, bottom: ground + height * spec.crownStart, top: ground + height, reach: spec.branchLength * tree.scale };
  });

  let sinceSort = 0;
  const sortedAt = viewer.clone();
  return {
    root,
    crowns,
    trunks: trees.map((tree) => ({ x: tree.x, z: tree.z, radius: (TREE_SPECS[tree.species] as TreeSpec).radius * tree.scale })),
    update: (dt) => {
      sinceSort += dt;
      if (sinceSort < REBUCKET_SECONDS) return;
      sinceSort = 0;
      // Nothing changes buckets until the viewer has moved a little.
      if (sortedAt.distanceToSquared(viewer) < 1) return;
      sortedAt.copy(viewer);
      sortAll();
    },
    dispose: () => {
      probe.geometry.dispose();
      for (const entry of species) {
        for (const lod of [entry.near, entry.far]) {
          lod?.trunk.geometry.dispose();
          lod?.crown?.geometry.dispose();
          lod?.trunk.dispose();
          lod?.crown?.dispose();
        }
      }
    },
  };
}
