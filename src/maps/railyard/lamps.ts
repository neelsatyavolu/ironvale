import * as THREE from 'three/webgpu';
import { diffuseColor, dot, float, max, normalWorld, positionWorld, smoothstep, vec3 } from 'three/tsl';
import { RTG, STS } from './cranes';
import { WAREHOUSE, YARD } from './plan';
import type { TslNode } from './surfaces';

export const WARM = 0xffd9a8;
export const SODIUM = 0xffb070;
export const POLE_HEIGHT = 11;

/** Floodlight mast positions: [x, z, heading of the lamp head in radians]. */
export const POLES: readonly (readonly [number, number, number])[] = [
  [20.9, 37, 2.3],
  [33.3, -9, -1.9],
  [-11.9, -33.4, 0.4],
  [22.6, -33.2, -0.6],
  [-18.8, 21.2, -2.2],
];

/** Bulkhead lamp on a wall: where it is, which way the wall faces and its colour. */
export interface WallLamp {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly nz: number;
  readonly color: number;
}

function wallLamps(): WallLamp[] {
  const lamps: WallLamp[] = [];
  const door = WAREHOUSE.door;
  for (const z of [WAREHOUSE.north, WAREHOUSE.south]) {
    const out = z === WAREHOUSE.north ? -1 : 1;
    for (const x of [door.west - 1.4, door.east + 1.4]) lamps.push({ x, y: 4.2, z: z + out * 0.06, nx: 0, nz: out, color: SODIUM });
  }
  for (let z = WAREHOUSE.north + WAREHOUSE.bay / 2; z < WAREHOUSE.south; z += WAREHOUSE.bay * 2) {
    lamps.push({ x: WAREHOUSE.east + 0.02, y: 5.9, z, nx: 1, nz: 0, color: SODIUM });
  }
  for (const x of [-30, -12, 14, 30]) lamps.push({ x, y: 2.9, z: YARD.south - 0.02, nx: 0, nz: -1, color: WARM });
  for (const z of [34, -36]) lamps.push({ x: YARD.west + 0.02, y: 2.9, z, nx: 1, nz: 0, color: WARM });
  for (const x of [STS.west, STS.east]) lamps.push({ x, y: 4.4, z: STS.landside + 0.72, nx: 0, nz: 1, color: WARM });
  return lamps;
}

export const WALL_LAMPS: readonly WallLamp[] = wallLamps();

/** A lamp as the surface shader sees it: a point, a colour, a strength and how far it reaches. */
interface Glow {
  readonly at: readonly [number, number, number];
  readonly color: number;
  readonly strength: number;
  readonly reach: number;
  /** Floods only light what is below them, and never bloom on the steel they hang from. */
  readonly down?: boolean;
  /** Wall lamps only light the side of the wall they hang on. */
  readonly facing?: readonly [number, number];
}

function glows(): Glow[] {
  const list: Glow[] = WALL_LAMPS.map((lamp) => ({
    at: [lamp.x + lamp.nx * 0.5, lamp.y - 0.15, lamp.z + lamp.nz * 0.5],
    color: lamp.color,
    strength: lamp.y > 5 ? 46 : 26,
    reach: lamp.y > 5 ? 13 : 9,
    facing: [lamp.nx, lamp.nz],
  }));
  // The masts that carry no real spot light, and the lamps under the cranes' beams.
  for (const [x, z, heading] of [POLES[3], POLES[4]] as const) {
    list.push({ at: [x + Math.sin(heading) * 3, POLE_HEIGHT, z + Math.cos(heading) * 3], color: WARM, strength: 150, reach: 30, down: true });
  }
  const sts = (STS.west + STS.east) / 2;
  list.push({ at: [sts, STS.portal - 0.5, STS.landside], color: 0xfff0d2, strength: 110, reach: 24, down: true });
  for (const x of [RTG.west + 5.5, RTG.east - 5.5]) {
    list.push({ at: [x, RTG.girder - 0.4, (RTG.north + RTG.south) / 2], color: 0xfff0d2, strength: 190, reach: 30, down: true });
  }
  return list;
}

/**
 * Light from the lamp fittings that have no real light behind them, summed in
 * the surface shader: cheap, unshadowed and short-ranged, so every bulkhead
 * lamp throws a warm pool on its wall and the ground under it. Multiplied by
 * the surface colour and used as emission.
 */
export function lampGlow(): TslNode {
  const p: TslNode = positionWorld;
  const n: TslNode = normalWorld;
  let total: TslNode = vec3(0, 0, 0);
  for (const lamp of glows()) {
    const toLamp: TslNode = vec3(...lamp.at).sub(p);
    const distance: TslNode = toLamp.length().max(0.05);
    const lambert: TslNode = max(dot(n, toLamp.div(distance)), 0).mul(0.85).add(0.15);
    let amount: TslNode = lambert
      .mul(float(lamp.strength).div(distance.mul(distance).add(4)))
      .mul(smoothstep(lamp.reach * 0.35, lamp.reach, distance).oneMinus());
    if (lamp.down) amount = amount.mul(smoothstep(0.35, 0.8, toLamp.y.div(distance)));
    if (lamp.facing) {
      const inFront: TslNode = p.x.sub(lamp.at[0]).mul(lamp.facing[0]).add(p.z.sub(lamp.at[2]).mul(lamp.facing[1]));
      amount = amount.mul(smoothstep(-0.62, -0.52, inFront));
    }
    const tint = new THREE.Color(lamp.color);
    total = total.add(vec3(tint.r, tint.g, tint.b).mul(amount));
  }
  return total;
}

/** Add the lamp pools to a lit material. Call after its colour is final. */
export function lampLit(material: THREE.MeshStandardNodeMaterial, glow: TslNode): void {
  material.emissiveNode = (diffuseColor as TslNode).rgb.mul(glow);
}
