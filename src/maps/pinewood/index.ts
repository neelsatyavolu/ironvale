import * as THREE from 'three/webgpu';
import { seededRandom } from '../../core/random';
import type { MapBuildContext } from '../../game/contracts';
import type { InteriorZone, MapInstance, SpawnPoint } from '../../world/types';
import type { MapModule } from '../registry';
import { buildCabin, CABIN_LAMP } from './cabin';
import { buildGroundCover } from './cover';
import { Batch, Kit, transform, type Vec3 } from './kit';
import {
  CABIN,
  ENEMY_SPAWNS,
  FIRE_PIT,
  Heightfield,
  PADS,
  PLAY,
  PLAYER_SPAWNS,
  SHED,
  STAND,
  TRAIL,
  TRAILER,
  WALL_OFFSET,
  distanceToPath,
  pathAtZ,
  rectKeepOuts,
  type KeepOut,
  type SpawnSpec,
} from './layout';
import { buildLights, createAmbience, createLighting, type LampSpec } from './lighting';
import { createMaterials, type PinewoodMaterials } from './materials';
import { buildBoulders, buildPebbles, handPlacedBoulders, scatterBoulders, stoneGeometry } from './rocks';
import { buildShafts } from './shafts';
import { buildStand } from './stand';
import { addBoundaryWalls, addTerrainColliders, buildTerrainMesh } from './terrain';
import { buildTrailer } from './trailer';
import { buildForest } from './trees';
import { buildChoppingBlock, buildFirePit, buildYardProps, buildLog, buildShed, buildStoneWall, buildStump, buildWoodpile, FIRE_GLOW, SHED_LAMP } from './yard';

const ASSETS = [
  'hdri-pinewood-sky',
  'pbr-pinewood-ground',
  'pbr-pinewood-trail',
  'pbr-pinewood-rock',
  'pbr-pinewood-bark',
  'pbr-pinewood-stone',
  'pbr-pinewood-planks',
  'mdl-pinewood-rocks',
  'mdl-pinewood-fern',
  'tex-pinewood-fern-alpha',
  'tex-pinewood-grass',
  'tex-pinewood-grass-alpha',
] as const;

/** Low stone walls: [x, z, yaw, length, which end has tumbled]. Local +X runs along the wall. */
const STONE_WALLS: readonly (readonly [number, number, number, number, 'start' | 'end' | 'none'])[] = [
  [-10.5, 4.6, 0.06, 4.8, 'end'],
  [-2.2, -8.2, -Math.PI / 2 - 0.12, 3.8, 'end'],
  [-19.6, 1.6, Math.PI / 2 + 0.18, 4.0, 'start'],
  [6.2, -15.8, 0.55, 5.0, 'end'],
  [-14.5, 10.4, -0.14, 5.4, 'start'],
  [12.5, 21.5, 1.1, 4.2, 'end'],
];

/** Stumps left where the cabin's builders felled trees: [x, z, radius, height]. */
const STUMPS: readonly (readonly [number, number, number, number])[] = [
  [-9.6, 7.4, 0.34, 0.55],
  [-17.2, 4.4, 0.3, 0.4],
  [-18.4, -11.4, 0.36, 0.62],
  [-6.2, -19.2, 0.28, 0.45],
  [-1.2, 5.6, 0.3, 0.5],
  [2.6, -4.4, 0.33, 0.48],
  [-12.6, -20.6, 0.3, 0.7],
  [9.4, 2.2, 0.36, 0.52],
  [-21.5, 9.5, 0.27, 0.42],
];

/** Fallen trunks: [x1, z1, x2, z2, radius]. */
const LOGS: readonly (readonly [number, number, number, number, number])[] = [
  [8.6, 12.8, 15.6, 10.2, 0.34],
  [-13.2, 25, -6.6, 28.6, 0.38],
  [10.2, -22.4, 17.6, -24.8, 0.32],
  [-32.5, -16.4, -24.6, -19.6, 0.38],
  [-20.2, 36.2, -13.4, 33, 0.32],
  [23.6, 37.6, 31.2, 41, 0.36],
  [33.2, -20.4, 40.6, -17.4, 0.34],
  [-10.4, -38.2, -3.6, -36.4, 0.36],
  [22.4, -36, 27.6, -41.2, 0.32],
  [-44.2, 3.6, -39.4, 9, 0.3],
  [-1.5, 54.4, 11.5, 53.6, 0.42],
  [0.5, -54.2, 12.5, -54.9, 0.42],
  [-41.5, 54.6, -32.5, 54, 0.36],
  [-31.5, -54.6, -22, -54.2, 0.36],
];

