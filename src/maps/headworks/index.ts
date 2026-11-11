import * as THREE from 'three/webgpu';
import type { MapBuildContext } from '../../game/contracts';
import type { MapInstance, SpawnPoint } from '../../world/types';
import type { MapModule } from '../registry';
import { buildBackdrop } from './backdrop';
import { registerColliders } from './colliders';
import { dressGround } from './ground';
import { dressHouses } from './house';
import { Kit } from './kit';
import { buildLights, LIGHTING } from './lighting';
import { buildMachines } from './machines';
import { createMaterials } from './materials';
import { BOUNDS, ENEMY_SPAWNS, HOUSES, PLAYER_SPAWNS, TANK, type Spot } from './plan';
import { buildPlant } from './plant';
import { dressServices } from './services';
import { buildCastWork, buildGround, buildRamps } from './shell';
import { dressBuildings, dressPerimeter, dressWaterworks } from './structures';
import { buildTanks } from './tanks';

const SPAWN_LIFT = 0.05;
const DEG = Math.PI / 180;

const toSpawn = (spot: Spot): SpawnPoint => ({
  position: new THREE.Vector3(spot.x, SPAWN_LIFT, spot.z),
  yaw: spot.yaw * DEG,
});

/**
 * Headworks: a concrete water-treatment station in the mountains on a low
 * winter afternoon. The west team starts behind the control building. Three ways east:
 * the Filter Walk road along the north wall, the Valve Court round the two
 * clarifiers in the middle, and the pump house on the south side. The level
 * is point-symmetric, so the east team's side is the same turned half a turn.
 */
function build(ctx: MapBuildContext): MapInstance {
  const kit = new Kit(ctx);
  const materials = createMaterials(kit);
  registerColliders(ctx.world);

  buildBackdrop(kit, materials);
  buildGround(kit, materials);
  buildCastWork(kit, materials);
  buildRamps(kit, materials);
  buildTanks(kit, materials);
  buildMachines(kit, materials);
  buildPlant(kit, materials);
  dressBuildings(kit, materials);
  dressWaterworks(kit, materials);
  dressHouses(kit, materials);
  dressPerimeter(kit, materials);
  dressGround(kit, materials);
  dressServices(kit, materials);
  buildLights(kit, materials);
  kit.finish();

  const box = (min: readonly [number, number, number], max: readonly [number, number, number]): THREE.Box3 =>
    new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));

  return {
    root: kit.root,
    bounds: box(BOUNDS.min, BOUNDS.max),
    playerSpawns: PLAYER_SPAWNS.map(toSpawn),
    enemySpawns: ENEMY_SPAWNS.map(toSpawn),
    lighting: LIGHTING,
    weather: 'clear',
    reverb: 'industrial',
    ambience: [
      { sound: 'snd-amb-wind', volume: 0.5 },
      { sound: 'snd-amb-industrial', volume: 0.22 },
      { sound: 'snd-loop-water-lap', volume: 0.45, position: new THREE.Vector3(TANK.x, 4, TANK.z), radius: 24 },
      { sound: 'snd-loop-water-lap', volume: 0.45, position: new THREE.Vector3(-TANK.x, 4, -TANK.z), radius: 24 },
      { sound: 'snd-loop-generator', volume: 0.6, position: new THREE.Vector3(-32.6, 1.2, 24.6), radius: 20 },
      { sound: 'snd-loop-generator', volume: 0.6, position: new THREE.Vector3(32.6, 1.2, -24.6), radius: 20 },
    ],
    interiors: HOUSES.map((house) => ({
      box: box([house.x0, 0, house.z0], [house.x1, house.height, house.z1]),
      reverb: 'interior' as const,
      skyLight: 0.25,
    })),
    dispose: () => kit.dispose(),
  };
}

const headworks: MapModule = {
  meta: {
    id: 'headworks',
    name: 'Headworks',
    tagline: 'Mountain water works, low winter sun',
    assets: ['hdri-headworks', 'pbr-headworks-formed', 'pbr-headworks-paving', 'pbr-headworks-road'],
  },
  build,
};

export default headworks;
