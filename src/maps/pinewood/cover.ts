import * as THREE from 'three/webgpu';
import type { Assets } from '../../core/assets';
import type { World } from '../../world/types';
import { GRASS_VARIANTS, createGrassMaterial, fallenBranchGeometry, grassTuftGeometry } from './grass';
import { clusterDecimate } from './kit';
import {
  CREEK,
  CREEK_BED_HALF,
  PLAY,
  TRAIL,
  distanceToPath,
  isKeptOut,
  valueNoise,
  type Heightfield,
  type KeepOut,
} from './layout';

const FERN_COUNT = 300;
const GRASS_COUNT = 3600;
const TWIG_COUNT = 320;
const BRANCH_COUNT = 80;
const SCAN_ROCK_COUNT = 22;
/** Scatter is split into square chunks so off-screen ground cover is culled. */
const CHUNK = 54;
/** Ground cover keeps at least this far from the trail's centre line. */
const TRAIL_GAP = 1.9;

export interface GroundCover {
  readonly root: THREE.Group;
  dispose(): void;
}

interface Site {
  readonly x: number;
  readonly z: number;
}

/** Group instance matrices by map chunk and emit one InstancedMesh per chunk. */
function chunked(
  root: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  matrices: readonly THREE.Matrix4[],
  castShadow: boolean,
): void {
  const cells = new Map<string, THREE.Matrix4[]>();
  const p = new THREE.Vector3();
  for (const matrix of matrices) {
    p.setFromMatrixPosition(matrix);
    const key = `${Math.floor(p.x / CHUNK)},${Math.floor(p.z / CHUNK)}`;
    const list = cells.get(key);
    if (list) list.push(matrix);
    else cells.set(key, [matrix]);
  }
  for (const list of cells.values()) {
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    list.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    root.add(mesh);
  }
}

function pickSites(
  random: () => number,
  count: number,
  accept: (x: number, z: number) => boolean,
  margin = 5,
): Site[] {
  const sites: Site[] = [];
  for (let attempt = 0; attempt < count * 25 && sites.length < count; attempt++) {
    const x = PLAY.minX - margin + random() * (PLAY.maxX - PLAY.minX + margin * 2);
    const z = PLAY.minZ - margin + random() * (PLAY.maxZ - PLAY.minZ + margin * 2);
    if (accept(x, z)) sites.push({ x, z });
  }
  return sites;
}

