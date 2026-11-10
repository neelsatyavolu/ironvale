import * as THREE from 'three/webgpu';
import type { LightingSetup } from '../../world/types';
import { LIGHT_SPOTS } from './dressing';

/**
 * Sun measured in venice_sunset with scripts/dev/map-harbor-sun.mjs: at
 * rotation 0 it sits at atan2(z, x) = 35.93 degrees, 3.3 degrees above the
 * horizon. The level wants it low in the south-west, over the water: far enough
 * round to rake along the quay fronts and to reach down the lanes into the
 * main street.
 */
const HDRI_SUN_AZIMUTH = (35.93 * Math.PI) / 180;
const SUN_AZIMUTH = Math.atan2(0.74, -0.67);
/**
 * The light is lifted a few degrees above the sun disc in the sky. At the true
 * 3.3 degrees every street is in shadow end to end; at this height shafts
 * still reach through the lanes and the arch, and shadows stay long.
 */
const SUN_ELEVATION = (10 * Math.PI) / 180;

export const LIGHTING: LightingSetup = {
  hdri: 'hdri-harbor-venice-sunset',
  hdriRotation: HDRI_SUN_AZIMUTH - SUN_AZIMUTH,
  skyIntensity: 0.62,
  sunDirection: new THREE.Vector3(
    Math.cos(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
    Math.sin(SUN_ELEVATION),
    Math.sin(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
  ),
  sunColor: 0xffb070,
  sunIntensity: 7,
  fog: { color: 0xd0b3a4, density: 0.0026, sunTint: 0xffc48a, sunTintStrength: 0.7 },
  exposure: 0.94,
  volumetric: 0.3,
  bloom: 1,
};

/** Warm lamp light at the lit lanterns. No shadows: the sun owns the shadow map. */
export function createLamps(): THREE.PointLight[] {
  return LIGHT_SPOTS.slice(0, 8).map(([x, y, z, intensity]) => {
    const light = new THREE.PointLight(0xffb066, intensity, 13, 2);
    light.position.set(x, y, z);
    light.castShadow = false;
    return light;
  });
}
