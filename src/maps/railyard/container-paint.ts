import * as THREE from 'three/webgpu';
import {
  abs,
  float,
  floor,
  fract,
  hash,
  materialRoughness,
  max,
  mix,
  mx_noise_float,
  normalLocal,
  positionGeometry,
  positionWorld,
  smoothstep,
  step,
  texture,
  uv,
  vec3,
} from 'three/tsl';
import type { PbrMaps } from '../../core/assets';
import { worldNoise, type TslNode } from './surfaces';

/** Spacing of the corrugation ribs, which is where run-off gathers and rust starts. */
const RIB_PITCH = 0.278;
/** Height of the top of the side sheets above the container's underside. */
const SHEET_TOP = 2.48;
const RUST = vec3(0.25, 0.11, 0.046);
const RUST_DARK = vec3(0.09, 0.045, 0.026);
const ROAD_FILM = vec3(0.105, 0.095, 0.085);

/**
 * Container paint for the instanced boxes. `liveryColor` is the per-instance
 * paint colour; this adds what years at sea do to it: rust runs that start under the
 * top rail and follow single ribs down, rain staining, a dirty splash band
 * along the bottom rail, chalky fading, and
 * standing water and rust on the roof.
 */
export function containerPaint(maps: PbrMaps, gain: number, normalScale: number, liveryColor: TslNode): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff });
  const g: TslNode = positionGeometry;
  const p: TslNode = positionWorld;
  const value: TslNode = texture(maps.color, uv()).g.mul(gain);

  const side: TslNode = step(0.5, abs(normalLocal.x));
  const roof: TslNode = smoothstep(0.6, 0.9, normalLocal.y);
  const upright: TslNode = roof.oneMinus();
  const along: TslNode = mix(g.x, g.z, side);
  const fromTop: TslNode = float(SHEET_TOP).sub(g.y);
  // Slow drift in world space, so two boxes side by side do not wear in the same places.
  const drift: TslNode = worldNoise(0.31);
  const fine: TslNode = worldNoise(11);

  // Rust runs: some ribs carry one, each a different length, breaking up toward its tail.
  const rib: TslNode = along.div(RIB_PITCH);
  const cell: TslNode = floor(rib);
  const pick: TslNode = fract(hash(cell.add(71)).add(drift.mul(2.7)));
  const runLength: TslNode = mix(float(0.15), float(1.4), fract(pick.mul(7.3)).pow(2));
  const acrossRib: TslNode = abs(fract(rib).sub(0.5)).mul(2);
  const run: TslNode = step(0.7, pick)
    .mul(smoothstep(float(0), runLength, fromTop).oneMinus())
    .mul(smoothstep(0.1, 0.55, acrossRib).oneMinus())
    .mul(mix(float(0.35), float(1), fine))
    .mul(step(0.0, fromTop))
    .mul(upright);

  // Rain staining: broad dark curtains, heaviest just under the top rail.
  const curtain: TslNode = mx_noise_float(vec3(p.x.mul(2.3), p.y.mul(0.16), p.z.mul(2.3))).mul(0.5).add(0.5);
  const underRail: TslNode = smoothstep(0.0, 0.9, fromTop).oneMinus();
  const stain: TslNode = smoothstep(0.42, 0.8, curtain.mul(0.65).add(fine.mul(0.2)).add(underRail.mul(0.25))).mul(upright);

  const bloom: TslNode = worldNoise(1.6).mul(0.6).add(fine.mul(0.4));
  // Splash band and rust creeping up from the bottom rail.
  const low: TslNode = smoothstep(0.05, 0.75, g.y).oneMinus();
  const splash: TslNode = smoothstep(0.35, 0.8, low.mul(0.75).add(fine.mul(0.35))).mul(upright);
  const footRust: TslNode = smoothstep(0.62, 0.82, smoothstep(0.0, 0.4, g.y).oneMinus().mul(0.5).add(bloom.mul(0.45))).mul(upright);

  // Scattered rust blooms with a dark core, and nothing below the threshold.
  // Rust blooms: pitted and broken up, never a solid blot.
  const pitting: TslNode = smoothstep(0.34, 0.6, fine);
  const patch: TslNode = smoothstep(0.68, 0.86, bloom).mul(pitting);

  // Roof: water lies in the shallow panels and rust rings the edges of the pools.
  // (Thresholded at the noise median, roof rust used to cover half of every roof in hard camouflage blots.)
  const fadeNoise: TslNode = worldNoise(0.45);
  const wetness: TslNode = fadeNoise.mul(0.7).add(fine.mul(0.3));
  const pool: TslNode = smoothstep(0.5, 0.62, wetness).mul(roof);
  const rim: TslNode = smoothstep(0.42, 0.5, wetness).mul(smoothstep(0.5, 0.58, wetness).oneMinus());
  const roofRust: TslNode = max(smoothstep(0.66, 0.82, bloom), rim.mul(0.75)).mul(pitting).mul(roof);

  const rust: TslNode = max(max(run, patch.mul(0.72)), max(footRust, roofRust.mul(0.8)));
  const core: TslNode = smoothstep(0.78, 0.9, bloom).mul(patch);

  // Chalky fade in big soft blotches, then the dirt layers on top. Rust and dirt keep their own colour.
  const fade: TslNode = mix(float(0.66), float(1.1), fadeNoise);
  const chalk: TslNode = mix(float(1), float(1.22), smoothstep(0.55, 0.9, drift).mul(upright));
  const livery: TslNode = liveryColor
    .mul(value.mul(fade).mul(chalk))
    .mul(mix(float(1), float(0.48), stain))
    .mul(mix(float(1), float(0.62), pool));
  const relief: TslNode = value.mul(0.6).add(0.55);
  const dirtied: TslNode = mix(livery, ROAD_FILM.mul(relief), splash.mul(0.72));
  const rusted: TslNode = mix(dirtied, RUST.mul(relief), rust.mul(0.85));
  material.colorNode = mix(rusted, RUST_DARK.mul(relief), core);

  if (maps.normal && normalScale > 0) {
    material.normalMap = maps.normal;
    material.normalScale = new THREE.Vector2(normalScale, normalScale);
  }
  if (maps.arm) {
    material.aoMap = maps.arm;
    material.roughnessMap = maps.arm;
  }
  material.metalness = 0;
  material.roughness = 0.5;
  // Wet paint shines; rust, road film and chalked paint stay dull; roof pools are mirrors.
  const dull: TslNode = max(max(rust, splash), stain.mul(0.5));
  material.roughnessNode = mix((materialRoughness as TslNode).mul(mix(float(0.78), float(1.6), dull)), float(0.06), pool);
  return material;
}
