import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { seededRandom } from '../../core/random';
import { addCapes } from './capes';
import type { Kit } from './facade';
import { addHouse } from './house';
import { projectUv } from './kit';
import { TERRACE_NORTH, TERRACE_Y } from './layout';
import { cypressTree, scrubBush, stonePineCrown, stonePineTrunk } from './trees';

/** Two more terraces of houses climb the hill behind the town. Nobody can reach them. */
const TIERS = [
  { base: 9.2, z0: -46, z1: -36.5, from: -70, to: 70 },
  { base: 17.4, z0: -59.5, z1: -50, from: -76, to: 76 },
] as const;

const HILL_FOOT = -60;
const HILL_BACK = -215;
const HILL_WIDTH = 560;
const HILL_RISE = 138;
const HILL_TILE = 11;

/** Lone farmhouses on the slope, for scale: [x, z, width, storeys]. */
const FARMS: readonly (readonly [number, number, number, number])[] = [
  [-96, -92, 11, 2],
  [-38, -104, 9, 2],
  [22, -88, 12, 3],
  [74, -112, 10, 2],
  [118, -84, 12, 2],
  [-150, -120, 10, 2],
  [-8, -138, 9, 2],
  [52, -150, 11, 2],
];

function hash(ix: number, iz: number): number {
  const s = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth value noise in 0 - 1 with a fixed lattice, so the hill is the same on every load. */
function noise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const tx = x - ix;
  const tz = z - iz;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash(ix, iz) + (hash(ix + 1, iz) - hash(ix, iz)) * sx;
  const b = hash(ix, iz + 1) + (hash(ix + 1, iz + 1) - hash(ix, iz + 1)) * sx;
  return a + (b - a) * sz;
}

function fbm(x: number, z: number): number {
  return noise(x, z) * 0.5 + noise(x * 2.1, z * 2.1) * 0.27 + noise(x * 4.3, z * 4.3) * 0.15 + noise(x * 8.9, z * 8.9) * 0.08;
}

/**
 * Height of the mountainside. It has to stand about 35 degrees above the
 * horizon from the square, because that is how tall the villa in the sky
 * panorama is, so it climbs steeply: a coast of the Amalfi kind. Gullies run
 * down the fall line and outcrops break the slope so it does not read as one
 * smooth sheet.
 */
function hillHeight(x: number, z: number): number {
  const t = Math.min(1, Math.max(0, (HILL_FOOT - z) / (HILL_FOOT - HILL_BACK)));
  const rise = Math.sin(Math.min(1, t * 1.12) * Math.PI * 0.5) * HILL_RISE;
  const ridge = Math.sin(x * 0.021 + 1.3) * 9 + Math.sin(x * 0.057) * 5 + Math.sin(z * 0.09 + x * 0.03) * 3;
  // A summit to the north-west, where the panorama's tallest building stands.
  const summit = 44 * Math.exp(-(((x + 150) / 95) ** 2));
  // The flanks swing down toward the sea at either end of the bay.
  const flank = Math.max(0, Math.abs(x) - 215) * 0.5;
  const gully = Math.abs(fbm(x * 0.024 + 3.1, z * 0.006) - 0.5) * 2;
  const outcrop = Math.max(0, fbm(x * 0.05 + 9.4, z * 0.05) - 0.55) * 34;
  const relief = (Math.min(gully, 0.35) * 40 - 9 + outcrop + (fbm(x * 0.11, z * 0.11) - 0.5) * 5) * Math.min(1, t * 3);
  return TIERS[1].base - 2 + Math.max(0, rise + (ridge + summit) * Math.min(1, t * 2.5) + relief - flank * t);
}

interface Tree {
  readonly matrix: THREE.Matrix4;
  readonly shade: number;
}

