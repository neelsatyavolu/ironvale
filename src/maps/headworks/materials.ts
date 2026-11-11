import * as THREE from 'three/webgpu';
import { float, floor, fract, hash, smoothstep, step, mix, mx_noise_float, normalize, positionWorld, transformNormalToView, vec2, vec3 } from 'three/tsl';
import { linePaint, runOff, signAtlas, stain, tyreMarks } from './decals';
import type { Kit } from './kit';
import { lampGlow, lampLit } from './lamps';
import { bareSteel, coatedSteel, formedConcrete, grating, hazardStripes, paving, shelter, skyVisibility, worldNoise, type TslNode } from './surfaces';

export interface Materials {
  /** Board-formed concrete with projected UVs: walls, buildings, plinths. Vertex colour tints it. */
  readonly concrete: THREE.Material;
  /** The same concrete for curved work (the clarifiers), which carries its own UVs. */
  readonly concreteRound: THREE.Material;
  /** Pale ground slab in 4 m bays. */
  readonly paving: THREE.Material;
  /** Dark slate-aggregate surfacing of the service roads. */
  readonly road: THREE.Material;
  /** Coated steel; vertex colour is the paint. */
  readonly paint: THREE.Material;
  readonly stainless: THREE.Material;
  readonly galvanised: THREE.Material;
  /** Plain rough surface (rubber, plastic, cable) coloured per vertex. */
  readonly matte: THREE.Material;
  readonly hazard: THREE.Material;
  readonly grating: THREE.Material;
  readonly glass: THREE.Material;
  readonly water: THREE.Material;
  /** Unlit glowing surface for lamps and indicators; vertex colour sets the tint. */
  readonly lamp: THREE.Material;
  readonly stain: THREE.Material;
  readonly runOff: THREE.Material;
  readonly line: THREE.Material;
  readonly tyres: THREE.Material;
  readonly sign: THREE.Material;
}

/** Faded machinery teal, safety yellow and the other coats used across the level. */
export const COAT = {
  teal: 0x4f8f8a,
  tealDark: 0x35706e,
  yellow: 0xd9a514,
  grey: 0x8b9396,
  cream: 0xc9c5b6,
  red: 0xa33a2c,
  blue: 0x2f5f86,
  black: 0x1b1d1f,
  door: 0x52666b,
} as const;

const LAMP_GAIN = 6;
export const TILE_FORMED = 1.8;
const TILE_GROUND = 3;

export function createMaterials(kit: Kit): Materials {
  const assets = kit.ctx.assets;
  const formed = assets.pbr('pbr-headworks-formed');
  const concrete = formedConcrete(formed);
  const concreteRound = formedConcrete(formed, TILE_FORMED);
  const slab = paving(assets.pbr('pbr-headworks-paving'), [0.2, 0.2, 0.193], 4, 0.1);
  const road = paving(assets.pbr('pbr-headworks-road'), [0.115, 0.118, 0.125], 6, 0.3);

  const matte = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.78, metalness: 0 });
  matte.colorNode = vec3(mix(float(0.8), float(1.05), worldNoise(2.4).mul(0.6).add(worldNoise(17).mul(0.4))));
  matte.vertexColors = true;

  // Glazing seen from outside by day: a dark room behind, pale slat blinds drawn to a different height in each bay.
  const glass = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0 });
  const bay: TslNode = floor(positionWorld.x.add(positionWorld.z).div(1.8)).add(400);
  const drawn: TslNode = step(fract(positionWorld.y.div(1.8)), mix(float(0.25), float(1), hash(bay.add(90))));
  const slat: TslNode = smoothstep(0.25, 0.4, fract(positionWorld.y.div(0.045)));
  glass.colorNode = mix(vec3(0.035, 0.05, 0.06), mix(vec3(0.2, 0.21, 0.2), vec3(0.5, 0.5, 0.47), slat), drawn.oneMinus().mul(step(0.35, hash(bay.add(7)))));
  // Still, slightly green process water; a low ripple keeps the sky's reflection from being a mirror.
  const water = new THREE.MeshStandardNodeMaterial({ color: 0x1d302c, roughness: 0.07, metalness: 0 });
  const ripple: TslNode = mx_noise_float(positionWorld.xz.mul(1.3));
  const ripple2: TslNode = mx_noise_float(positionWorld.xz.mul(1.3).add(vec2(31, 17)));
  water.normalNode = transformNormalToView(normalize(vec3(ripple.mul(0.03), 1, ripple2.mul(0.03))));

  const lamp = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
  lamp.color.setScalar(LAMP_GAIN);

  const lit = {
    concrete,
    concreteRound,
    paving: slab,
    road,
    paint: coatedSteel(),
    stainless: bareSteel(false),
    galvanised: bareSteel(true),
    matte,
    hazard: hazardStripes(),
    grating: grating(),
    glass,
    water,
    stain: stain(),
    runOff: runOff(),
    line: linePaint(),
    tyres: tyreMarks(),
    sign: signAtlas(kit),
  };
  const visibility = skyVisibility();
  for (const material of Object.values(lit)) shelter(material, visibility);
  const glow = lampGlow();
  for (const material of [concrete, concreteRound, slab, road, lit.paint, lit.galvanised, matte]) lampLit(material, glow);
  const materials: Materials = { ...lit, lamp };
  for (const material of Object.values(materials)) kit.own(material);

  kit.project(concrete, TILE_FORMED);
  kit.project(slab, TILE_GROUND);
  kit.project(road, TILE_GROUND);
  for (const flat of [slab, road, water, materials.stain, materials.runOff, materials.line, materials.tyres, materials.sign]) {
    kit.setShadows(flat, false, true);
  }
  kit.setShadows(lamp, false, false);
  return materials;
}
