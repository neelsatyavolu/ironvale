import * as THREE from 'three/webgpu';
import {
  abs,
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
import { LIGHTING, SUN_IN_SKY } from './lighting';
import type { TslNode } from './surfaces';

const RADIUS = 800;
/** Brightness of the visible sky, set by eye: the tone-mapped panorama needs a lift, the raw HDR needs taming. */
const PANORAMA_GAIN = 0.8;
const HDR_GAIN = 0.5;
/** Light left in the darkest and lightest parts of the cloud deck overhead. */
const DECK_DARK = 0.2;
const DECK_LIGHT = 0.42;
const SUN_GLOW = 0xffb46e;

/**
 * Visible sky. The HDRI was shot on a fair evening; the level is in steady
 * rain, so the panorama is shown through a grade: the blue is pulled to grey,
 * the upper sky is darkened to a heavy, uneven cloud deck, the horizon is
 * hazed to the fog colour so distant geometry melts into it, and the gap the
 * sun shines through keeps its warmth and gets a glow. Lighting still comes
 * from the untouched HDRI. The dome is drawn around the camera so it behaves
 * like the engine backdrop.
 */
export function buildSky(kit: Kit): void {
  const assets = kit.ctx.assets;
  const panorama = assets.sky(LIGHTING.hdri);
  const map = panorama ?? assets.hdri(LIGHTING.hdri);
  const gain = panorama ? PANORAMA_GAIN : HDR_GAIN;

  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false });
  const direction: TslNode = normalize(positionLocal);
  const sampled: TslNode = texture(map, equirectUV(direction)).rgb.min(vec3(4, 4, 4));
  const luma: TslNode = dot(sampled, vec3(0.2126, 0.7152, 0.0722));
  // Warm pixels (red well above blue) keep their colour; cool ones go most of the way to grey.
  const warmth: TslNode = smoothstep(0.0, 0.16, sampled.r.sub(sampled.b).div(luma.add(0.05)));
  const grey: TslNode = vec3(luma, luma, luma).mul(vec3(0.9, 0.96, 1.05));
  const graded: TslNode = mix(mix(grey, sampled, 0.14), sampled, warmth);
  // Cloud deck: dark and uneven overhead, lighter toward the horizon.
  const billow: TslNode = mx_fractal_noise_float(direction.mul(vec3(2.4, 6, 2.4)), 3).mul(0.5).add(0.5);
  const deck: TslNode = mix(float(1), mix(float(DECK_DARK), float(DECK_LIGHT), billow), smoothstep(0.03, 0.42, direction.y));
  const towardSun: TslNode = max(dot(direction, vec3(SUN_IN_SKY.x, SUN_IN_SKY.y, SUN_IN_SKY.z)), 0);
  const haze: TslNode = smoothstep(0.0, 0.16, abs(direction.y)).oneMinus().mul(0.8).mul(pow(towardSun, 5).oneMinus());
  const glow: TslNode = color(SUN_GLOW).mul(pow(towardSun, 28).mul(0.5).add(pow(towardSun, 500).mul(5)));
  material.colorNode = mix(graded.mul(deck).mul(gain), color(LIGHTING.fog.color), haze).add(glow);
  material.vertexNode = cameraProjectionMatrix
    .mul(cameraViewMatrix)
    .mul(vec4(modelWorldMatrix.mul(vec4(positionLocal, 0)).xyz.add(cameraPosition), 1));

  const dome = new THREE.Mesh(kit.own(new THREE.SphereGeometry(RADIUS, 48, 24)), kit.own(material));
  dome.rotation.y = LIGHTING.hdriRotation;
  dome.renderOrder = -1000;
  dome.frustumCulled = false;
  dome.castShadow = false;
  dome.receiveShadow = false;
  kit.root.add(dome);
}
