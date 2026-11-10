import * as THREE from 'three/webgpu';
import {
  abs,
  float,
  floor,
  fract,
  hash,
  materialColor,
  materialRoughness,
  max,
  mix,
  mx_noise_float,
  normalWorld,
  positionGeometry,
  positionWorld,
  smoothstep,
  step,
  texture,
  uv,
  vec3,
} from 'three/tsl';
import type { PbrMaps } from '../../core/assets';
import { pbrMaterial } from '../../render/materials';
import type { Kit } from './kit';
import { letteringAtlas } from './lettering';
import { shelter, skyVisibility } from './shelter';
import {
  cardboard,
  chainlinkMesh,
  hazardStripes,
  oilStain,
  roadPaint,
  seaWater,
  shrinkWrap,
  steelPaint,
  timber,
  worldNoise,
  type TslNode,
} from './surfaces';

export { LOGO_ROWS, logoGeometry, type LogoText } from './lettering';

export interface Materials {
  readonly asphalt: THREE.Material;
  readonly quay: THREE.Material;
  readonly floor: THREE.Material;
  readonly wall: THREE.Material;
  readonly ballast: THREE.Material;
  /** Profiled steel sheet, grey by default; vertex colour picks the paint. */
  readonly cladding: THREE.Material;
  /** Container paint; instance or vertex colour picks the livery. */
  readonly container: THREE.Material;
  /** Painted structural steel with grime; vertex colour picks the paint. */
  readonly steel: THREE.Material;
  /** Bare, worn steel: rails, wheels, chains. */
  readonly rawSteel: THREE.Material;
  readonly hazard: THREE.Material;
  readonly wood: THREE.Material;
  /** Plain rough surface (plastic, rubber, tarpaulin) coloured per vertex. */
  readonly matte: THREE.Material;
  /** Cardboard for unit boxes, with tape and a label; vertex colour picks the board shade. */
  readonly carton: THREE.Material;
  /** Stretch film over a pallet load. */
  readonly wrap: THREE.Material;
  /** Road paint laid just above the ground. */
  readonly paint: THREE.Material;
  /** Soft dark blotch for oil stains and tyre scuffs. Needs 0 - 1 UVs across the patch. */
  readonly stain: THREE.Material;
  readonly chainlink: THREE.Material;
  readonly glass: THREE.Material;
  /** Unlit glowing surface for lamp lenses and lit windows; vertex colour sets the tint. */
  readonly lamp: THREE.Material;
  readonly water: THREE.Material;
  /** White stencilled lettering, see `LOGO_ROWS`. */
  readonly lettering: THREE.Material;
  /** Sky visibility node; fold it into any extra lit material with `shelter`. */
  readonly visibility: TslNode;
}

const LAMP_GAIN = 7;

/**
 * PBR set whose albedo is reduced to one channel, so the paint colour comes
 * from vertex or instance colour instead of the photographed one. `height` is
 * metres above the foot of the sheet; dirt and rust gather low down and run in
 * vertical streaks.
 */
