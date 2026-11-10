/**
 * Node materials for the downloaded gun models. GLTFLoader hands back plain
 * `MeshStandardMaterial`s; these are rebuilt as node materials that keep the
 * texture maps and apply a per-material tweak, so a finish that loads too
 * bright or too flat can be corrected without touching the textures.
 */
import * as THREE from 'three/webgpu';
import {
  color,
  float,
  materialColor,
  materialMetalness,
  materialRoughness,
  mix,
  mrt,
  mx_noise_float,
  positionLocal,
  vec2,
  vec3,
} from 'three/tsl';

export interface FinishTweak {
  /** Multiplies the base colour everywhere. */
  readonly tint?: number;
  /** Multiplies the base colour of metal only, so wood and polymer in the same texture keep theirs. */
  readonly metalTint?: number;
  /** Multiplies the base colour of everything that is not metal (polymer, wood, rubber). */
  readonly plainTint?: number;
  /** Multiplies the texture's roughness. */
  readonly roughness?: number;
  /** Multiplies the roughness of metal only, on top of `roughness`: below 1 tightens its highlights. */
  readonly metalRoughness?: number;
  /** Multiplies the roughness of everything that is not metal, on top of `roughness`: above 1 makes polymer matte. */
  readonly plainRoughness?: number;
  /** Lower bound for roughness after scaling, to stop mirror-like patches. */
  readonly minRoughness?: number;
  /** Multiplies the texture's metalness. */
  readonly metalness?: number;
  readonly normalScale?: number;
  /** Strength of the baked ambient occlusion (0 - 1). */
  readonly ao?: number;
  /** 0 - 1: breaks roughness up with object-space noise so flat faces catch light unevenly. */
  readonly wear?: number;
}

const cache = new WeakMap<THREE.Material, THREE.MeshStandardNodeMaterial>();

function convert(source: THREE.MeshStandardMaterial, tweak: FinishTweak): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({
    map: source.map,
    normalMap: source.normalMap,
    roughnessMap: source.roughnessMap,
    metalnessMap: source.metalnessMap,
    aoMap: source.aoMap,
    aoMapIntensity: tweak.ao ?? 1,
    color: source.color.clone().multiply(new THREE.Color(tweak.tint ?? 0xffffff)),
    roughness: source.roughness * (tweak.roughness ?? 1),
    metalness: Math.min(1, source.metalness * (tweak.metalness ?? 1)),
    side: THREE.FrontSide,
  });
  material.name = source.name;
  const scale = tweak.normalScale ?? 1;
  material.normalScale = new THREE.Vector2(source.normalScale.x * scale, source.normalScale.y * scale);

  if (tweak.metalTint !== undefined || tweak.plainTint !== undefined) {
    const plain = tweak.plainTint === undefined ? vec3(1) : color(tweak.plainTint);
    const metal = tweak.metalTint === undefined ? vec3(1) : color(tweak.metalTint);
    material.colorNode = materialColor.mul(mix(plain, metal, materialMetalness));
  }

  // Keep the gun out of screen-space reflections. Its flanks are seen at a
  // grazing angle, where the reflection pass mirrors the bright sky ahead onto
  // them and washes the finish out; the environment map already lights it.
  // The pass weights its result by the metalness it reads from this target.
  material.mrtNode = mrt({ metalrough: vec2(0, 1) });

  const wear = tweak.wear ?? 0;
  const floor = tweak.minRoughness ?? 0;
  const metalRoughness = tweak.metalRoughness ?? 1;
  const plainRoughness = tweak.plainRoughness ?? 1;
  if (wear > 0 || floor > 0 || metalRoughness !== 1 || plainRoughness !== 1) {
    const base = materialRoughness.mul(mix(float(plainRoughness), float(metalRoughness), materialMetalness));
    const noise = mx_noise_float(positionLocal.mul(260)).mul(0.5).add(0.5);
    const varied = mix(base.mul(1 - wear * 0.5), base.mul(1 + wear * 0.5), noise);
    material.roughnessNode = varied.clamp(float(floor), float(1));
  }
  return material;
}

/**
 * Swap every mesh material under `scene` for its tuned node material. The
 * result is cached per source material, so repeated builds share materials.
 */
export function applyFinishes(scene: THREE.Object3D, tweaks: Readonly<Record<string, FinishTweak>>): void {
  scene.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const source = child.material as THREE.Material;
    let material = cache.get(source);
    if (!material) {
      if (!(source instanceof THREE.MeshStandardMaterial)) {
        console.warn(`Gun material "${source.name}" is not a standard material; left as loaded`);
        return;
      }
      material = convert(source, tweaks[source.name] ?? {});
      cache.set(source, material);
    }
    child.material = material;
  });
}
