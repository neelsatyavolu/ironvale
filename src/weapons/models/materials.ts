import * as THREE from 'three/webgpu';
import { float, mix, mx_noise_float, positionLocal } from 'three/tsl';

/**
 * Shared finishes so every gun reads as part of one set. Each call returns a
 * cached material; do not mutate them. Roughness is broken up with object-space
 * noise so flat surfaces catch light unevenly, the way worn metal does.
 */
const cache = new Map<string, THREE.MeshStandardNodeMaterial>();

function finish(
  key: string,
  color: number,
  roughness: number,
  metalness: number,
  wear: number,
  noiseScale: number,
): THREE.MeshStandardNodeMaterial {
  const existing = cache.get(key);
  if (existing) return existing;
  const material = new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });
  const coarse = mx_noise_float(positionLocal.mul(noiseScale)).mul(0.5).add(0.5);
  const fine = mx_noise_float(positionLocal.mul(noiseScale * 7.3)).mul(0.5).add(0.5);
  const variation = coarse.mul(0.65).add(fine.mul(0.35));
  material.roughnessNode = mix(float(roughness * (1 - wear)), float(Math.min(1, roughness * (1 + wear))), variation);
  cache.set(key, material);
  return material;
}

export const gunMaterials = {
  /** Deep blue-black polished steel: pistol slides, bolt-action barrels and receivers. */
  bluedSteel: () => finish('blued', 0x15171b, 0.32, 1, 0.45, 38),
  /** Matte grey-black phosphate: military rifles, magazines. */
  parkerized: () => finish('parkerized', 0x2a2c2e, 0.62, 0.85, 0.25, 55),
  /** Hard-anodised aluminium: AR receivers, rails, optics bodies. */
  anodized: () => finish('anodized', 0x1c1d1f, 0.5, 0.75, 0.3, 60),
  /** Bare worn steel on edges, bolts and charging handles. */
  bareSteel: () => finish('bare', 0x8d9196, 0.28, 1, 0.5, 45),
  /** Glass-filled polymer: stocks, grips, handguards. */
  polymer: () => finish('polymer', 0x18191a, 0.72, 0, 0.18, 120),
  /** Rubber: butt pads, grip inserts. */
  rubber: () => finish('rubber', 0x0f0f10, 0.92, 0, 0.08, 90),
  /** Cartridge brass. */
  brass: () => finish('brass', 0xb08d45, 0.3, 1, 0.35, 70),
  /** Olive drab painted or cerakoted parts. */
  oliveDrab: () => finish('olive', 0x3b3f2c, 0.66, 0.2, 0.25, 60),
};

/** Coated optic lens: dark, glossy, slightly tinted. */
export function lensMaterial(tint = 0x223344): THREE.MeshPhysicalNodeMaterial {
  return new THREE.MeshPhysicalNodeMaterial({
    color: tint,
    roughness: 0.03,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });
}
