import * as THREE from 'three/webgpu';
import {
  abs,
  dot,
  float,
  floor,
  fract,
  hash,
  materialAO,
  max,
  min,
  mix,
  mx_noise_float,
  normalMap,
  normalWorld,
  positionView,
  positionWorld,
  smoothstep,
  step,
  texture,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type { PbrMaps } from '../../core/assets';
import { HOUSES } from './plan';

/** TSL node graphs are typed loosely upstream; they are treated as opaque values here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TslNode = any;

/** 0 - 1 noise fixed in world space; `scale` is cycles per metre. */
export const worldNoise = (scale: number): TslNode => mx_noise_float(positionWorld.mul(scale)).mul(0.5).add(0.5);

const luma = (rgb: TslNode): TslNode => dot(rgb, vec3(0.3, 0.59, 0.11));
/** Distance in metres to the nearest line of a grid `spacing` apart, lines at half-cells. */
const toLine = (coordinate: TslNode, spacing: number): TslNode => abs(fract(coordinate.div(spacing)).sub(0.5)).mul(spacing);
/** 1 on faces that stand upright, 0 on floors and tops. */
const uprightFace = (): TslNode => smoothstep(0.35, 0.7, abs(normalWorld.y)).oneMinus();
/** Horizontal coordinate that runs along an upright face. */
const alongFace = (): TslNode => mix(positionWorld.x, positionWorld.z, step(0.5, abs(normalWorld.x)));

/** Share of sky light left in the middle of a pump house. */
const HOUSE_SKY = 0.2;

/**
 * How much of the sky a point can see, 0 - 1. The engine lights everything
 * from one sky image with no occlusion, so without this the pump houses would
 * be as bright inside as the yard. Daylight falls off inward from the walls
 * that have doors.
 */
export function skyVisibility(): TslNode {
  const p: TslNode = positionWorld;
  let visibility: TslNode = float(1);
  for (const house of HOUSES) {
    const inside: TslNode = step(house.x0 + 0.05, p.x)
      .mul(step(p.x, house.x1 - 0.05))
      .mul(step(house.z0 + 0.05, p.z))
      .mul(step(p.z, house.z1 + 0.3))
      .mul(step(p.y, house.height + 0.05));
    const fromWall: TslNode = min(min(p.x.sub(house.x0), float(house.x1).sub(p.x)), min(p.z.sub(house.z0), float(house.z1).sub(p.z)));
    const depth: TslNode = smoothstep(0.2, 4.5, fromWall);
    visibility = visibility.mul(mix(float(1), mix(float(0.55), float(HOUSE_SKY), depth), inside));
  }
  return visibility;
}

/** Fold the sky visibility into a lit material's ambient occlusion. */
export function shelter(material: THREE.MeshStandardNodeMaterial, visibility: TslNode): void {
  material.aoNode = material.aoMap ? materialAO.mul(visibility) : visibility;
}

function withMaps(material: THREE.MeshStandardNodeMaterial, maps: PbrMaps, normalScale: number): void {
  if (maps.normal) {
    material.normalMap = maps.normal;
    material.normalScale = new THREE.Vector2(normalScale, normalScale);
  }
  if (maps.arm) {
    material.aoMap = maps.arm;
    material.roughnessMap = maps.arm;
  }
  material.metalness = 0;
}

/**
 * Board-formed concrete, weathered chalk white. The scan gives the board
 * grain; everything that makes it a cast wall is added here in world space:
 * formwork panel seams and lift lines, tie holes with rust weeping from them,
 * run-off streaks, splash dirt and salt bloom along the foot, and a tone that
 * differs from pour to pour. Vertex colour tints it.
 */
export function formedConcrete(maps: PbrMaps, roundTile = 0): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff });
  withMaps(material, maps, 0.9);
  const p: TslNode = positionWorld;
  const grain: TslNode = luma(texture(maps.color, uv()).rgb).div(0.12).clamp(0.4, 1.6);
  const upright: TslNode = uprightFace();
  // Curved work carries its own UVs (`roundTile` metres per repeat); u is then the distance round the wall.
  const along: TslNode = roundTile > 0 ? uv().x.mul(roundTile) : alongFace();

  const panel: TslNode = floor(along.div(2.4).add(0.5)).add(300).add(floor(p.y.div(1.2).add(0.5)).add(40).mul(71));
  const pour: TslNode = mix(float(0.9), float(1.06), hash(panel));
  const seam: TslNode = smoothstep(0.004, 0.016, min(toLine(along, 2.4), toLine(p.y, 1.2))).oneMinus().mul(upright);
  const hx: TslNode = fract(along.div(0.6)).sub(0.5).mul(0.6);
  const hy: TslNode = fract(p.y.div(0.6)).sub(0.5).mul(0.6);
  const hole: TslNode = smoothstep(0.012, 0.024, vec2(hx, hy).length()).oneMinus().mul(upright);
  const weeps: TslNode = step(0.62, hash(floor(along.div(0.6)).add(floor(p.y.div(0.6)).mul(13)).add(500)));
  const drip: TslNode = smoothstep(0.008, 0.03, abs(hx)).oneMinus().mul(smoothstep(-0.29, -0.02, hy)).mul(step(hy, 0)).mul(weeps).mul(upright);

  const run: TslNode = mx_noise_float(vec3(along.mul(2.1), p.y.mul(0.11), 3.7)).mul(0.5).add(0.5);
  const fineRun: TslNode = mx_noise_float(vec3(along.mul(8.5), p.y.mul(0.5), 9.1)).mul(0.5).add(0.5);
  const streak: TslNode = smoothstep(0.44, 0.8, run.mul(0.7).add(fineRun.mul(0.3))).mul(upright);
  // Faces that look down are lit by the sky image's sunlit brown ground; pull them back to a cool shade.
  const under: TslNode = smoothstep(0.1, 0.7, normalWorld.y.negate());
  const blotch: TslNode = mix(float(0.9), float(1.06), worldNoise(0.21));
  const patchy: TslNode = worldNoise(1.3);
  const foot: TslNode = smoothstep(0.02, 0.75, p.y).oneMinus().mul(mix(float(0.45), float(1), patchy)).mul(upright);
  const salt: TslNode = smoothstep(0.52, 0.7, worldNoise(0.9).mul(0.6).add(worldNoise(6).mul(0.4)))
    .mul(smoothstep(0.15, 0.5, p.y))
    .mul(smoothstep(0.6, 1.5, p.y).oneMinus())
    .mul(upright);
  // Tops weather darker than faces and carry grey lichen blooms.
  const top: TslNode = smoothstep(0.6, 0.9, normalWorld.y);
  const lichen: TslNode = smoothstep(0.55, 0.75, worldNoise(1.7).mul(0.55).add(worldNoise(11).mul(0.45))).mul(top);

  let color: TslNode = vec3(0.44, 0.436, 0.415).mul(mix(float(1), grain, 0.55)).mul(pour).mul(blotch);
  color = mix(color, color.mul(vec3(0.46, 0.45, 0.42)), streak.mul(0.8));
  color = mix(color, color.mul(vec3(0.5, 0.56, 0.68)), under);
  color = mix(color, color.mul(vec3(0.5, 0.48, 0.43)), foot.mul(0.75));
  color = mix(color, vec3(0.82, 0.83, 0.82), salt.mul(0.55));
  color = mix(color, color.mul(0.74), top.mul(0.6));
  color = mix(color, color.mul(vec3(0.6, 0.64, 0.6)), lichen.mul(0.6));
  color = mix(color, vec3(0.3, 0.17, 0.09), drip.mul(0.55));
  color = mix(color, color.mul(0.38), seam.mul(0.85));
  color = mix(color, vec3(0.03, 0.03, 0.03), hole);
  material.colorNode = color;
  material.roughness = 1;
  material.vertexColors = true;
  return material;
}