function forest(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, trees: readonly Tree[]): THREE.InstancedMesh | null {
  if (trees.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, trees.length);
  const tint = new THREE.Color();
  trees.forEach((tree, i) => {
    mesh.setMatrixAt(i, tree.matrix);
    mesh.setColorAt(i, tint.setScalar(tree.shade));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // Too far away to reach the sun's shadow map; skipping the shadow pass halves their cost.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.computeBoundingSphere();
  parent.add(mesh);
  return mesh;
}

const scratchQuat = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();

function tree(x: number, y: number, z: number, width: number, height: number, yaw: number, shade: number): Tree {
  return {
    matrix: new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      scratchQuat.setFromEuler(scratchEuler.set(0, yaw, 0)),
      new THREE.Vector3(width, height, width),
    ),
    shade,
  };
}

/**
 * The hill town: stone terraces, sunlit houses and a mountainside of scrub,
 * pine groves and cypresses. It gives the skyline a shape and stands in front
 * of the buildings and trees baked into the sky panorama.
 */
export function addBackdrop(kit: Kit, root: THREE.Object3D): { dispose(): void } {
  const { batch, mats, random, density } = kit;
  const north = TERRACE_NORTH - 11.5;
  batch.span(mats.stone, -84, 84, TERRACE_Y, TIERS[0].base, TIERS[0].z0 - 1.5, north - 2, { tile: 2.6 });
  batch.span(mats.stone, -90, 90, TIERS[0].base, TIERS[1].base, TIERS[1].z0 - 1.5, TIERS[0].z0 - 0.5, { tile: 2.6 });

  for (const tier of TIERS) {
    let x = tier.from + random() * 3;
    while (x < tier.to - 8) {
      const width = 9 + random() * 5;
      const storeys = random() < 0.45 ? 4 : 3;
      addHouse(kit, {
        x0: x,
        x1: x + width,
        z0: tier.z0 + random() * 1.2,
        z1: tier.z1 - random() * 1.5,
        base: tier.base,
        storeys,
        wall: Math.floor(random() * 7),
        paint: Math.floor(random() * 5),
        detail: ['s'],
        collide: false,
        ridge: random() < 0.25 ? 'z' : 'x',
        balconies: 0.15,
      });
      x += width + (random() < 0.3 ? 1.5 + random() * 2 : 0);
    }
  }
  for (const [x, z, width, storeys] of FARMS) {
    addHouse(kit, {
      x0: x,
      x1: x + width,
      z0: z - 8,
      z1: z,
      base: hillHeight(x + width / 2, z + 1) - 0.3,
      storeys,
      wall: Math.floor(random() * 7),
      paint: Math.floor(random() * 5),
      detail: ['s'],
      collide: false,
    });
  }

  // The mountain behind the top terrace.
  const hill = new THREE.PlaneGeometry(HILL_WIDTH, HILL_FOOT - HILL_BACK, 112, 36);
  hill.rotateX(-Math.PI / 2);
  hill.translate(0, 0, (HILL_FOOT + HILL_BACK) / 2);
  const position = hill.getAttribute('position');
  for (let i = 0; i < position.count; i++) position.setY(i, hillHeight(position.getX(i), position.getZ(i)));
  hill.computeVertexNormals();
  projectUv(hill, HILL_TILE);
  batch.add(mats.hill, hill);

  const cypresses: Tree[] = [];
  const pines: Tree[] = [];
  const shrubs: Tree[] = [];
  const slopeAt = (x: number, z: number): number => Math.hypot(hillHeight(x + 2, z) - hillHeight(x - 2, z), hillHeight(x, z + 2) - hillHeight(x, z - 2)) / 4;

  // Cypresses between the terrace houses and beside each farmhouse.
  for (const tier of TIERS) {
    for (let x = tier.from; x < tier.to; x += 7 + random() * 12) {
      const height = 9 + random() * 6;
      cypresses.push(tree(x, tier.base, tier.z0 - 0.5 - random() * 2, height * 0.8, height, random() * 6, 0.8 + random() * 0.4));
    }
  }
  for (const [fx, fz, width] of FARMS) {
    const count = 2 + Math.floor(random() * 4);
    for (let i = 0; i < count; i++) {
      const x = fx + (random() < 0.5 ? -2 - random() * 6 : width + 2 + random() * 6);
      const z = fz - random() * 9;
      const height = 8 + random() * 7;
      cypresses.push(tree(x, hillHeight(x, z) - 0.5, z, height * 0.8, height, random() * 6, 0.8 + random() * 0.4));
    }
  }

  // Scrub everywhere the ground is not too steep, pines in groves, cypresses in ones and twos.
  const grove2 = seededRandom(0x9147e);
  const attempts = Math.round(6500 * Math.max(0.35, density));
  for (let i = 0; i < attempts; i++) {
    const x = -250 + random() * 500;
    const z = HILL_FOOT - 2 - random() * (HILL_FOOT - HILL_BACK - 8);
    const steep = slopeAt(x, z);
    if (steep > 1.9) continue;
    const y = hillHeight(x, z);
    const grove = fbm(x * 0.017 + 40, z * 0.017 + 7);
    const roll = random();
    if (grove > 0.55 && roll < 0.3) {
      const size = 7 + random() * 6;
      const spread = 0.9 + random() * 0.5;
      const yaw = random() * 6;
      const shade = 0.7 + random() * 0.5;
      // Each draw from the map's stream plants a pair of smaller pines, the second placed from the grove's own stream,
      // so the wood reads as many trees at their true size and nothing placed after the hill moves.
      pines.push(tree(x, y - 0.4, z, size * spread * 0.6, size * 0.66, yaw, shade));
      const nx = x + (grove2() - 0.5) * 16;
      const nz = z + (grove2() - 0.5) * 12;
      if (slopeAt(nx, nz) < 1.9) {
        const small = 4.6 + grove2() * 3.6;
        pines.push(tree(nx, hillHeight(nx, nz) - 0.4, nz, small * (0.85 + grove2() * 0.4), small, grove2() * 6, 0.65 + grove2() * 0.5));
      }
    } else if (roll > 0.985) {
      const height = 9 + random() * 8;
      cypresses.push(tree(x, y - 0.5, z, height * 0.8, height, random() * 6, 0.75 + random() * 0.4));
    } else if (fbm(x * 0.04, z * 0.04 + 20) > 0.42) {
      const size = 1.6 + random() * 3.2;
      shrubs.push(tree(x, y - size * 0.25, z, size * (0.9 + random() * 0.6), size * (0.6 + random() * 0.4), random() * 6, 0.6 + random() * 0.6));
    }
  }

  const cypress = cypressTree();
  const canopy = stonePineCrown();
  const limbs = stonePineTrunk();
  const trunk = mergeGeometries(limbs, false) ?? new THREE.BufferGeometry();
  for (const limb of limbs) limb.dispose();
  const shrub = scrubBush();
  forest(root, cypress, mats.cypress, cypresses);
  forest(root, canopy, mats.pine, pines);
  forest(root, trunk, mats.planksShade, pines);
  forest(root, shrub, mats.pine, shrubs);

  const capes = addCapes(kit, root);

  return {
    dispose: () => {
      capes.dispose();
      for (const geometry of [cypress, canopy, trunk, shrub]) geometry.dispose();
    },
  };
}
