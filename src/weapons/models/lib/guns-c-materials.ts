/**
 * Re-materials the guns-c glTF models for the game's lighting. The source
 * texture sets are kept (base colour, packed roughness/metalness, normal), but
 * levels are remapped and roughness is broken up with object-space noise the
 * same way the shared finishes in ../materials.ts are, so these guns sit with
 * the others.
 */
import * as THREE from 'three/webgpu';
import { color, float, mix, mrt, mx_noise_float, positionLocal, smoothstep, texture, vec2 } from 'three/tsl';

export interface FinishTweak {
  /** Multiplies the base colour texture. */
  readonly tint: number;
  /** Linear grey added to the base colour of the metal parts, which are authored near black. */
  readonly metalLift: number;
  /** The same for the non-metal parts (polymer furniture), which otherwise render as flat black. */
  readonly polymerLift: number;
  /** Multiplies the texture's roughness; `roughnessBias` is then added. */
  readonly roughness: number;
  readonly roughnessBias: number;
  /** 0 - 1: how much smoother the finish gets where the base colour shows bare, scratched metal. */
  readonly scratchGloss: number;
  /** Floor and ceiling for the final roughness. */
  readonly minRoughness: number;
  readonly maxRoughness: number;
  /** Multiplies the texture's metalness. */
  readonly metalness: number;
  /** 0 - 1: how much the noise spreads roughness around its texture value. */
  readonly wear: number;
  /** Noise frequency per metre. */
  readonly noiseScale: number;
  /** Lightens the base colour where the noise says the finish is rubbed (0 - 1). */
  readonly rub: number;
  readonly normalScale: number;
}

const tuned = new WeakMap<THREE.Material, THREE.Material>();

/** A node material built once per source material and shared by every build of the gun. */
export function tunedFinish(source: THREE.Material, tweak: FinishTweak): THREE.Material {
  const cached = tuned.get(source);
  if (cached) return cached;
  if (!(source instanceof THREE.MeshStandardMaterial) || !source.map || !source.roughnessMap) {
    throw new Error(`Gun material "${source.name}" is missing its base colour or roughness texture`);
  }
  // Keep the source's sidedness: a hollow receiver with an open port is authored double-sided.
  const material = new THREE.MeshStandardNodeMaterial({ name: `${source.name}_tuned`, side: source.side });
  material.normalMap = source.normalMap;
  material.normalScale = new THREE.Vector2(tweak.normalScale, tweak.normalScale);
  material.aoMap = source.aoMap;

  const coarse = mx_noise_float(positionLocal.mul(tweak.noiseScale)).mul(0.5).add(0.5);
  const fine = mx_noise_float(positionLocal.mul(tweak.noiseScale * 6.7)).mul(0.5).add(0.5);
  const variation = coarse.mul(0.6).add(fine.mul(0.4));
  const packed = texture(source.roughnessMap);
  const metal = packed.b.mul(tweak.metalness);
  const base = texture(source.map).rgb;
  // Scratches and worn edges are painted lighter in the base colour (linear values of about 0.03 and up).
  const scratched = smoothstep(0.03, 0.16, base.g).mul(packed.b);
  const rough = packed.g.mul(tweak.roughness).add(tweak.roughnessBias).mul(scratched.mul(-tweak.scratchGloss).add(1));
  material.roughnessNode = mix(rough.mul(1 - tweak.wear), rough.mul(1 + tweak.wear), variation).clamp(
    float(tweak.minRoughness),
    float(tweak.maxRoughness),
  );
  material.metalnessNode = metal;
  // Rubbed patches read a little lighter and only show on the metal parts.
  const rubbed = smoothstep(0.55, 0.85, variation).mul(tweak.rub).mul(packed.b);
  material.colorNode = base
    .mul(color(tweak.tint))
    .add(mix(float(tweak.polymerLift), float(tweak.metalLift), packed.b))
    .mul(rubbed.add(1));
  keepOutOfReflections(material);
  tuned.set(source, material);
  return material;
}

/**
 * The screen-space reflection pass mirrors the bright ground and sky onto the
 * gun's flanks, which are seen at a grazing angle, and washes the finish out
 * to chrome. It weights its result by the metalness it reads from this target,
 * so report none; the environment map already lights the gun.
 */
function keepOutOfReflections(material: THREE.MeshStandardNodeMaterial): void {
  material.mrtNode = mrt({ metalrough: vec2(0, 1) });
}

const plain = new Map<string, THREE.MeshStandardNodeMaterial>();

/** An untextured finish for parts modelled in code, with the same noise break-up. Cached by `key`. */
export function plainFinish(key: string, tint: number, roughness: number, metalness: number): THREE.MeshStandardNodeMaterial {
  const cached = plain.get(key);
  if (cached) return cached;
  const material = new THREE.MeshStandardNodeMaterial({ name: key, color: tint, roughness, metalness });
  const coarse = mx_noise_float(positionLocal.mul(70)).mul(0.5).add(0.5);
  const fine = mx_noise_float(positionLocal.mul(900)).mul(0.5).add(0.5);
  material.roughnessNode = mix(float(roughness * 0.8), float(Math.min(1, roughness * 1.2)), coarse.mul(0.6).add(fine.mul(0.4)));
  keepOutOfReflections(material);
  plain.set(key, material);
  return material;
}
