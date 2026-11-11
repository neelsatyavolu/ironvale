import * as THREE from 'three/webgpu';
import type { LightingSetup } from '../../world/types';
import { MeshBuilder } from './builder';
import { RTG } from './cranes';
import { POLE_HEIGHT, POLES, WALL_LAMPS, WARM } from './lamps';
import type { Kit } from './kit';
import type { Materials } from './materials';
import { OFFICE, WAREHOUSE } from './plan';

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/**
 * Sun position measured from the HDRI by scripts/dev/map-railyard-sun.mjs:
 * azimuth 35.96 degrees (atan2(z, x) in the texture), elevation 9.38 degrees.
 * The level wants that sun 6 degrees west of north so it shines down the
 * north-south lanes, so the sky is turned to put it there.
 */
const HDRI_SUN_AZIMUTH = (35.96 * Math.PI) / 180;
const SUN_ELEVATION = (9.38 * Math.PI) / 180;
const SUN_WEST_OF_NORTH = (6 * Math.PI) / 180;

const sunDirection = V(
  -Math.sin(SUN_WEST_OF_NORTH) * Math.cos(SUN_ELEVATION),
  Math.sin(SUN_ELEVATION),
  -Math.cos(SUN_WEST_OF_NORTH) * Math.cos(SUN_ELEVATION),
);

export const LIGHTING: LightingSetup = {
  hdri: 'hdri-railyard',
  // Rotating the sky by r moves a texture direction at azimuth a to a - r.
  hdriRotation: HDRI_SUN_AZIMUTH - Math.atan2(sunDirection.z, sunDirection.x),
  skyIntensity: 0.42,
  sunDirection,
  sunColor: 0xffc694,
  sunIntensity: 5.6,
  // Cool grey rain haze that warms where the sun breaks through under the cloud deck.
  fog: { color: 0x56606b, density: 0.0125, sunTint: 0xd2b190, sunTintStrength: 0.8, heightFalloff: 0.03, baseHeight: 0 },
  exposure: 0.92,
  volumetric: 0.62,
  shaftDensity: 3,
  bloom: 0.8,
};

/** The sun's direction in the sky texture's own frame, before the sky is turned. */
export const SUN_IN_SKY = V(
  Math.cos(SUN_ELEVATION) * Math.cos(HDRI_SUN_AZIMUTH),
  Math.sin(SUN_ELEVATION),
  Math.cos(SUN_ELEVATION) * Math.sin(HDRI_SUN_AZIMUTH),
);

const SHED = 0xffe2c0;
const BEACON_GAIN = 9;
/** Cool fill from the overcast, so shadows read blue-grey against the warm sun. */
const OVERCAST = { sky: 0x7f95b4, ground: 0x2c2f33, intensity: 0.55 } as const;

function buildPole(kit: Kit, m: Materials, x: number, z: number, heading: number): void {
  const mast = new THREE.CylinderGeometry(0.07, 0.13, POLE_HEIGHT, 10);
  kit.add(m.rawSteel, mast, new THREE.Matrix4().makeTranslation(x, POLE_HEIGHT / 2 + 0.5, z), 0x8f9394);
  mast.dispose();
  kit.box(m.wall, 0.7, 0.5, 0.7, x, 0, z, { tile: 2.71, surface: 'concrete' });
  kit.collide(0.3, POLE_HEIGHT, 0.3, x, 0.5, z, 'metal');
  kit.box(m.steel, 0.3, 0.6, 0.2, x + 0.16, 1.2, z, { color: 0x8f9394 });
  // Cross arm with three lamp heads tilted at the yard.
  const dx = Math.sin(heading);
  const dz = Math.cos(heading);
  const top = POLE_HEIGHT + 0.5;
  kit.beam(m.rawSteel, V(x - dz * 1.1, top, z + dx * 1.1), V(x + dz * 1.1, top, z - dx * 1.1), 0.08, 0.08, 0x8f9394);
  for (const offset of [-0.9, 0, 0.9]) {
    const hx = x + dz * offset + dx * 0.18;
    const hz = z - dx * offset + dz * 0.18;
    const pose = kit.transform(hx, top - 0.12, hz, heading).multiply(new THREE.Matrix4().makeRotationX(0.95));
    const housing = new THREE.BoxGeometry(0.5, 0.36, 0.14);
    kit.add(m.matte, housing, pose, 0x1d1f21);
    housing.dispose();
    const lens = new THREE.PlaneGeometry(0.44, 0.3);
    kit.add(m.lamp, lens, pose.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.075)), 0xfff2dc);
    lens.dispose();
  }
}