/** 1 on the joints of a square grid of slabs `spacing` metres across. */
function slabJoints(spacing: number, width: number): TslNode {
  return smoothstep(width * 0.3, width, min(toLine(positionWorld.x.add(spacing / 2), spacing), toLine(positionWorld.z.add(spacing / 2), spacing))).oneMinus();
}

function slabTone(spacing: number, low: number, high: number): TslNode {
  const cell: TslNode = floor(positionWorld.x.div(spacing)).add(200).add(floor(positionWorld.z.div(spacing)).add(200).mul(57));
  return mix(float(low), float(high), hash(cell));
}

/**
 * Ground slab cast in bays: cut joints, a different tone to each bay, dark
 * tracked-in dirt, salt left along the joints by a winter of gritting, and
 * the odd smooth patch where the surface has polished.
 */
export function paving(maps: PbrMaps, base: readonly [number, number, number], bay: number, average: number): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff });
  withMaps(material, maps, 1);
  // `average` is the scan's mean brightness, so only its texture is kept and the colour comes from `base`.
  const grain: TslNode = luma(texture(maps.color, uv()).rgb).div(average).clamp(0.45, 1.6);
  const joint: TslNode = slabJoints(bay, 0.03);
  const nearJoint: TslNode = slabJoints(bay, 0.5);
  const dirt: TslNode = smoothstep(0.42, 0.78, worldNoise(0.16).mul(0.6).add(worldNoise(1.1).mul(0.4)));
  const salt: TslNode = smoothstep(0.5, 0.72, worldNoise(0.6).mul(0.5).add(worldNoise(5).mul(0.5))).mul(nearJoint);
  const polished: TslNode = smoothstep(0.62, 0.8, worldNoise(0.33));
  let color: TslNode = vec3(base[0], base[1], base[2]).mul(mix(float(1), grain, 0.7)).mul(slabTone(bay, 0.86, 1.08));
  color = mix(color, color.mul(vec3(0.56, 0.55, 0.52)), dirt.mul(0.7));
  color = mix(color, color.mul(1.5).add(0.06), salt.mul(0.4));
  color = mix(color, color.mul(0.3), joint.mul(0.9));
  // Last night's frost has melted where the slab dips: damp patches with standing water at their middle.
  const low: TslNode = worldNoise(0.085).mul(0.62).add(worldNoise(0.37).mul(0.3)).add(worldNoise(2.3).mul(0.08));
  const damp: TslNode = smoothstep(0.5, 0.58, low);
  const puddle: TslNode = smoothstep(0.605, 0.63, low).mul(joint.oneMinus());
  color = mix(color, color.mul(vec3(0.56, 0.58, 0.6)), damp.mul(0.85));
  color = mix(color, color.mul(0.5), puddle);
  material.colorNode = color;
  material.roughness = 1;
  const dry: TslNode = mix(float(0.94), float(0.72), polished.mul(joint.oneMinus()));
  material.roughnessNode = mix(mix(dry, float(0.42), damp), float(0.06), puddle);
  // Standing water lies flat over the grain of the slab.
  if (maps.normal) material.normalNode = mix(normalMap(texture(maps.normal, uv())), normalMap(vec3(0.5, 0.5, 1)), puddle.mul(0.92));
  material.vertexColors = true;
  return material;
}

