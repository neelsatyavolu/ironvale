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
  mx_fractal_noise_float,
  normalize,
  positionLocal,
  pow,
  smoothstep,
  texture,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Assets } from '../../core/assets';
import type { TslNode } from './grime';
import { HDRI_SUN_AZIMUTH, HDRI_SUN_ELEVATION, LIGHTING } from './lighting';

const RADIUS = 800;
/** Matches the engine backdrop: sky intensity times its gain for a tone-mapped panorama (1.5) or the raw HDR (1). */
const PANORAMA_GAIN = LIGHTING.skyIntensity * 1.5;
const HDR_GAIN = LIGHTING.skyIntensity;

/** Cloud colours through the evening: under the sun, a quarter turn from it, and opposite it. */
const GOLD = 0xffcf8a;
const ROSE = 0xe88f74;
const MAUVE = 0x9d8fae;
/** Noise frequency along the line to the sun and across it: the bars lie across, so they stack above the sunset. */
const STRETCH = [0.56, 0.17] as const;
const COVER = [0.47, 0.7] as const;

/**
 * Visible sky. The panorama was shot under a clear evening and is nearly
 * empty above ten degrees, which left every street view with a plain blue
 * card at the top. This draws the same panorama with a deck of broken high
 * cloud over it: long bars lying across the line to the sun, gold where the low sun
 * rakes them, rose to the sides and mauve behind the viewer, with darker
 * cores. Lighting still comes from the untouched HDRI. The dome follows the
 * camera so it behaves like the engine backdrop.
 */
export function addSky(root: THREE.Object3D, assets: Assets): { dispose(): void } {
  const panorama = assets.sky(LIGHTING.hdri);
  const map = panorama ?? assets.hdri(LIGHTING.hdri);
  const gain = panorama ? PANORAMA_GAIN : HDR_GAIN;

  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false });
  const direction: TslNode = normalize(positionLocal);
  const sky: TslNode = texture(map, equirectUV(direction)).rgb.min(vec3(6, 6, 6)).mul(gain);

  // The dome is turned with the panorama, so the sun is where the photograph has it.
  const sunFlat = vec2(Math.cos(HDRI_SUN_AZIMUTH), Math.sin(HDRI_SUN_AZIMUTH));
  const cosEl = Math.cos(HDRI_SUN_ELEVATION);
  const sun = vec3(sunFlat.x.mul(cosEl), Math.sin(HDRI_SUN_ELEVATION), sunFlat.y.mul(cosEl));
  const facing: TslNode = dot(direction, sun);
  const towardSun: TslNode = max(facing, 0);

  // A flat layer seen in perspective: the bars bunch up into bands toward the horizon.
  const plane: TslNode = direction.xz.div(max(direction.y, 0).add(0.09));
  const along: TslNode = dot(plane, sunFlat);
  const across: TslNode = dot(plane, vec2(sunFlat.y.negate(), sunFlat.x));
  const bars: TslNode = mx_fractal_noise_float(vec3(along.mul(STRETCH[0]), across.mul(STRETCH[1]), 3.7), 4).mul(0.5).add(0.5);
  const wisps: TslNode = mx_fractal_noise_float(vec3(along.mul(1.7), across.mul(0.7), 11.3), 3).mul(0.5).add(0.5);
  const density: TslNode = bars.mul(0.74).add(wisps.mul(0.26));
  // Clear right at the horizon, where the haze and the capes are, and thinner straight overhead.
  const lift: TslNode = smoothstep(0.012, 0.1, direction.y).mul(mix(float(1), float(0.7), smoothstep(0.5, 0.95, direction.y)));
  const cover: TslNode = smoothstep(COVER[0], COVER[1], density).mul(lift);
  const core: TslNode = smoothstep(0.66, 0.9, density);

  const side: TslNode = smoothstep(-0.55, 0.6, facing);
  const lit: TslNode = mix(mix(color(MAUVE), color(ROSE), side), color(GOLD).mul(1.5), pow(towardSun, 5));
  // Thick cloud shades itself; thin edges near the sun burn.
  const cloud: TslNode = lit.mul(mix(float(1), float(0.5), core)).add(color(GOLD).mul(pow(towardSun, 14)).mul(core.oneMinus()).mul(0.9));
  // A band of warm air above the horizon all the way round, strongest under the sun.
  const band: TslNode = smoothstep(0.0, 0.26, direction.y).oneMinus().mul(mix(float(0.1), float(0.34), side));
  const air: TslNode = mix(sky, sky.add(color(ROSE).mul(0.5)), band);
  material.colorNode = mix(air, cloud, cover.mul(0.88));
  material.vertexNode = cameraProjectionMatrix
    .mul(cameraViewMatrix)
    .mul(vec4(modelWorldMatrix.mul(vec4(positionLocal, 0)).xyz.add(cameraPosition), 1));

  const geometry = new THREE.SphereGeometry(RADIUS, 48, 24);
  const dome = new THREE.Mesh(geometry, material);
  dome.name = 'harbor-sky';
  dome.rotation.y = LIGHTING.hdriRotation;
  dome.renderOrder = -1000;
  dome.frustumCulled = false;
  dome.castShadow = false;
  dome.receiveShadow = false;
  root.add(dome);
  return {
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
