import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  dot,
  equirectUV,
  max,
  mix,
  modelWorldMatrix,
  mx_fractal_noise_float,
  normalize,
  positionLocal,
  pow,
  smoothstep,
  texture,
  vec3,
  vec4,
} from 'three/tsl';
import type { Kit } from './kit';
import { HDRI_SUN, LIGHTING } from './lighting';
import type { TslNode } from './surfaces';

const RADIUS = 800;
/** Brightness of the drawn sky, set apart from how much the sky lights the level. */
const PANORAMA_GAIN = 1.5;
const HDR_GAIN = 1;
const HORIZON = [0.74, 0.83, 0.94] as const;

/**
 * Visible sky. The level is lit by a hard sun with little sky fill, which
 * would leave the engine's own backdrop a dark navy. This dome draws the same
 * panorama at daylight strength, pales it toward the horizon the way cold
 * mountain air does, and lays a few streaks of high ice cloud across it so
 * the blue is not one flat card. It follows the camera.
 */
export function buildSky(kit: Kit): void {
  const assets = kit.ctx.assets;
  const panorama = assets.sky(LIGHTING.hdri);
  const map = panorama ?? assets.hdri(LIGHTING.hdri);
  const direction: TslNode = normalize(positionLocal);
  const sky: TslNode = texture(map, equirectUV(direction)).rgb.min(vec3(6, 6, 6)).mul(panorama ? PANORAMA_GAIN : HDR_GAIN);

  const up: TslNode = max(direction.y, 0);
  const towardSun: TslNode = max(dot(direction, vec3(HDRI_SUN.x, HDRI_SUN.y, HDRI_SUN.z)), 0);
  // Cirrus: long thin streaks on a flat layer far overhead, thinning to nothing near the sun's glare and the zenith.
  const plane: TslNode = direction.xz.div(up.add(0.05));
  const streaks: TslNode = mx_fractal_noise_float(vec3(plane.x.mul(0.3), plane.y.mul(1.9), 4.2), 4).mul(0.5).add(0.5);
  const wisps: TslNode = mx_fractal_noise_float(vec3(plane.x.mul(1.3), plane.y.mul(2.9), 9.7), 3).mul(0.5).add(0.5);
  const cirrus: TslNode = smoothstep(0.62, 0.9, streaks.mul(0.7).add(wisps.mul(0.3)))
    .mul(smoothstep(0.03, 0.2, direction.y))
    .mul(smoothstep(0.95, 0.55, direction.y))
    .mul(0.28);
  const hazeBand: TslNode = pow(up.oneMinus(), 7).mul(0.85);
  const air: TslNode = mix(sky, vec3(...HORIZON).mul(1.5), hazeBand);
  const material = kit.own(new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false }));
  material.colorNode = mix(air, vec3(1.7, 1.72, 1.76), cirrus).add(vec3(1, 0.96, 0.9).mul(pow(towardSun, 24)).mul(0.5));
  material.vertexNode = cameraProjectionMatrix
    .mul(cameraViewMatrix)
    .mul(vec4(modelWorldMatrix.mul(vec4(positionLocal, 0)).xyz.add(cameraPosition), 1));

  const dome = new THREE.Mesh(kit.own(new THREE.SphereGeometry(RADIUS, 48, 24)), material);
  dome.name = 'headworks-sky';
  dome.rotation.y = LIGHTING.hdriRotation;
  dome.renderOrder = -1000;
  dome.frustumCulled = false;
  dome.castShadow = false;
  dome.receiveShadow = false;
  kit.root.add(dome);
}
