import * as THREE from 'three/webgpu';
import type { LightingSetup } from '../../world/types';
import { V, type Kit } from './kit';
import { COAT, type Materials } from './materials';
import { WALL_LAMPS } from './lamps';
import { HOUSES } from './plan';

/**
 * Sun position measured from the HDRI with scripts/dev/map-headworks-sun.mjs:
 * azimuth 38.22 degrees (atan2(z, x) in the texture), elevation 7.19 degrees,
 * behind a bank of cloud. The level is a low winter afternoon: the sun stands
 * 14 degrees up, in the south and 23 degrees round to the west, which is the
 * line of the slot between the clarifiers. Sunlight runs the length of the slot
 * and every wall throws a shadow four times its height. The sky is turned to
 * put its bright quarter there; the mountains hide the difference in height.
 */
const HDRI_SUN_AZIMUTH = (38.22 * Math.PI) / 180;
const SUN_ELEVATION = (14 * Math.PI) / 180;
const SUN_WEST_OF_SOUTH = (23 * Math.PI) / 180;

const sunDirection = V(
  -Math.sin(SUN_WEST_OF_SOUTH) * Math.cos(SUN_ELEVATION),
  Math.sin(SUN_ELEVATION),
  Math.cos(SUN_WEST_OF_SOUTH) * Math.cos(SUN_ELEVATION),
);

/** Where the level's sun is in the sky image's own frame, before the image is turned. */
export const HDRI_SUN = V(Math.cos(HDRI_SUN_AZIMUTH) * Math.cos(SUN_ELEVATION), Math.sin(SUN_ELEVATION), Math.sin(HDRI_SUN_AZIMUTH) * Math.cos(SUN_ELEVATION));

export const FOG_COLOR = 0x8ea2b9;
/** Pale straw of low winter sun; the shade it leaves is lit blue by the sky. */
export const SUN_COLOR = 0xffddb4;

export const LIGHTING: LightingSetup = {
  hdri: 'hdri-headworks',
  // Rotating the sky by r moves a texture direction at azimuth a to a - r.
  hdriRotation: HDRI_SUN_AZIMUTH - Math.atan2(sunDirection.z, sunDirection.x),
  skyIntensity: 0.8,
  sunDirection,
  sunColor: SUN_COLOR,
  sunIntensity: 6.4,
  // Cold valley haze lying low over the yard, warming where the sun comes through it.
  fog: { color: FOG_COLOR, density: 0.0085, sunTint: 0xf3dcc0, sunTintStrength: 0.8, heightFalloff: 0.018, baseHeight: 0 },
  exposure: 0.72,
  volumetric: 0.55,
  shaftDensity: 2.2,
  bloom: 0.7,
};

const WORK_LIGHT = 0xfff1d8;
const COOL_TUBE = 0xdfeeff;

/** Bulkhead lamp on a wall, facing along (nx, nz). Glows but lights nothing. */
export function wallLamp(kit: Kit, m: Materials, x: number, y: number, z: number, nx: number, nz: number, color = WORK_LIGHT): void {
  const yaw = Math.atan2(nx, nz);
  kit.box(m.paint, 0.3, 0.2, 0.12, x + nx * 0.06, y, z + nz * 0.06, COAT.black, yaw);
  kit.box(m.lamp, 0.24, 0.13, 0.03, x + nx * 0.13, y + 0.035, z + nz * 0.13, color, yaw);
  kit.box(m.paint, 0.36, 0.03, 0.2, x + nx * 0.09, y + 0.2, z + nz * 0.09, COAT.black, yaw);
  // Conduit down the wall to the lamp, from the cable tray where there is one.
  kit.tube(m.galvanised, V(x - nz * 0.1, y + 0.2, z + nx * 0.1 + nz * 0.02), V(x - nz * 0.1, y + (y > 3 ? 0.72 : 1.3), z + nx * 0.1 + nz * 0.02), 0.012, undefined, 6);
}

/** Twin-tube batten hung from a ceiling, with its lit diffuser. */
function batten(kit: Kit, m: Materials, x: number, y: number, z: number, alongX: boolean): void {
  const [w, d] = alongX ? [1.5, 0.18] : [0.18, 1.5];
  kit.box(m.paint, w, 0.07, d, x, y - 0.07, z, COAT.cream);
  kit.box(m.lamp, w - 0.06, 0.03, d - 0.05, x, y - 0.1, z, COOL_TUBE);
  for (const s of [-0.5, 0.5]) kit.tube(m.galvanised, V(x + (alongX ? s : 0), y, z + (alongX ? 0 : s)), V(x + (alongX ? s : 0), y + 0.35, z + (alongX ? 0 : s)), 0.008, undefined, 5);
}

/**
 * The practical lights: two battens in each pump house that really light it,
 * and bulkheads by doors and along the walls whose pools are painted by `lampGlow`.
 */
export function buildLights(kit: Kit, m: Materials): void {
  // Shade is lit by the blue of the sky overhead, not by grey: a cool fill with a darker, neutral bounce from the slab.
  kit.root.add(new THREE.HemisphereLight(0x9dbcec, 0x565b63, 0.55));
  for (const house of HOUSES) {
    const cx = (house.x0 + house.x1) / 2;
    const cz = (house.z0 + house.z1) / 2;
    const ceiling = house.height;
    for (const dx of [-4, 4]) {
      for (const dz of [-3.4, 3.4]) batten(kit, m, cx + dx, ceiling - 0.35, cz + dz, true);
      const light = new THREE.PointLight(COOL_TUBE, 46, 16, 1.6);
      light.position.set(cx + dx, ceiling - 0.9, cz);
      kit.root.add(light);
    }
  }
  for (const lamp of WALL_LAMPS) wallLamp(kit, m, lamp.x, lamp.y, lamp.z, lamp.nx, lamp.nz, lamp.color);
}