export function buildGroundCover(
  assets: Assets,
  field: Heightfield,
  world: World,
  bark: THREE.Material,
  keepOuts: readonly KeepOut[],
  trunks: readonly KeepOut[],
  random: () => number,
  /** Separate stream for the rocks, which have colliders and must not move with the detail setting. */
  rockRandom: () => number,
  detailDensity: number,
): GroundCover {
  const root = new THREE.Group();
  const owned: { dispose(): void }[] = [];
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const place = (x: number, z: number, lift: number, yaw: number, tilt: number, sx: number, sy = sx, sz = sx): THREE.Matrix4 => {
    euler.set((random() - 0.5) * tilt, yaw, (random() - 0.5) * tilt);
    return matrix.compose(pos.set(x, field.sample(x, z) + lift, z), quat.setFromEuler(euler), scale.set(sx, sy, sz)).clone();
  };
  const offTrail = (x: number, z: number, gap: number): boolean => distanceToPath(TRAIL, x, z) > TRAIL_GAP + gap;

  // Ferns: in clumps, never in the creek bed or on the trail.
  const fernScene = assets.gltf('mdl-pinewood-fern').scene;
  const fernMeshes: THREE.Mesh[] = [];
  fernScene.traverse((child) => {
    if (child instanceof THREE.Mesh) fernMeshes.push(child);
  });
  const fernSource = (fernMeshes[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
  // glTF textures are not flipped vertically; the mask must match them.
  const fernAlpha = assets.texture('tex-pinewood-fern-alpha').clone();
  fernAlpha.flipY = false;
  fernAlpha.colorSpace = THREE.NoColorSpace;
  fernAlpha.needsUpdate = true;
  const fernMaterial = new THREE.MeshStandardNodeMaterial({
    map: fernSource.map,
    normalMap: fernSource.normalMap,
    roughnessMap: fernSource.roughnessMap,
    alphaMap: fernAlpha,
    alphaTest: 0.45,
    side: THREE.DoubleSide,
    color: 0xb9c9a4,
    metalness: 0,
  });
  owned.push(fernAlpha, fernMaterial);
  const fernSites = pickSites(random, Math.round(FERN_COUNT * detailDensity), (x, z) => {
    // Ferns gather at the foot of trees and along the trail's verge, and in loose drifts elsewhere.
    const byTrunk = trunks.some((trunk) => (trunk.x - x) ** 2 + (trunk.z - z) ** 2 < 2.2 * 2.2);
    const verge = distanceToPath(TRAIL, x, z) < TRAIL_GAP + 2.4;
    if (!byTrunk && !verge && valueNoise(x / 9, z / 9, 131) < 0.5 && random() > 0.06) return false;
    if (!offTrail(x, z, 0.5)) return false;
    if (distanceToPath(CREEK, x, z) < CREEK_BED_HALF + 0.6) return false;
    return !isKeptOut(keepOuts, x, z, 0.2);
  });
  const fernMatrices: THREE.Matrix4[][] = fernMeshes.map(() => []);
  for (const site of fernSites) {
    // The two light variants carry most of the count; the dense ones are accents.
    const variant = Math.floor(random() * fernMeshes.length);
    const heavy = ((fernMeshes[variant] as THREE.Mesh).geometry.index?.count ?? 0) > 4000;
    const pick = heavy && random() < 0.85 ? (variant + 2) % fernMeshes.length : variant;
    const s = 1.1 + random() * 1.1;
    (fernMatrices[pick] as THREE.Matrix4[]).push(place(site.x, site.z, 0.02, random() * Math.PI * 2, 0.25, s, s * (0.85 + random() * 0.4), s));
  }
  fernMeshes.forEach((mesh, i) => chunked(root, mesh.geometry, fernMaterial, fernMatrices[i] as THREE.Matrix4[], false));

  // Grass tufts: on the lighter ground beside the trail, in the yard and along the ridge.
  const grass = createGrassMaterial(assets);
  owned.push(grass);
  const grassSites = pickSites(random, Math.round(GRASS_COUNT * detailDensity), (x, z) => {
    const openness = Math.max(0, 1 - distanceToPath(TRAIL, x, z) / 9);
    if (random() > 0.12 + 0.5 * openness + 0.6 * valueNoise(x / 7, z / 7, 151)) return false;
    if (!offTrail(x, z, -0.3)) return false;
    if (distanceToPath(CREEK, x, z) < CREEK_BED_HALF + 0.3) return false;
    return !isKeptOut(keepOuts, x, z, -0.3);
  });
  GRASS_VARIANTS.forEach((clumps, variant) => {
    const geometry = grassTuftGeometry(clumps, random);
    owned.push(geometry);
    const matrices = grassSites
      .filter((_, i) => i % GRASS_VARIANTS.length === variant)
      .map((site) => {
        const s = 0.7 + random() * 0.7;
        return place(site.x, site.z, 0, random() * Math.PI * 2, 0.15, s, s * (0.7 + random() * 0.7), s);
      });
    chunked(root, geometry, grass.material, matrices, false);
  });

  // Fallen twigs and small branches.
  const twigGeometry = new THREE.CylinderGeometry(0.008, 0.02, 1, 5, 1);
  twigGeometry.rotateZ(Math.PI / 2);
  owned.push(twigGeometry);
  const twigSites = pickSites(random, Math.round(TWIG_COUNT * detailDensity), (x, z) => !isKeptOut(keepOuts, x, z, -0.5), 2);
  chunked(
    root,
    twigGeometry,
    bark,
    twigSites.map((site) => place(site.x, site.z, 0.02, random() * Math.PI * 2, 0.15, 0.4 + random() * 1.3, 0.7 + random() * 1.4, 0.7 + random() * 1.4)),
    false,
  );

  // Dead branches shed by the trees, thickest under the crowns.
  const branchGeometry = fallenBranchGeometry(random);
  owned.push(branchGeometry);
  const branchSites = pickSites(random, Math.round(BRANCH_COUNT * detailDensity), (x, z) => offTrail(x, z, 0.4) && !isKeptOut(keepOuts, x, z, 0.3), 3);
  chunked(
    root,
    branchGeometry,
    bark,
    branchSites.map((site) => place(site.x, site.z, 0.025, random() * Math.PI * 2, 0.06, 0.6 + random() * 0.9)),
    false,
  );

  // Scanned mossy rocks: at the foot of trees and in the creek, where the eye rests.
  const rockMeshes: THREE.Mesh[] = [];
  assets.gltf('mdl-pinewood-rocks').scene.traverse((child) => {
    if (child instanceof THREE.Mesh) rockMeshes.push(child);
  });
  const light = [...rockMeshes].sort((a, b) => (a.geometry.index?.count ?? 0) - (b.geometry.index?.count ?? 0)).slice(0, 3);
  const rockMatrices: THREE.Matrix4[][] = light.map(() => []);
  const rockSites = pickSites(rockRandom, SCAN_ROCK_COUNT, (x, z) => {
    if (!offTrail(x, z, 1.2) || isKeptOut(keepOuts, x, z, 1.2)) return false;
    return !trunks.some((trunk) => (trunk.x - x) ** 2 + (trunk.z - z) ** 2 < 1.4 * 1.4);
  }, 0);
  rockSites.forEach((site, i) => {
    const s = 0.24 + rockRandom() * 0.3;
    (rockMatrices[i % light.length] as THREE.Matrix4[]).push(place(site.x, site.z, s * 0.18, rockRandom() * Math.PI * 2, 0, s));
  });
  light.forEach((mesh, i) => {
    const list = rockMatrices[i] as THREE.Matrix4[];
    if (list.length === 0) return;
    // A box four fifths the size of the scan is close enough for a knee-high rock.
    mesh.geometry.computeBoundingBox();
    const size = (mesh.geometry.boundingBox as THREE.Box3).getSize(new THREE.Vector3()).multiplyScalar(0.8);
    const box = new THREE.BoxGeometry(size.x, size.y, size.z);
    for (const m of list) world.addCollider(box, m, 'concrete');
    box.dispose();
    // The scans carry 5 - 11 thousand triangles each; a tenth of that reads the same at this size.
    const slim = clusterDecimate(mesh.geometry, 0.12);
    owned.push(slim);
    const instanced = new THREE.InstancedMesh(slim, mesh.material, list.length);
    list.forEach((m, k) => instanced.setMatrixAt(k, m));
    instanced.castShadow = true;
    instanced.receiveShadow = true;
    instanced.computeBoundingSphere();
    root.add(instanced);
  });

  return { root, dispose: () => owned.forEach((item) => item.dispose()) };
}