function lineKeepOuts(x1: number, z1: number, x2: number, z2: number, radius: number): KeepOut[] {
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1) / radius));
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: x1 + ((x2 - x1) * i) / steps,
    z: z1 + ((z2 - z1) * i) / steps,
    radius,
  }));
}

interface Structures {
  readonly keepOuts: KeepOut[];
  /** Where only trees are kept out, so a sight line stays open without leaving a bare strip on the ground. */
  readonly treeFree: KeepOut[];
  readonly interiors: InteriorZone[];
  readonly lamps: LampSpec[];
  readonly shedLamp: THREE.Vector3;
}

/** Everything built by hand: cabin, shed, stand, trailer, yard dressing, walls, stumps and logs. */
function buildStructures(ctx: MapBuildContext, field: Heightfield, batch: Batch, m: PinewoodMaterials, random: () => number): Structures {
  const kitAt = (x: number, z: number, yaw = 0, y = field.sample(x, z)): Kit => new Kit(batch, ctx.world, transform([x, y, z], [0, yaw, 0]));
  const keepOuts: KeepOut[] = [];
  const interiors: InteriorZone[] = [];
  const zone = (kit: Kit, box: THREE.Box3): void => {
    const world = new THREE.Box3().setFromPoints([kit.point(box.min.toArray() as Vec3), kit.point(box.max.toArray() as Vec3)]);
    interiors.push({ box: world, reverb: 'interior' });
  };

  const cabinKit = kitAt(CABIN.x, CABIN.z, 0, PADS.cabin.height);
  zone(cabinKit, buildCabin(cabinKit, m).room);
  keepOuts.push(...rectKeepOuts(PADS.cabin, 0.9));
  // Rubble where the north-west corner came down.
  const rubble = stoneGeometry(random, 517);
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  for (let i = 0; i < 18; i++) {
    const s = 0.09 + random() * 0.13;
    euler.set(random() * 3, random() * 6, random() * 3);
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(-2.6 + (random() - 0.5) * 2.6, s * 0.4 + (random() < 0.3 ? 0.1 : 0), -3.1 + (random() - 0.5) * 2.4),
      quat.setFromEuler(euler),
      new THREE.Vector3(s * 1.3, s * 0.8, s),
    );
    cabinKit.geo(m.rock, rubble.clone(), local);
  }
  // Loose stones along the broken wall tops, so the ruin does not end in clean steps: [x0, z0, x1, z1, top].
  const broken: readonly (readonly [number, number, number, number, number])[] = [
    [-3.48, -2.05, -3.48, -1.5, 1.55],
    [-3.48, -2.7, -3.48, -2.05, 0.75],
    [-1.5, -2.48, -1.0, -2.48, 1.3],
    [-1.0, -2.48, -0.4, -2.48, 2.0],
    [3.48, -1.5, 3.48, -0.7, 3.15],
    [3.48, 0.2, 3.48, 0.5, 3.15],
    [3.48, -0.7, 3.48, 0.2, 3.55],
  ];
  for (const [x0, z0, x1, z1, top] of broken) {
    const count = Math.ceil(Math.hypot(x1 - x0, z1 - z0) * 5);
    for (let i = 0; i < count; i++) {
      const s = 0.08 + random() * 0.09;
      const t = (i + random()) / count;
      euler.set(random() * 0.5, random() * 6, random() * 0.5);
      const local = new THREE.Matrix4().compose(
        new THREE.Vector3(x0 + (x1 - x0) * t + (random() - 0.5) * 0.3, top + s * 0.3, z0 + (z1 - z0) * t + (random() - 0.5) * 0.3),
        quat.setFromEuler(euler),
        new THREE.Vector3(s * 1.5, s * 0.8, s * 1.2),
      );
      cabinKit.geo(m.rock, rubble.clone(), local);
    }
  }
  rubble.dispose();

  const shedKit = kitAt(SHED.x, SHED.z, 0, PADS.shed.height);
  zone(shedKit, buildShed(shedKit, m, random).room);
  keepOuts.push(...rectKeepOuts(PADS.shed, 0.6));

  const standKit = kitAt(STAND.x, STAND.z, 0, PADS.stand.height);
  zone(standKit, buildStand(standKit, m).blind);
  keepOuts.push(...rectKeepOuts(PADS.stand, 0.4));
  // No trunks in the blind's two views: west to the trail and north-west to the cabin yard.
  const treeFree: KeepOut[] = [];
  for (const [toX, toZ] of [
    [-1, 5],
    [FIRE_PIT.x + 4, FIRE_PIT.z - 4],
  ] as const) {
    const steps = Math.ceil(Math.hypot(toX - STAND.x, toZ - STAND.z) / 3.5);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      treeFree.push({ x: STAND.x + (toX - STAND.x) * t, z: STAND.z + (toZ - STAND.z) * t, radius: t < 0.4 ? 4.6 : 3.3 });
    }
  }

  const fireKit = kitAt(FIRE_PIT.x, FIRE_PIT.z);
  buildFirePit(fireKit, m, random);
  keepOuts.push({ x: FIRE_PIT.x, z: FIRE_PIT.z, radius: 2.7 });

  const trail = pathAtZ(TRAIL, TRAILER.z);
  const trailerYaw = trail.yaw + 0.24;
  const trailerKit = kitAt(trail.x + 0.7, trail.z, trailerYaw);
  buildTrailer(trailerKit, m, random);
  const nose = trailerKit.point([0, 0, -2.6]);
  const tail = trailerKit.point([0, 0, 1.8]);
  keepOuts.push(...lineKeepOuts(nose.x, nose.z, tail.x, tail.z, 1.7));

  const pileKit = kitAt(-6.4, -9.4, 1.25);
  buildWoodpile(pileKit, m, random, 3.4);
  keepOuts.push({ x: -6.4, z: -9.4, radius: 2.3 });
  buildChoppingBlock(kitAt(-11.6, -10.8, 0.7), m);
  buildYardProps(kitAt(CABIN.x, CABIN.z, 0, PADS.cabin.height), m);
  keepOuts.push({ x: -11.6, z: -10.8, radius: 1.3 });

  for (const [x, z, yaw, length, tumbled] of STONE_WALLS) {
    const kit = kitAt(x, z, yaw);
    buildStoneWall(kit, m, random, length, tumbled);
    const end = kit.point([length, 0, 0]);
    keepOuts.push(...lineKeepOuts(x, z, end.x, end.z, 0.9));
  }
  for (const [x, z, radius, height] of STUMPS) {
    if (distanceToPath(TRAIL, x, z) < 3) continue;
    buildStump(kitAt(x, z, random() * 6), m, radius, height);
    keepOuts.push({ x, z, radius: radius + 0.6 });
  }
  const worldKit = new Kit(batch, ctx.world, new THREE.Matrix4());
  for (const [x1, z1, x2, z2, radius] of LOGS) {
    buildLog(worldKit, m, field, random, [x1, z1], [x2, z2], radius);
    keepOuts.push(...lineKeepOuts(x1, z1, x2, z2, radius + 0.7));
  }

  const shedLamp = shedKit.point(SHED_LAMP);
  const lamps: LampSpec[] = [
    { position: cabinKit.point(CABIN_LAMP), color: 0xffb066, intensity: 13, distance: 9, flicker: 0.06 },
    { position: shedLamp, color: 0xffb066, intensity: 8, distance: 7, flicker: 0.06 },
    { position: fireKit.point(FIRE_GLOW), color: 0xff6a2a, intensity: 9, distance: 8, flicker: 0.3 },
  ];
  return { keepOuts, treeFree, interiors, lamps, shedLamp };
}