/**
 * Coated steel: plant, pipework and doors. Vertex colour is the coat. It has
 * faded unevenly, chipped to primer and rust in patches and gathered dirt in
 * vertical runs.
 */
export function coatedSteel(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, metalness: 0.1 });
  const fine: TslNode = worldNoise(9);
  const fade: TslNode = mix(float(0.82), float(1.1), worldNoise(0.7));
  const run: TslNode = mx_noise_float(positionWorld.mul(vec3(2.4, 0.25, 2.4))).mul(0.5).add(0.5);
  const grime: TslNode = smoothstep(0.5, 0.9, run.mul(0.7).add(fine.mul(0.3)));
  const chip: TslNode = smoothstep(0.71, 0.76, worldNoise(3.1).mul(0.55).add(worldNoise(17).mul(0.45)));
  const coat: TslNode = mix(vec3(fade), vec3(0.5, 0.48, 0.45), grime.mul(0.6));
  material.colorNode = mix(coat, vec3(0.5, 0.22, 0.1), chip.mul(0.85));
  material.roughnessNode = mix(float(0.42), float(0.8), max(grime, chip));
  material.vertexColors = true;
  return material;
}

/** Stainless pipe and plate with a brushed grain; `galvanised` makes it the duller zinc of rails and gratings. */
export function bareSteel(galvanised: boolean): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: galvanised ? 0x9da3a6 : 0xc6cace, metalness: galvanised ? 0.75 : 1 });
  const brushed: TslNode = mx_noise_float(positionWorld.mul(vec3(3, 60, 3))).mul(0.5).add(0.5);
  const spangle: TslNode = worldNoise(galvanised ? 22 : 4);
  const dull: TslNode = smoothstep(0.55, 0.85, worldNoise(1.2));
  material.colorNode = vec3(mix(float(0.8), float(1.05), spangle.mul(0.6).add(brushed.mul(0.4)))).mul(mix(float(1), float(0.78), dull));
  material.roughnessNode = mix(float(galvanised ? 0.5 : 0.34), float(galvanised ? 0.72 : 0.55), max(brushed.mul(0.6), dull));
  material.vertexColors = true;
  return material;
}

/** Bar grating seen from above: bright bearing bars over dark gaps, evening out with distance. UVs in metres. */
export function grating(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, metalness: 0.6, roughness: 0.55 });
  const bars: TslNode = step(0.4, fract(uv().x.div(0.04)));
  const cross: TslNode = step(0.9, fract(uv().y.div(0.1)));
  const near: TslNode = smoothstep(4, 14, positionView.z.negate()).oneMinus();
  const open: TslNode = bars.mul(cross.oneMinus()).mul(near);
  material.colorNode = mix(vec3(0.5, 0.52, 0.53).mul(mix(float(0.62), float(1), near.oneMinus().mul(0.4).add(0.6))), vec3(0.03, 0.03, 0.03), open);
  return material;
}

/** Diagonal yellow and black warning bands, fixed in world space. */
export function hazardStripes(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.6 });
  const stripe: TslNode = step(0.5, fract(positionWorld.x.add(positionWorld.y).add(positionWorld.z).div(0.3)));
  const wear: TslNode = mix(float(0.55), float(1), worldNoise(4.3));
  const scuff: TslNode = smoothstep(0.6, 0.72, worldNoise(2.2).mul(0.5).add(worldNoise(13).mul(0.5)));
  const paint: TslNode = mix(vec3(0.84, 0.62, 0.04), vec3(0.03, 0.03, 0.03), stripe).mul(wear);
  material.colorNode = mix(paint, vec3(0.45, 0.45, 0.43), scuff.mul(0.8));
  return material;
}
