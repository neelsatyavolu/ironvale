import * as THREE from 'three/webgpu';
import {
  float,
  instanceIndex,
  materialColor,
  materialRoughness,
  mix,
  mx_noise_float,
  normalWorld,
  positionGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  time,
  uv,
  vec3,
} from 'three/tsl';
import type { Assets } from '../../core/assets';
import { flatMaterial, pbrMaterial } from '../../render/materials';
import { createNeedleTexture, NEEDLE_ALPHA_TEST } from './needles';

/** TSL graphs are loosely typed upstream; keep that looseness inside this file. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

export interface PinewoodMaterials {
  readonly bark: THREE.MeshStandardNodeMaterial;
  /** Bark for wood lying on the ground: moss grows on whatever faces up. */
  readonly barkMossy: THREE.MeshStandardNodeMaterial;
  readonly rock: THREE.MeshStandardNodeMaterial;
  /** Rock without moss, for creek stones that get rolled about. */
  readonly rockBare: THREE.MeshStandardNodeMaterial;
  readonly stone: THREE.MeshStandardNodeMaterial;
  readonly planks: THREE.MeshStandardNodeMaterial;
  readonly planksDark: THREE.MeshStandardNodeMaterial;
  readonly roof: THREE.MeshStandardNodeMaterial;
  readonly cutWood: THREE.MeshStandardNodeMaterial;
  readonly rust: THREE.MeshStandardNodeMaterial;
  readonly rubber: THREE.MeshStandardNodeMaterial;
  readonly iron: THREE.MeshStandardNodeMaterial;
  readonly char: THREE.MeshStandardNodeMaterial;
  readonly ember: THREE.MeshStandardNodeMaterial;
  readonly lampGlow: THREE.MeshStandardNodeMaterial;
  /** Dark bottle glass. */
  readonly glass: THREE.MeshStandardNodeMaterial;
  /** Coarse wool: blankets and bedrolls. */
  readonly wool: THREE.MeshStandardNodeMaterial;
  readonly needles: THREE.MeshStandardNodeMaterial;
  dispose(): void;
}

/** Grow moss on up-facing parts of a surface, broken up by world-space noise. */
function addMoss(material: THREE.MeshStandardNodeMaterial, amount: number, scale: number): void {
  const noise: TslNode = mx_noise_float(positionWorld.mul(scale)).mul(0.5).add(0.5);
  const fine: TslNode = mx_noise_float(positionWorld.mul(scale * 4.3)).mul(0.5).add(0.5);
  const mask: TslNode = smoothstep(0.3, 0.85, normalWorld.y.add(noise.sub(0.5).mul(1.1)).add(fine.sub(0.5).mul(0.4))).mul(amount);
  const base: TslNode = materialColor;
  const luma: TslNode = base.r.mul(0.3).add(base.g.mul(0.6)).add(base.b.mul(0.1));
  const moss: TslNode = vec3(0.15, 0.2, 0.06).mul(luma.mul(1.8).add(0.2));
  material.colorNode = mix(base.rgb, moss, mask);
  material.roughnessNode = mix(materialRoughness, float(0.96), mask);
}

/** Old painted steel: flaking green paint over rust. */
function rustMaterial(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.35 });
  const blotch: TslNode = mx_noise_float(positionWorld.mul(5.5)).mul(0.5).add(0.5);
  const grain: TslNode = mx_noise_float(positionWorld.mul(31)).mul(0.5).add(0.5);
  const rust: TslNode = mix(vec3(0.11, 0.05, 0.028), vec3(0.34, 0.15, 0.055), grain.mul(0.7).add(blotch.mul(0.3)));
  const paint: TslNode = vec3(0.075, 0.105, 0.085).mul(grain.mul(0.3).add(0.8));
  const painted: TslNode = smoothstep(0.56, 0.66, blotch.add(grain.mul(0.22)));
  material.colorNode = mix(rust, paint, painted);
  material.roughnessNode = mix(float(0.92), float(0.58), painted);
  return material;
}

