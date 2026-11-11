import * as THREE from 'three/webgpu';
import type { LightingSetup } from '../../world/types';
import { V, type Kit } from './kit';
import { COAT, type Materials } from './materials';
import { BLOCKS, HOUSES, isTwin, type Block } from './plan';

/**
 * Sun position measured from the HDRI with scripts/dev/map-headworks-sun.mjs:
 * azimuth 41.97 degrees (atan2(z, x) in the texture), elevation 51.15 degrees.
 * The level wants that noon sun in the south and 23 degrees round to the
 * west, which is the line of the slot between the clarifiers: sunlight runs
 * the length of the slot and the bridge lays one hard band of shadow across
 * it, at an angle to the joints in the paving. The sky is turned to put it
 * there.
 */
const HDRI_SUN_AZIMUTH = (41.97 * Math.PI) / 180;
const SUN_ELEVATION = (51.15 * Math.PI) / 180;
const SUN_WEST_OF_SOUTH = (23 * Math.PI) / 180;

const sunDirection = V(
  -Math.sin(SUN_WEST_OF_SOUTH) * Math.cos(SUN_ELEVATION),
  Math.sin(SUN_ELEVATION),
  Math.cos(SUN_WEST_OF_SOUTH) * Math.cos(SUN_ELEVATION),
);

/** Where the sun is in the sky image itself, before the image is turned. */
export const HDRI_SUN = V(Math.cos(HDRI_SUN_AZIMUTH) * Math.cos(SUN_ELEVATION), Math.sin(SUN_ELEVATION), Math.sin(HDRI_SUN_AZIMUTH) * Math.cos(SUN_ELEVATION));

export const FOG_COLOR = 0xb9c9d8;

export const LIGHTING: LightingSetup = {
  hdri: 'hdri-headworks',
  // Rotating the sky by r moves a texture direction at azimuth a to a - r.
  hdriRotation: HDRI_SUN_AZIMUTH - Math.atan2(sunDirection.z, sunDirection.x),
  skyIntensity: 0.72,
  sunDirection,
  sunColor: 0xfff3e2,
  sunIntensity: 7.2,
  // Thin, pale, cold haze: enough to set the mountains back, not enough to soften the yard.
  fog: { color: FOG_COLOR, density: 0.0038, sunTint: 0xe9ecec, sunTintStrength: 0.4 },
  exposure: 0.5,
  volumetric: 0.25,
  shaftDensity: 0.6,
  bloom: 0.55,
};

const WORK_LIGHT = 0xfff1d8;
const COOL_TUBE = 0xdfeeff;

/** Bulkhead lamp on a wall, facing along (nx, nz). Glows but lights nothing. */
export function wallLamp(kit: Kit, m: Materials, x: number, y: number, z: number, nx: number, nz: number, color = WORK_LIGHT): void {
  const yaw = Math.atan2(nx, nz);
  kit.box(m.paint, 0.3, 0.2, 0.12, x + nx * 0.06, y, z + nz * 0.06, COAT.black, yaw);
  kit.box(m.lamp, 0.24, 0.13, 0.03, x + nx * 0.13, y + 0.035, z + nz * 0.13, color, yaw);
  kit.box(m.paint, 0.36, 0.03, 0.2, x + nx * 0.09, y + 0.2, z + nz * 0.09, COAT.black, yaw);
  // Conduit up the wall to the lamp.
  kit.tube(m.galvanised, V(x - nz * 0.1, y + 0.2, z + nx * 0.1 + nz * 0.02), V(x - nz * 0.1, y + 1.3, z + nx * 0.1 + nz * 0.02), 0.012, undefined, 6);
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
 * and glowing bulkheads by doors and along the lanes that do not.
 */
export function buildLights(kit: Kit, m: Materials): void {
  // The sky image's lower half is bare brown hillside; a cool fill stands in for light bounced off pale concrete.
  kit.root.add(new THREE.HemisphereLight(0xcfe0f7, 0xa9a59c, 0.3));
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
  // A bulkhead beside every door through a wall, on the sunless side first.
  const lintels: readonly Block[] = BLOCKS.filter((b) => b.id.includes('lintel'));
  for (const b of lintels) {
    const alongX = b.x1 - b.x0 > b.z1 - b.z0;
    const flip = isTwin(b) ? -1 : 1;
    if (alongX) wallLamp(kit, m, b.x1 + 0.5, 2.75, flip > 0 ? b.z0 : b.z1, 0, -flip);
    else wallLamp(kit, m, flip > 0 ? b.x0 : b.x1, 2.75, b.z1 + 0.5, -flip, 0);
  }
}