function tintable(
  maps: PbrMaps,
  channel: 'r' | 'g',
  gain: number,
  roughness: number,
  normalScale: number,
  height: TslNode,
  wear: number,
): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff });
  const sample: TslNode = texture(maps.color, uv());
  const value: TslNode = (channel === 'r' ? sample.r : sample.g).mul(gain);
  // Large soft blotches so repeated sheets do not all read as one flat colour.
  const blotch: TslNode = mix(float(0.62), float(1.08), worldNoise(0.45));
  const fine: TslNode = worldNoise(9);
  const streak: TslNode = mx_noise_float(positionWorld.mul(vec3(2.6, 0.2, 2.6))).mul(0.5).add(0.5);
  const low: TslNode = smoothstep(0.0, 1.1, height).oneMinus();
  const grime: TslNode = smoothstep(0.34, 0.82, streak.mul(0.6).add(fine.mul(0.25)).add(low.mul(0.32))).mul(wear);
  const rust: TslNode = smoothstep(0.6, 0.76, worldNoise(1.7).mul(0.5).add(fine.mul(0.3)).add(low.mul(0.3))).mul(wear);
  const paint: TslNode = vec3(value.mul(blotch)).mul(mix(float(1), float(0.4), grime));
  // Multiplied by the paint colour afterwards: holding red and cutting blue turns any livery a dull rust brown.
  material.colorNode = mix(paint, vec3(1.0, 0.44, 0.2).mul(value).mul(0.5), rust.mul(0.9));
  if (maps.normal && normalScale > 0) {
    material.normalMap = maps.normal;
    material.normalScale = new THREE.Vector2(normalScale, normalScale);
  }
  if (maps.arm) {
    material.aoMap = maps.arm;
    material.roughnessMap = maps.arm;
  }
  material.metalness = 0;
  material.roughness = roughness;
  // Rain-wet paint is glossy; grime and rust stay dull.
  material.roughnessNode = materialRoughness.mul(mix(float(0.6), float(1.4), max(grime, rust)));
  material.vertexColors = true;
  return material;
}

/** 1 on the joints of a square grid of slabs `spacing` metres across, 0 elsewhere. */
function slabJoints(spacing: number, width: number): TslNode {
  const toJoint = (coordinate: TslNode): TslNode => float(0.5).sub(abs(fract(coordinate.div(spacing)).sub(0.5))).mul(spacing);
  const nearest: TslNode = toJoint(positionWorld.x).min(toJoint(positionWorld.z));
  return smoothstep(width * 0.3, width, nearest).oneMinus();
}

/** Tone that differs from slab to slab, so a concrete apron reads as separate pours. */
function slabTone(spacing: number): TslNode {
  const cell: TslNode = floor(positionWorld.x.div(spacing)).add(200).add(floor(positionWorld.z.div(spacing)).add(200).mul(57));
  return mix(float(0.86), float(1.06), hash(cell));
}

