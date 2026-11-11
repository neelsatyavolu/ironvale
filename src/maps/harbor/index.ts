import * as THREE from 'three/webgpu';
import type { MapBuildContext } from '../../game/contracts';
import type { AmbienceLayer, MapInstance, SpawnPoint } from '../../world/types';
import type { MapModule } from '../registry';
import { addBackdrop } from './backdrop';
import { addBoats } from './boats';
import { addJetties } from './jetties';
import { addBuildings } from './buildings';
import { addRoomDressing } from './cafe';
import { addClutter } from './clutter';
import { addDressing } from './dressing';
import type { Kit } from './facade';
import { addGlow } from './glow';
import { addGreenery } from './greenery';
import { addGround } from './ground';
import { addInteriors, INTERIOR_BOXES } from './interiors';
import { Batch, Colliders } from './kit';
import { BOUNDS, CAFE, ENEMY_SPAWNS, JETTIES, MOLE, PLAYER_SPAWNS, QUAY_EDGE, WATER_Y, type SpawnSpec } from './layout';
import { createBounce, createLamps, LIGHTING } from './lighting';
import { createMaterials, disposeMaterials } from './materials';
import { addProps } from './props';
import { addScatter } from './scatter';
import { addSigns } from './signs';
import { addSky } from './sky';
import { addStreetLife } from './street-life';
import { createSea } from './water';
import { addWires } from './wires';

const ASSETS = [
  'hdri-harbor-venice-sunset',
  'pbr-harbor-cobble',
  'pbr-harbor-plaster-yellow',
  'pbr-harbor-plaster-white',
  'pbr-harbor-stone',
  'pbr-harbor-roof-tiles',
  'pbr-harbor-planks',
  'pbr-harbor-blue-planks',
  'mdl-harbor-barrel',
  'mdl-harbor-crate',
  'mdl-harbor-bench',
] as const;

const toSpawn = (spec: SpawnSpec): SpawnPoint => ({ position: new THREE.Vector3(spec.x, spec.y, spec.z), yaw: spec.yaw });

function ambience(): AmbienceLayer[] {
  const jetty = JETTIES[1]!;
  return [
    { sound: 'snd-amb-harbor', volume: 0.6 },
    { sound: 'snd-amb-wind', volume: 0.16 },
    { sound: 'snd-loop-water-lap', volume: 0.5, position: new THREE.Vector3(jetty.x, WATER_Y, QUAY_EDGE + 12), radius: 24 },
    { sound: 'snd-loop-water-lap', volume: 0.45, position: new THREE.Vector3(JETTIES[0]!.x, WATER_Y, QUAY_EDGE + 8), radius: 20 },
    { sound: 'snd-loop-water-lap', volume: 0.45, position: new THREE.Vector3(MOLE.x1, WATER_Y, MOLE.z1 - 6), radius: 20 },
    { sound: 'snd-loop-water-lap', volume: 0.4, position: new THREE.Vector3(JETTIES[2]!.x, WATER_Y, QUAY_EDGE + 8), radius: 20 },
    { sound: 'snd-loop-metal-creak', volume: 0.3, position: new THREE.Vector3(CAFE.x0 + 0.6, 3.5, CAFE.z1 + 0.6), radius: 10 },
    { sound: 'snd-loop-birds', volume: 0.25, position: new THREE.Vector3(11.3, 18, -24), radius: 45 },
  ];
}

/** Harbor: a small Mediterranean fishing town at golden hour. */
function build(ctx: MapBuildContext): MapInstance {
  const root = new THREE.Group();
  root.name = 'harbor';
  const mats = createMaterials(ctx.assets);
  const kit: Kit = {
    batch: new Batch(),
    colliders: new Colliders(ctx.world),
    mats,
    random: () => ctx.random(),
    density: ctx.detailDensity,
    lanterns: [],
  };

  const sky = addSky(root, ctx.assets);
  const sea = createSea(kit.random);
  root.add(sea.mesh);
  addGround(kit);
  addBuildings(kit);
  const backdrop = addBackdrop(kit, root);
  addJetties(kit);
  const fleet = addBoats(kit, root, ctx.assets);
  const props = addProps(kit, root, ctx.assets);
  const dressing = addDressing(kit, root, sea);
  addStreetLife(kit);
  // Before the glow: the pendants inside register for a pool of light on the floor like any lantern.
  const interiors = addInteriors(kit, root);
  addRoomDressing(kit);
  const glow = addGlow(kit, root);
  addClutter(kit);
  addScatter(kit);
  addGreenery(kit);
  addWires(kit);
  const signs = addSigns(kit);
  const merged = kit.batch.build(root);
  // Netting, lamp glass, leaf cards and the far hill should not throw shadows.
  const shadowless = new Set<THREE.Material>([mats.net, mats.lamp, mats.lampGreen, mats.glassLit, mats.hill, mats.spray]);
  for (const mesh of merged) {
    if (shadowless.has(mesh.material as THREE.Material)) mesh.castShadow = false;
  }
  const lamps = createLamps();
  for (const lamp of lamps) root.add(lamp);
  const bounce = createBounce();
  root.add(bounce);

  return {
    root,
    bounds: new THREE.Box3(
      new THREE.Vector3(BOUNDS.minX, BOUNDS.minY, BOUNDS.minZ),
      new THREE.Vector3(BOUNDS.maxX, BOUNDS.maxY, BOUNDS.maxZ),
    ),
    playerSpawns: PLAYER_SPAWNS.map(toSpawn),
    enemySpawns: ENEMY_SPAWNS.map(toSpawn),
    lighting: LIGHTING,
    weather: 'clear',
    reverb: 'street',
    ambience: ambience(),
    interiors: INTERIOR_BOXES.map(([x0, x1, y0, y1, z0, z1]) => ({
      box: new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)),
      reverb: 'interior' as const,
      // Thick walls and small openings: a third of the sky light gets in.
      skyLight: 0.32,
    })),
    update: (_dt, elapsed) => {
      fleet.update(elapsed);
      interiors.update(elapsed);
    },
    dispose: () => {
      for (const mesh of merged) mesh.geometry.dispose();
      for (const lamp of lamps) lamp.dispose();
      bounce.dispose();
      backdrop.dispose();
      fleet.dispose();
      props.dispose();
      dressing.dispose();
      glow.dispose();
      interiors.dispose();
      signs.dispose();
      sea.dispose();
      sky.dispose();
      disposeMaterials(mats);
    },
  };
}

const harbor: MapModule = {
  meta: { id: 'harbor', name: 'Harbor', tagline: 'Fishing town at golden hour', assets: ASSETS },
  build,
};

export default harbor;
