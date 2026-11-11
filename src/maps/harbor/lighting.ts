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
export const HDRI_SUN_AZIMUTH = (35.93 * Math.PI) / 180;
export const HDRI_SUN_ELEVATION = (3.3 * Math.PI) / 180;
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
  skyIntensity: 0.5,
  sunDirection: new THREE.Vector3(
    Math.cos(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
    Math.sin(SUN_ELEVATION),
    Math.sin(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
  ),
  sunColor: 0xffb070,
  sunIntensity: 8.2,
  fog: { color: 0xcfb2a2, density: 0.0033, sunTint: 0xffc083, sunTintStrength: 0.8 },
  exposure: 0.94,
  volumetric: 0.36,
  shaftDensity: 1.5,
  bloom: 1,
};

/**
 * Sunlight thrown back up by warm stone and plaster. With the sun this low the
 * streets are mostly in shade, and sky light alone leaves them flat and blue;
 * this fills walls, eaves and the undersides of balconies from below.
 */
export function createBounce(): THREE.HemisphereLight {
  const light = new THREE.HemisphereLight(0x1d2733, 0xff9f5c, 0.8);
  light.position.set(0, 1, 0);
  return light;
}

/** Warm lamp light at the lit lanterns. No shadows: the sun owns the shadow map. */
export function createLamps(): THREE.PointLight[] {
  return LIGHT_SPOTS.slice(0, 8).map(([x, y, z, intensity]) => {
    const light = new THREE.PointLight(0xffb066, intensity, 13, 2);
    light.position.set(x, y, z);
    light.castShadow = false;
    return light;
  });
}
