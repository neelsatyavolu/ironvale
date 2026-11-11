import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  color,
  dot,
  equirectUV,
  float,
  max,
  mix,
  modelWorldMatrix,
  normalize,
  positionLocal,
  pow,
  smoothstep,
  step,
  texture,
  vec3,
  vec4,
} from 'three/tsl';
import type { Kit } from './kit';
import { HDRI_SUN, LIGHTING, SUN_COLOR } from './lighting';
import type { TslNode } from './surfaces';

const RADIUS = 800;
/** Brightness of the drawn sky, set apart from how much the sky lights the level. */
const PANORAMA_GAIN = 1.15;
const HDR_GAIN = 0.8;

/**
 * Visible sky: the panorama's own broken cumulus over a cold blue, graded for
 * a winter afternoon. The blue deepens overhead and away from the sun, the
 * cloud bases go slate, the horizon is hazed to the fog colour so the
 * mountains sink into it, and the sun's quarter gets a pale straw glow with
 * the disc in it. Lighting still comes from the untouched HDRI. The dome
 * follows the camera.
 */
export function buildSky(kit: Kit): void {
  const assets = kit.ctx.assets;
  const panorama = assets.sky(LIGHTING.hdri);
  const map = panorama ?? assets.hdri(LIGHTING.hdri);
  const direction: TslNode = normalize(positionLocal);
  const sampled: TslNode = texture(map, equirectUV(direction)).rgb.min(vec3(4, 4, 4)).mul(panorama ? PANORAMA_GAIN : HDR_GAIN);

  const up: TslNode = max(direction.y, 0);
  const towardSun: TslNode = max(dot(direction, vec3(HDRI_SUN.x, HDRI_SUN.y, HDRI_SUN.z)), 0);
  const luma: TslNode = dot(sampled, vec3(0.2126, 0.7152, 0.0722));
  // More contrast in the cloud, and a deeper, colder blue high up and away from the sun.
  const contrast: TslNode = sampled.mul(mix(float(0.62), float(1.25), smoothstep(0.25, 0.9, luma)));
  const depth: TslNode = smoothstep(0.1, 0.8, up).mul(pow(towardSun, 2).oneMinus());
  const graded: TslNode = mix(contrast, contrast.mul(vec3(0.6, 0.74, 1.02)), depth.mul(0.75));
  const haze: TslNode = pow(up.oneMinus(), 9).mul(0.9).mul(step(-0.2, direction.y).mul(0.4).add(0.6));
  const fog: TslNode = color(LIGHTING.fog.color).mul(1.15);
  const warmHaze: TslNode = mix(fog, color(SUN_COLOR).mul(1.5), pow(towardSun, 6).mul(0.85));
  const glow: TslNode = color(SUN_COLOR).mul(pow(towardSun, 18).mul(0.5).add(pow(towardSun, 160).mul(1.6)).add(pow(towardSun, 2600).mul(9)));
  const material = kit.own(new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false }));
  material.colorNode = mix(graded, warmHaze, haze).add(glow);
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
