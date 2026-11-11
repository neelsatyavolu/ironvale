/**
 * Finishes for the M7. The source model has no textures, only one flat colour
 * per material, so each material is named by role in
 * scripts/process-gun-m7.mjs and gets its whole finish here: coyote anodised
 * aluminium for the receivers and handguard, tan polymer for the stock and
 * grip, and dark steel and polymer for the rest. Colour and roughness are
 * broken up with object-space noise so the flat surfaces do not read as plastic.
 */
import * as THREE from 'three/webgpu';
import { color, float, mix, mx_noise_float, positionLocal, smoothstep } from 'three/tsl';
import { keepOutOfReflections } from './guns-c-materials';

interface Finish {
  readonly tint: number;
  readonly roughness: number;
  readonly metalness: number;
  /** 0 - 1: how far the noise spreads roughness around its value. */
  readonly wear: number;
  /** 0 - 1: how much the colour varies in soft patches, as dye lots and handling do to anodising. */
  readonly mottle: number;
  /** 0 - 1: how much lighter the small rubbed spots are. */
  readonly rub: number;
  /** Noise frequency per metre. */
  readonly noiseScale: number;
}

const FINISHES: Readonly<Record<string, Finish>> = {
  m7_receiver: { tint: 0x665a49, roughness: 0.56, metalness: 0.3, wear: 0.22, mottle: 0.1, rub: 0.14, noiseScale: 42 },
  m7_polymer: { tint: 0x5d5243, roughness: 0.78, metalness: 0, wear: 0.12, mottle: 0.05, rub: 0, noiseScale: 110 },
  m7_suppressor: { tint: 0x594e40, roughness: 0.7, metalness: 0.4, wear: 0.25, mottle: 0.16, rub: 0.1, noiseScale: 30 },
  m7_black: { tint: 0x19191a, roughness: 0.7, metalness: 0.1, wear: 0.18, mottle: 0.04, rub: 0, noiseScale: 110 },
  m7_steel: { tint: 0x26272a, roughness: 0.5, metalness: 0.9, wear: 0.3, mottle: 0.06, rub: 0.2, noiseScale: 55 },
  m7_bolt: { tint: 0x777a7e, roughness: 0.34, metalness: 1, wear: 0.4, mottle: 0.05, rub: 0, noiseScale: 45 },
  m7_magazine: { tint: 0x1c1c1d, roughness: 0.62, metalness: 0, wear: 0.15, mottle: 0.04, rub: 0, noiseScale: 110 },
  m7_brass: { tint: 0xa98742, roughness: 0.36, metalness: 1, wear: 0.2, mottle: 0, rub: 0, noiseScale: 60 },
  m7_bullet: { tint: 0x9c5f3c, roughness: 0.36, metalness: 1, wear: 0.2, mottle: 0, rub: 0, noiseScale: 60 },
};

const finished = new Map<string, THREE.MeshStandardNodeMaterial>();

/** The finish for one of the model's materials, by its name. Built once and shared by every build of the gun. */
export function m7Finish(source: THREE.Material): THREE.Material {
  const cached = finished.get(source.name);
  if (cached) return cached;
  const finish = FINISHES[source.name];
  if (!finish) throw new Error(`M7 material "${source.name}" has no finish`);
  // Keep the source's sidedness: the open dust cover and the magazine's mouth are single sheets.
  const material = new THREE.MeshStandardNodeMaterial({ name: `${source.name}_finish`, side: source.side, metalness: finish.metalness });
  const coarse = mx_noise_float(positionLocal.mul(finish.noiseScale)).mul(0.5).add(0.5);
  const fine = mx_noise_float(positionLocal.mul(finish.noiseScale * 6.7)).mul(0.5).add(0.5);
  const variation = coarse.mul(0.6).add(fine.mul(0.4));
  // Patches a few centimetres across, unrelated to the roughness break-up.
  const patches = mx_noise_float(positionLocal.mul(finish.noiseScale * 0.31).add(7.3)).mul(0.5).add(0.5);
  const rubbed = smoothstep(0.62, 0.9, variation).mul(finish.rub);
  material.colorNode = color(finish.tint)
    .mul(mix(float(1 - finish.mottle), float(1 + finish.mottle), patches))
    .mul(rubbed.add(1));
  material.roughnessNode = mix(float(finish.roughness * (1 - finish.wear)), float(Math.min(1, finish.roughness * (1 + finish.wear))), variation);
  keepOutOfReflections(material);
  finished.set(source.name, material);
  return material;
}