export function createMaterials(kit: Kit): Materials {
  const assets = kit.ctx.assets;

  const asphalt = pbrMaterial(assets.pbr('pbr-railyard-asphalt'), { wetness: 0.86, puddleScale: 5 });
  // Rain-dark, with slow tonal drift across the yard to break up the 3 m repeat.
  const drift: TslNode = mix(float(0.36), float(0.66), mx_noise_float(positionWorld.xz.div(9)).mul(0.5).add(0.5));
  asphalt.colorNode = (asphalt.colorNode as TslNode).mul(drift);

  const quay = pbrMaterial(assets.pbr('pbr-railyard-concrete'), { wetness: 0.7, puddleScale: 3.2, tint: 0xa3a199 });
  quay.colorNode = (quay.colorNode as TslNode).mul(slabTone(6)).mul(mix(float(1), float(0.3), slabJoints(6, 0.035)));

  // Shed slab: dusty, darkened where trucks run, damp and shiny in patches where rain is tracked in.
  const shedFloor = pbrMaterial(assets.pbr('pbr-railyard-concrete'), { roughness: 0.9, tint: 0x8f8b82 });
  const damp: TslNode = smoothstep(0.42, 0.7, mx_noise_float(positionWorld.xz.div(3.4)).mul(0.5).add(0.5));
  const wornIn: TslNode = mix(float(0.7), float(1.05), worldNoise(0.23));
  shedFloor.colorNode = (materialColor as TslNode).rgb
    .mul(wornIn)
    .mul(slabTone(5.5))
    .mul(mix(float(1), float(0.66), damp))
    .mul(mix(float(1), float(0.3), slabJoints(5.5, 0.025)));
  shedFloor.roughnessNode = (materialRoughness as TslNode).mul(mix(float(1), float(0.22), damp));

  const wall = pbrMaterial(assets.pbr('pbr-railyard-wall'), { roughness: 0.85, tint: 0xc4c6c6 });
  // Rain streaks down the face, heaviest under the coping, and splash-back dirt along the foot.
  const run: TslNode = mx_noise_float(positionWorld.mul(vec3(1.5, 0.14, 1.5))).mul(0.5).add(0.5);
  const fineRun: TslNode = mx_noise_float(positionWorld.mul(vec3(6, 0.5, 6))).mul(0.5).add(0.5);
  const streaks: TslNode = smoothstep(0.34, 0.7, run.mul(0.7).add(fineRun.mul(0.3)).add(smoothstep(1.2, 3.4, positionWorld.y).mul(0.12)));
  const foot: TslNode = smoothstep(0.0, 0.9, positionWorld.y).oneMinus();
  // Formwork: a joint every 2.4 m along the wall and one pour line, on upright faces only.
  const upright: TslNode = abs(normalWorld.y).oneMinus();
  const along: TslNode = mix(positionWorld.x, positionWorld.z, step(0.5, abs(normalWorld.x)));
  const toJoint: TslNode = float(0.5).sub(abs(fract(along.div(2.4)).sub(0.5))).mul(2.4).min(abs(positionWorld.y.sub(1.75)));
  const joints: TslNode = smoothstep(0.006, 0.02, toJoint).oneMinus().mul(upright);
  // The scan is an olive concrete; pull it most of the way to grey so it sits with the yard.
  const scan: TslNode = materialColor;
  const greyed: TslNode = mix(vec3(scan.r.add(scan.g).add(scan.b).div(3)), scan.rgb, 0.25);
  wall.colorNode = greyed
    .mul(mix(float(1.05), float(0.42), streaks))
    .mul(mix(float(1), float(0.55), foot))
    .mul(mix(float(1), float(0.45), joints));
  wall.roughnessNode = (materialRoughness as TslNode).mul(mix(float(1), float(0.5), streaks));
  wall.vertexColors = true;
  const ballast = pbrMaterial(assets.pbr('pbr-railyard-ballast'), { roughness: 0.7, tint: 0x6f6a64 });

  const cladding = tintable(assets.pbr('pbr-railyard-cladding'), 'r', 4.6, 0.6, 1, positionWorld.y.sub(0.9), 0.5);
  const container = tintable(assets.pbr('pbr-railyard-container'), 'g', 3.1, 0.5, 0.35, positionGeometry.y, 1);

  const rawSteel = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.85 });
  rawSteel.vertexColors = true;
  const matte = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0 });
  // A little mottling so large plain faces do not read as flat fills.
  matte.colorNode = vec3(mix(float(0.8), float(1.04), worldNoise(2.6).mul(0.6).add(worldNoise(19).mul(0.4))));
  matte.vertexColors = true;
  const glass = new THREE.MeshStandardNodeMaterial({
    color: 0x1b262b,
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
  });
  const lamp = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
  lamp.color.setScalar(LAMP_GAIN);

  const visibility = skyVisibility();
  const lit = {
    asphalt,
    quay,
    floor: shedFloor,
    wall,
    ballast,
    cladding,
    container,
    steel: steelPaint(),
    rawSteel,
    hazard: hazardStripes(),
    wood: timber(),
    matte,
    carton: cardboard(),
    wrap: shrinkWrap(),
    paint: roadPaint(),
    stain: oilStain(),
    chainlink: chainlinkMesh(),
    glass,
    lettering: letteringAtlas(kit),
  };
  for (const material of Object.values(lit)) shelter(material, visibility);
  const materials: Materials = { ...lit, lamp, water: seaWater(), visibility };
  for (const material of [...Object.values(lit), lamp, materials.water]) kit.own(material);

  for (const flat of [materials.paint, materials.stain, materials.lettering, asphalt, quay, shedFloor, ballast, materials.water]) {
    kit.setShadows(flat, false, true);
  }
  for (const unshadowed of [materials.chainlink, materials.glass, materials.lamp]) kit.setShadows(unshadowed, false, false);
  return materials;
}