/** Sawn end grain that has weathered: growth rings, a dark rim under the bark and grey patches. */
function cutWoodMaterial(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
  const fromCentre: TslNode = uv().sub(0.5).length().mul(2);
  const wobble: TslNode = mx_noise_float(positionWorld.mul(9)).mul(0.08);
  const rings: TslNode = sin(fromCentre.add(wobble).mul(46)).mul(0.5).add(0.5);
  const age: TslNode = mx_noise_float(positionWorld.mul(3.1)).mul(0.5).add(0.5);
  const wood: TslNode = mix(vec3(0.2, 0.13, 0.07), vec3(0.36, 0.26, 0.15), rings.mul(0.6).add(age.mul(0.4)));
  const weathered: TslNode = mix(wood, vec3(0.2, 0.19, 0.17), smoothstep(0.45, 0.8, age).mul(0.7));
  material.colorNode = weathered.mul(mix(float(1), float(0.45), smoothstep(0.8, 1, fromCentre)));
  return material;
}

/** Alpha-tested needle cards that bob slightly in the wind. */
function needleMaterial(map: THREE.Texture): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({
    map,
    alphaTest: NEEDLE_ALPHA_TEST,
    side: THREE.DoubleSide,
    roughness: 1,
    metalness: 0,
  });
  // Boughs seen from below sit in the crown's own shade.
  // The inner end of every spray is buried in the crown, so it is darker too.
  const under: TslNode = mix(float(0.42), float(1), smoothstep(-0.35, 0.55, normalWorld.y));
  const inner: TslNode = mix(float(0.5), float(1), smoothstep(0.0, 0.7, uv().y));
  material.colorNode = materialColor.mul(under).mul(inner);
  const phase: TslNode = positionGeometry.y.mul(0.7).add(float(instanceIndex).mul(1.91));
  const sway: TslNode = sin(time.mul(1.15).add(phase)).mul(uv().y).mul(0.045);
  material.positionNode = positionLocal.add(vec3(sway.mul(0.4), sway, sway.mul(0.3)));
  return material;
}

export function createMaterials(assets: Assets, random: () => number): PinewoodMaterials {
  const needleTexture = createNeedleTexture(random);
  const planksSet = assets.pbr('pbr-pinewood-planks');
  const barkSet = assets.pbr('pbr-pinewood-bark');

  const barkMossy = pbrMaterial(barkSet, { tint: 0xb9ad9c });
  addMoss(barkMossy, 0.45, 1.6);
  const rock = pbrMaterial(assets.pbr('pbr-pinewood-rock'), { tint: 0xc9c9c4, normalScale: 1.2 });
  addMoss(rock, 0.7, 0.9);
  const roof = pbrMaterial(planksSet, { tint: 0x6f6a5c });
  addMoss(roof, 0.75, 2.1);

  const ember = flatMaterial(0x120804, 0.9);
  ember.emissive = new THREE.Color(0xff5a14);
  ember.emissiveIntensity = 3.5;
  const lampGlow = flatMaterial(0x2a1c0c, 0.6);
  lampGlow.emissive = new THREE.Color(0xffb062);
  lampGlow.emissiveIntensity = 5;

  const materials = {
    bark: pbrMaterial(barkSet, { tint: 0xbfb6aa, normalScale: 1.3 }),
    barkMossy,
    rock,
    rockBare: pbrMaterial(assets.pbr('pbr-pinewood-rock'), { tint: 0xa9a7a0 }),
    stone: pbrMaterial(assets.pbr('pbr-pinewood-stone'), { tint: 0xd2d0c8, normalScale: 1.2 }),
    planks: pbrMaterial(planksSet, { tint: 0xb8ab98 }),
    planksDark: pbrMaterial(planksSet, { tint: 0x7c7062 }),
    roof,
    cutWood: cutWoodMaterial(),
    rust: rustMaterial(),
    rubber: flatMaterial(0x121212, 0.9),
    iron: flatMaterial(0x24221f, 0.6, 0.8),
    char: flatMaterial(0x0c0b0a, 0.95),
    ember,
    lampGlow,
    glass: flatMaterial(0x10190f, 0.12),
    wool: flatMaterial(0x3b3d31, 0.97),
    needles: needleMaterial(needleTexture),
  };
  return {
    ...materials,
    dispose: () => {
      needleTexture.dispose();
      for (const material of Object.values(materials)) material.dispose();
    },
  };
}
