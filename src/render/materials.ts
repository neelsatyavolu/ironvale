import * as THREE from 'three/webgpu';
import {
  float,
  materialColor,
  materialRoughness,
  mix,
  mx_noise_float,
  normalWorld,
  positionWorld,
  smoothstep,
} from 'three/tsl';
import type { PbrMaps } from '../core/assets';

export interface PbrOptions {
  /** Multiplies the albedo. */
  readonly tint?: number;
  readonly normalScale?: number;
  /** Multiplies the texture's roughness. */
  readonly roughness?: number;
  /** Overrides metalness when the texture set has no metal channel. */
  readonly metalness?: number;
  /**
   * 0 - 1. Darkens the surface, lowers roughness and adds noise-shaped puddles
   * on up-facing areas. Use on rainy maps so reflections have something to show.
   */
  readonly wetness?: number;
  /** Size of puddle patches in metres. */
  readonly puddleScale?: number;
  readonly side?: THREE.Side;
}

/** Standard PBR material from a downloaded texture set. */
export function pbrMaterial(maps: PbrMaps, options: PbrOptions = {}): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({
    map: maps.color,
    color: options.tint ?? 0xffffff,
    side: options.side ?? THREE.FrontSide,
  });
  if (maps.normal) {
    material.normalMap = maps.normal;
    const scale = options.normalScale ?? 1;
    material.normalScale = new THREE.Vector2(scale, scale);
  }
  if (maps.arm) {
    material.aoMap = maps.arm;
    material.roughnessMap = maps.arm;
    material.metalnessMap = maps.arm;
    material.metalness = 1;
  } else {
    if (maps.roughness) material.roughnessMap = maps.roughness;
    if (maps.ao) material.aoMap = maps.ao;
    material.metalness = options.metalness ?? 0;
  }
  material.roughness = options.roughness ?? 1;
  if (options.metalness !== undefined && !maps.arm) material.metalness = options.metalness;

  const wetness = options.wetness ?? 0;
  if (wetness > 0) applyWetness(material, wetness, options.puddleScale ?? 3);
  return material;
}

/** Plain painted or coated surface with no textures (signage, trim, plastic). */
export function flatMaterial(
  color: number,
  roughness: number,
  metalness = 0,
): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });
}

function applyWetness(material: THREE.MeshStandardNodeMaterial, wetness: number, puddleScale: number): void {
  const noise = mx_noise_float(positionWorld.xz.div(puddleScale)).mul(0.5).add(0.5);
  const detail = mx_noise_float(positionWorld.xz.div(puddleScale * 0.23)).mul(0.5).add(0.5);
  const facingUp = smoothstep(0.85, 0.98, normalWorld.y);
  const threshold = float(1 - wetness * 0.75);
  const puddle = smoothstep(threshold, threshold.add(0.12), noise.mul(0.75).add(detail.mul(0.25))).mul(facingUp);
  const damp = float(wetness);
  material.colorNode = materialColor.mul(mix(float(1), float(0.62), damp.mul(0.8))).mul(mix(float(1), float(0.7), puddle));
  material.roughnessNode = mix(materialRoughness.mul(mix(float(1), float(0.55), damp)), float(0.04), puddle);
}