/** Bulkhead lamp on a wall, facing along (nx, nz). Emissive only. */
function wallLamp(kit: Kit, m: Materials, x: number, y: number, z: number, nx: number, nz: number, color: number): void {
  const yaw = Math.atan2(nx, nz);
  kit.box(m.matte, 0.34, 0.16, 0.14, x + nx * 0.07, y, z + nz * 0.07, { yaw, color: 0x1d1f21 });
  kit.box(m.lamp, 0.28, 0.1, 0.02, x + nx * 0.15, y + 0.03, z + nz * 0.15, { yaw, color });
  kit.box(m.matte, 0.4, 0.03, 0.22, x + nx * 0.1, y + 0.16, z + nz * 0.1, { yaw, color: 0x1d1f21 });
}

export interface LocalLights {
  /** Light that stutters like a failing tube; driven from the map's update hook. */
  readonly flicker: THREE.PointLight;
  readonly flickerBase: number;
  /** Amber travel beacons on the yard gantry; shown and hidden to flash. */
  readonly beacons: THREE.Mesh;
}

/**
 * Lamp fittings (emissive) and the eight real lights the budget allows:
 * three mast floods, the gantry's work light, three in the shed and one in
 * the office. None cast shadows.
 */
export function buildLights(kit: Kit, m: Materials): LocalLights {
  for (const [x, z, heading] of POLES) buildPole(kit, m, x, z, heading);

  const spot = (from: THREE.Vector3, to: THREE.Vector3, color: number, intensity: number, distance: number, angle: number): void => {
    const light = new THREE.SpotLight(color, intensity, distance, angle, 0.7, 1.6);
    light.position.copy(from);
    light.target.position.copy(to);
    kit.root.add(light, light.target);
  };
  const point = (at: THREE.Vector3, color: number, intensity: number, distance: number): THREE.PointLight => {
    const light = new THREE.PointLight(color, intensity, distance, 1.7);
    light.position.copy(at);
    kit.root.add(light);
    return light;
  };

  const top = POLE_HEIGHT + 0.3;
  spot(V(20.9, top, 37), V(11, 0, 41), WARM, 900, 46, 1.0);
  spot(V(33.3, top, -9), V(27, 0, -7), WARM, 800, 42, 1.0);
  spot(V(-11.9, top, -33.4), V(-13, 0, -39), WARM, 900, 46, 1.05);
  spot(V(RTG.trolleyX, RTG.girder - 0.4, (RTG.north + RTG.south) / 2), V(RTG.trolleyX, 0, 6), WARM, 1000, 40, 0.75);

  const aisle = (WAREHOUSE.west + WAREHOUSE.east) / 2;
  point(V(aisle, 6.2, -6), SHED, 120, 30);
  point(V(aisle, 6.2, 10), SHED, 110, 28);
  const flickerBase = 26;
  const flicker = point(V(-38.6, 2.35, 4), 0xfff0d6, flickerBase, 12);
  point(V((OFFICE.west + OFFICE.east) / 2 - 0.6, 1.5, (OFFICE.north + OFFICE.south) / 2), 0xffe6c0, 7, 10);

  // Bulkhead lamps beside doors and along walls. These glow, and `lampGlow` paints their pools.
  for (const lamp of WALL_LAMPS) wallLamp(kit, m, lamp.x, lamp.y, lamp.z, lamp.nx, lamp.nz, lamp.color);
  kit.root.add(new THREE.HemisphereLight(OVERCAST.sky, OVERCAST.ground, OVERCAST.intensity));
  return { flicker, flickerBase, beacons: buildBeacons(kit) };
}

/** Two amber lamps on the gantry sills. One small mesh of its own so the update hook can blink it. */
function buildBeacons(kit: Kit): THREE.Mesh {
  const lamps = new MeshBuilder();
  const bulb = new THREE.SphereGeometry(0.11, 10, 6);
  for (const x of [RTG.west, RTG.east]) lamps.add(bulb, new THREE.Matrix4().makeTranslation(x, 3.78, (RTG.north + RTG.south) / 2 + 2.2));
  bulb.dispose();
  const material = kit.own(new THREE.MeshBasicNodeMaterial({ color: 0xff8a1a }));
  material.color.multiplyScalar(BEACON_GAIN);
  const mesh = new THREE.Mesh(lamps.build(), material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  kit.root.add(mesh);
  return mesh;
}

/** Travel beacon: a short flash a little under once a second. */
export function beaconLit(elapsed: number): boolean {
  return elapsed % 1.1 < 0.22;
}

/** Failing-tube stutter: mostly steady, with short irregular dips. */
export function flickerLevel(elapsed: number): number {
  const slow = Math.sin(elapsed * 2.3) * Math.sin(elapsed * 0.71 + 1.3);
  const fast = Math.sin(elapsed * 37) * Math.sin(elapsed * 23.7);
  return slow > 0.55 && fast > 0 ? 0.25 : 1;
}
