import type * as THREE from 'three/webgpu';
import {
  abs,
  float,
  floor,
  fract,
  hash,
  materialColor,
  materialRoughness,
  mix,
  mx_noise_float,
  normalize,
  normalMap,
  normalWorld,
  positionWorld,
  sin,
  smoothstep,
  texture,
  time,
  transformNormalToView,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type { PbrMaps } from '../../core/assets';
import type { TslNode } from './surfaces';

export interface SoakOptions {
  /** 0 - 1: how dark and glossy the paving is between the puddles. */
  readonly damp: number;
  /** Size of the hollows the water collects in, metres. */
  readonly puddleScale: number;
  /** Roughly the share of the ground under standing water, 0 - 1. */
  readonly cover: number;
  /** Extra tone multiplied into the colour (slab joints, drift across the yard). */
  readonly tone?: TslNode;
  readonly normalScale?: number;
}

/** Rings spreading from raindrops: a small tilt of the water surface, in world X and Z. */
function rainRings(): TslNode {
  const grid: TslNode = positionWorld.xz.mul(2.4);
  const id: TslNode = floor(grid);
  const seed: TslNode = hash(id.x.add(id.y.mul(57.3)).add(13));
  const centre: TslNode = vec2(hash(seed.mul(91.7)), hash(seed.mul(37.1))).mul(0.5).add(0.25);
  const offset: TslNode = fract(grid).sub(centre);
  const distance: TslNode = offset.length();
  const age: TslNode = fract(time.mul(1.15).add(seed.mul(7)));
  const front: TslNode = abs(distance.sub(age.mul(0.42)));
  const ring: TslNode = smoothstep(0.0, 0.035, front).oneMinus().mul(age.oneMinus());
  return offset.div(distance.add(0.001)).mul(sin(front.mul(180)).mul(ring).mul(0.22));
}

/**
 * Rain-soaked paving for a textured ground material: dark and half-glossy
 * where it is merely wet, with separate mirror-flat puddles in the hollows,
 * each with a darker damp margin and raindrop rings. The puddles drop the
 * normal map so reflections in them are crisp.
 */
export function soak(material: THREE.MeshStandardNodeMaterial, maps: PbrMaps, options: SoakOptions): void {
  const p: TslNode = positionWorld.xz;
  const broad: TslNode = mx_noise_float(p.div(options.puddleScale)).mul(0.5).add(0.5);
  const mid: TslNode = mx_noise_float(p.div(options.puddleScale * 0.31).add(vec2(17.3, 5.1))).mul(0.5).add(0.5);
  const hollow: TslNode = broad.mul(0.66).add(mid.mul(0.34));
  const level = 1 - options.cover * 0.62 - 0.3;
  const up: TslNode = smoothstep(0.85, 0.98, normalWorld.y);
  const puddle: TslNode = smoothstep(level, level + 0.022, hollow).mul(up);
  const margin: TslNode = smoothstep(level - 0.13, level, hollow).mul(up);

  const tone: TslNode = options.tone ?? float(1);
  material.colorNode = (materialColor as TslNode).rgb
    .mul(tone)
    .mul(mix(float(1), float(0.56), options.damp))
    .mul(mix(float(1), float(0.7), margin))
    .mul(mix(float(1), float(0.5), puddle));
  const wet: TslNode = (materialRoughness as TslNode).mul(mix(float(1), float(0.62), options.damp)).mul(mix(float(1), float(0.6), margin));
  material.roughnessNode = mix(wet, float(0.02), puddle);
  if (maps.normal) {
    const scale = options.normalScale ?? 1;
    const rough: TslNode = normalMap(texture(maps.normal, uv()) as TslNode, vec2(scale, scale) as TslNode);
    const rings: TslNode = rainRings();
    const water: TslNode = transformNormalToView(normalize(vec3(rings.x, 1, rings.y)));
    material.normalMap = null;
    const blended: TslNode = mix(rough, water, puddle);
    material.normalNode = normalize(blended);
  }
}
