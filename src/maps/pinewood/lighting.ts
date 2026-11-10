import * as THREE from 'three/webgpu';
import { float, length, smoothstep, uv, vec3, vec4 } from 'three/tsl';
import type { AmbienceLayer, LightingSetup } from '../../world/types';

/** TSL graphs are loosely typed upstream; keep that looseness inside this file. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

/**
 * Sun azimuth in the HDRI (scripts/dev/map-pinewood-sun.mjs reports the glow
 * at atan2(z, x) = 40.8 degrees) and where the level wants it: low in the
 * east-north-east, so shafts cross the trail from the front right of a player
 * walking north.
 */
const HDRI_SUN_AZIMUTH = (40.8 * Math.PI) / 180;
const SUN_ELEVATION = (27 * Math.PI) / 180;
const SUN_AZIMUTH = (-36 * Math.PI) / 180;

export const SUN_DIRECTION = new THREE.Vector3(
  Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH),
  Math.sin(SUN_ELEVATION),
  Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
).normalize();

export function createLighting(): LightingSetup {
  return {
    hdri: 'hdri-pinewood-sky',
    hdriRotation: HDRI_SUN_AZIMUTH - SUN_AZIMUTH,
    skyIntensity: 0.4,
    sunDirection: SUN_DIRECTION.clone(),
    sunColor: 0xffd9ae,
    sunIntensity: 6.5,
    // Mist glows up-sun and thins a little above the canopy floor.
    fog: { color: 0xa9a8a2, density: 0.0215, sunTint: 0xe6d3b4, sunTintStrength: 0.7, heightFalloff: 0.02, baseHeight: 2 },
    exposure: 1.0,
    volumetric: 1,
    bloom: 0.9,
  };
}

export interface LampSpec {
  readonly position: THREE.Vector3;
  readonly color: number;
  readonly intensity: number;
  readonly distance: number;
  /** 0 - 1: how much the light wavers. */
  readonly flicker: number;
}

export interface LocalLights {
  update(elapsed: number): void;
  dispose(): void;
}

/** The low sun seen through mist: a soft additive disc far behind the trees. */
function sunGlow(): THREE.Mesh {
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const fromCentre: TslNode = length(uv().sub(0.5)).mul(2);
  const halo: TslNode = smoothstep(1, 0, fromCentre).pow(2.6).mul(0.28);
  const core: TslNode = smoothstep(0.1, 0.03, fromCentre).mul(3);
  material.colorNode = vec4(vec3(1.0, 0.86, 0.66).mul(halo.add(core)), float(1));
  const distance = 760;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(330, 330), material);
  mesh.position.copy(SUN_DIRECTION).multiplyScalar(distance);
  mesh.lookAt(0, 0, 0);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}

/** Sun disc plus the few warm lamps. None of them cast shadows. */
export function buildLights(root: THREE.Group, lamps: readonly LampSpec[]): LocalLights {
  const glow = sunGlow();
  root.add(glow);
  const lights = lamps.map((lamp) => {
    const light = new THREE.PointLight(lamp.color, lamp.intensity, lamp.distance, 2);
    light.position.copy(lamp.position);
    light.castShadow = false;
    root.add(light);
    return light;
  });
  return {
    update: (elapsed) => {
      lamps.forEach((lamp, i) => {
        if (lamp.flicker === 0) return;
        const waver = Math.sin(elapsed * 9.1 + i * 2.3) * 0.5 + Math.sin(elapsed * 23.7 + i) * 0.3 + Math.sin(elapsed * 3.3 + i * 5) * 0.2;
        (lights[i] as THREE.PointLight).intensity = lamp.intensity * (1 + waver * lamp.flicker);
      });
    },
    dispose: () => {
      glow.geometry.dispose();
      (glow.material as THREE.Material).dispose();
      for (const light of lights) light.dispose();
    },
  };
}

export function createAmbience(shedLamp: THREE.Vector3): readonly AmbienceLayer[] {
  return [
    { sound: 'snd-amb-forest', volume: 0.6 },
    { sound: 'snd-amb-wind', volume: 0.2 },
    { sound: 'snd-loop-birds', volume: 0.5, position: new THREE.Vector3(20, 14, 30), radius: 42 },
    { sound: 'snd-loop-birds', volume: 0.4, position: new THREE.Vector3(-22, 12, -32), radius: 42 },
    // The shed lantern creaks on its hook.
    { sound: 'snd-loop-metal-creak', volume: 0.18, position: shedLamp.clone(), radius: 10 },
  ];
}