function build(ctx: MapBuildContext): MapInstance {
  // One independent random stream per subsystem, forked in a fixed order. How
  // much ground cover a quality tier draws then cannot shift where anything
  // with a collider ends up, so both network players get the same level.
  const fork = (): (() => number) => seededRandom(Math.floor(ctx.random() * 0xffffffff));
  const streams = {
    materials: fork(),
    structures: fork(),
    boulders: fork(),
    trees: fork(),
    cover: fork(),
    rocks: fork(),
    pebbles: fork(),
    shafts: fork(),
  };
  const root = new THREE.Group();
  const field = new Heightfield();
  const materials = createMaterials(ctx.assets, streams.materials);
  const batch = new Batch();

  const terrain = buildTerrainMesh(field, ctx.assets.pbr('pbr-pinewood-ground'), ctx.assets.pbr('pbr-pinewood-trail'));
  root.add(terrain);
  addTerrainColliders(field, ctx.world);
  addBoundaryWalls(ctx.world);

  const structures = buildStructures(ctx, field, batch, materials, streams.structures);
  const spawnKeepOuts = [...PLAYER_SPAWNS, ...ENEMY_SPAWNS].map((spawn) => ({ x: spawn.x, z: spawn.z, radius: 1.8 }));
  const fixed: KeepOut[] = [...structures.keepOuts, ...spawnKeepOuts];

  const hand = handPlacedBoulders();
  const handKeepOuts = hand.map((b) => ({ x: b.x, z: b.z, radius: Math.max(b.size[0], b.size[2]) }));
  const scattered = scatterBoulders(streams.boulders, [...fixed, ...handKeepOuts], 26);
  const boulders = buildBoulders(field, ctx.world, materials.rock, [...hand, ...scattered], streams.boulders);
  root.add(boulders.root);
  const solid: KeepOut[] = [...fixed, ...boulders.keepOuts];

  const first = PLAYER_SPAWNS[0] as SpawnSpec;
  const forest = buildForest(
    field,
    ctx.world,
    { bark: materials.bark, needles: materials.needles },
    [...solid, ...structures.treeFree],
    streams.trees,
    ctx.detailDensity,
    new THREE.Vector3(first.x, 0, first.z),
  );
  root.add(forest.root);

  const cover = buildGroundCover(ctx.assets, field, ctx.world, materials.bark, solid, forest.trunks, streams.cover, streams.rocks, ctx.detailDensity);
  root.add(cover.root);
  const pebbles = buildPebbles(field, materials.rockBare, streams.pebbles, Math.round(480 * (0.4 + 0.6 * ctx.detailDensity)));
  root.add(pebbles.mesh);

  batch.build(root);
  const lighting = createLighting();
  const shafts = buildShafts(forest.crowns, field, lighting.sunDirection, lighting.sunColor, streams.shafts, Math.round(40 + 60 * ctx.detailDensity));
  root.add(shafts.mesh);
  const lights = buildLights(root, structures.lamps);

  const spawn = (spec: SpawnSpec): SpawnPoint => ({
    position: new THREE.Vector3(spec.x, field.sample(spec.x, spec.z) + 0.05, spec.z),
    yaw: spec.yaw,
  });
  const edge = WALL_OFFSET;
  return {
    root,
    bounds: new THREE.Box3(
      new THREE.Vector3(PLAY.minX - edge, -6, PLAY.minZ - edge),
      new THREE.Vector3(PLAY.maxX + edge, 34, PLAY.maxZ + edge),
    ),
    playerSpawns: PLAYER_SPAWNS.map(spawn),
    enemySpawns: ENEMY_SPAWNS.map(spawn),
    lighting,
    weather: 'mist',
    reverb: 'forest',
    ambience: createAmbience(structures.shedLamp),
    interiors: structures.interiors,
    update: (dt, elapsed) => {
      forest.update(dt);
      lights.update(elapsed);
    },
    dispose: () => {
      root.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
      (terrain.material as THREE.Material).dispose();
      forest.dispose();
      boulders.dispose();
      cover.dispose();
      pebbles.dispose();
      shafts.dispose();
      lights.dispose();
      materials.dispose();
    },
  };
}

const pinewood: MapModule = {
  meta: { id: 'pinewood', name: 'Pinewood', tagline: 'Misty pine forest at dawn', assets: [...ASSETS] },
  build,
};

export default pinewood;
