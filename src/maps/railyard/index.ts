import * as THREE from 'three/webgpu';
import type { MapBuildContext } from '../../game/contracts';
import type { MapInstance, SpawnPoint } from '../../world/types';
import type { MapModule } from '../registry';
import { Clutter } from './clutter';
import { buildContainers } from './containers';
import { buildQuayCrane, buildYardGantry, RTG } from './cranes';
import { dressDetails, dressYard, scatterDetail } from './dressing';
import { dressPlant } from './extras';
import { dressPerimeter, dressWarehouse } from './facades';
import { Kit } from './kit';
import { buildGround, buildPerimeter, buildQuay } from './layout';
import { beaconLit, buildLights, flickerLevel, LIGHTING } from './lighting';
import { buildMarkings } from './markings';
import { createMaterials } from './materials';
import { buildOffice } from './office';
import { BOUNDS, ENEMY_SPAWNS, OFFICE, PLAYER_SPAWNS, planContainers, WAREHOUSE, YARD, type SpawnSpot } from './plan';
import { Props } from './props';
import { buildBoxcar, buildFlatcar, buildTracks, buildWagonRamp, WAGONS } from './rail';
import { buildShip } from './ship';
import { buildSky } from './sky';
import { buildTrailer } from './trailer';
import { buildMezzanine, buildRacking, buildWarehouseShell } from './warehouse';

const SPAWN_LIFT = 0.05;
const DEG = Math.PI / 180;

const toSpawn = (spot: SpawnSpot): SpawnPoint => ({
  position: new THREE.Vector3(spot.x, SPAWN_LIFT, spot.z),
  yaw: spot.yaw * DEG,
});

/**
 * Railyard: a container and rail freight yard in steady rain at dusk. Players
 * start at the south gate; the quay, the ship and the low sun are to the north.
 * Three ways up the map: through the warehouse on the west, the container
 * lanes in the middle and the tracks on the east.
 */
function build(ctx: MapBuildContext): MapInstance {
  const kit = new Kit(ctx);
  const materials = createMaterials(kit);
  const props = new Props(kit, materials);
  const clutter = new Clutter(kit, materials);
  // Planned first so the container layout never depends on how much random the dressing uses.
  const containers = planContainers(ctx.random);

  buildSky(kit);
  buildGround(kit, materials);
  buildPerimeter(kit, materials);
  buildQuay(kit, materials);
  buildMarkings(kit, materials, containers);
  buildContainers(kit, materials, containers);

  buildWarehouseShell(kit, materials);
  buildMezzanine(kit, materials);
  buildRacking(kit, materials, props);
  buildOffice(kit, materials);

  buildTracks(kit, materials);
  buildFlatcar(kit, materials, WAGONS.flatA.x, WAGONS.flatA.z, WAGONS.flatA.length, 0x3d4f45);
  buildFlatcar(kit, materials, WAGONS.flatB.x, WAGONS.flatB.z, WAGONS.flatB.length, 0x4a3f38);
  buildBoxcar(kit, materials, WAGONS.boxcar.x, WAGONS.boxcar.z, WAGONS.boxcar.length, 0x7a4630);
  buildWagonRamp(kit, materials);

  buildYardGantry(kit, materials);
  buildQuayCrane(kit, materials);
  buildShip(kit, materials);

  buildTrailer(kit, materials);

  dressYard(props);
  dressDetails(clutter);
  dressWarehouse(kit, materials, clutter);
  dressPerimeter(kit, materials, clutter);
  dressPlant(kit, materials, clutter);
  const lights = buildLights(kit, materials);
  scatterDetail(kit, materials);
  props.flush();
  kit.finish();

  const box = (min: readonly [number, number, number], max: readonly [number, number, number]): THREE.Box3 =>
    new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));

  return {
    root: kit.root,
    bounds: box(BOUNDS.min, BOUNDS.max),
    playerSpawns: PLAYER_SPAWNS.map(toSpawn),
    enemySpawns: ENEMY_SPAWNS.map(toSpawn),
    lighting: LIGHTING,
    weather: 'rain',
    reverb: 'industrial',
    ambience: [
      { sound: 'snd-amb-rain', volume: 0.6 },
      { sound: 'snd-amb-harbor', volume: 0.45 },
      { sound: 'snd-amb-industrial', volume: 0.28 },
      { sound: 'snd-loop-generator', volume: 0.7, position: new THREE.Vector3(40.2, 0.8, 21.6), radius: 22 },
      { sound: 'snd-loop-generator', volume: 0.55, position: new THREE.Vector3(-38.5, 0.8, -43), radius: 18 },
      { sound: 'snd-loop-water-lap', volume: 0.6, position: new THREE.Vector3(2, -1.5, YARD.quay - 1), radius: 30 },
      { sound: 'snd-loop-metal-creak', volume: 0.5, position: new THREE.Vector3(RTG.trolleyX, 11, 6), radius: 28 },
    ],
    interiors: [
      { box: box([WAREHOUSE.west, 0, WAREHOUSE.north], [WAREHOUSE.east, WAREHOUSE.ridge, WAREHOUSE.south]), reverb: 'industrial', skyLight: 0.22 },
      { box: box([OFFICE.west, 0, OFFICE.north], [OFFICE.east, OFFICE.height, OFFICE.south]), reverb: 'interior', skyLight: 0.28 },
    ],
    update: (_dt, elapsed) => {
      lights.flicker.intensity = lights.flickerBase * flickerLevel(elapsed);
      lights.beacons.visible = beaconLit(elapsed);
    },
    dispose: () => kit.dispose(),
  };
}

const railyard: MapModule = {
  meta: {
    id: 'railyard',
    name: 'Railyard',
    tagline: 'Container yard in the rain at dusk',
    assets: [
      'hdri-railyard',
      'pbr-railyard-asphalt',
      'pbr-railyard-concrete',
      'pbr-railyard-container',
      'pbr-railyard-cladding',
      'pbr-railyard-wall',
      'pbr-railyard-ballast',
      'mdl-railyard-barrel',
      'mdl-railyard-barrel-rusty',
      'mdl-railyard-barrier',
      'mdl-railyard-propane',
    ],
  },
  build,
};

export default railyard;
