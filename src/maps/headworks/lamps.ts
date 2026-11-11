import * as THREE from 'three/webgpu';
import { diffuseColor, dot, float, max, normalWorld, positionWorld, smoothstep, vec3 } from 'three/tsl';
import { BLOCKS, HALF_X, HALF_Z, isTwin } from './plan';
import type { TslNode } from './surfaces';

/** High-pressure sodium: the one warm thing in a cold yard. */
export const SODIUM = 0xffb873;
const DOOR_LAMP = 0xffd9a6;

/** Bulkhead lamp on a wall: where it is, which way the wall faces and its colour. */
export interface WallLamp {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly nz: number;
  readonly color: number;
}

/** Lamps along the long walls of the west half: [x, y, z, nx, nz]. The east half is the same turned half a turn. */
const HALF_WALL_LAMPS: readonly (readonly [number, number, number, number, number])[] = [
  [-34, 3.6, -5, 1, 0],
  [-34, 3.6, 5, 1, 0],
  [-HALF_X, 3.4, -28, 1, 0],
  [-HALF_X, 3.4, 20, 1, 0],
  [-14, 3.4, -19, 0, 1],
  [-31, 3.4, -23, 0, -1],
  [-25, 3.4, 20, 0, -1],
  [-36, 3.4, HALF_Z, 0, -1],
];

function wallLamps(): WallLamp[] {
  const lamps: WallLamp[] = [];
  // A bulkhead beside every door through a wall, on the sunless side first.
  for (const b of BLOCKS.filter((block) => block.id.includes('lintel'))) {
    const alongX = b.x1 - b.x0 > b.z1 - b.z0;
    const flip = isTwin(b) ? -1 : 1;
    if (alongX) lamps.push({ x: b.x1 + 0.5, y: 2.75, z: flip > 0 ? b.z0 : b.z1, nx: 0, nz: -flip, color: DOOR_LAMP });
    else lamps.push({ x: flip > 0 ? b.x0 : b.x1, y: 2.75, z: b.z1 + 0.5, nx: -flip, nz: 0, color: DOOR_LAMP });
  }
  for (const s of [1, -1]) {
    for (const [x, y, z, nx, nz] of HALF_WALL_LAMPS) lamps.push({ x: s * x, y, z: s * z, nx: s * nx, nz: s * nz, color: SODIUM });
  }
  return lamps;
}

export const WALL_LAMPS: readonly WallLamp[] = wallLamps();

/**
 * Light from the bulkhead lamps, summed in the surface shader: cheap,
 * unshadowed and short-ranged, so each lamp throws a warm pool on its wall
 * and the slab under it without a real light. In sunshine the pools are lost;
 * in the long blue shadows they are what the eye goes to.
 */
export function lampGlow(): TslNode {
  const p: TslNode = positionWorld;
  const n: TslNode = normalWorld;
  let total: TslNode = vec3(0, 0, 0);
  for (const lamp of WALL_LAMPS) {
    const high = lamp.y > 3;
    const reach = high ? 9 : 6.5;
    const at = [lamp.x + lamp.nx * 0.45, lamp.y - 0.12, lamp.z + lamp.nz * 0.45] as const;
    const toLamp: TslNode = vec3(...at).sub(p);
    const distance: TslNode = toLamp.length().max(0.05);
    const lambert: TslNode = max(dot(n, toLamp.div(distance)), 0).mul(0.85).add(0.15);
    // Wall lamps only light the side of the wall they hang on, and mostly what is below the hood.
    const inFront: TslNode = p.x.sub(at[0]).mul(lamp.nx).add(p.z.sub(at[2]).mul(lamp.nz));
    const amount: TslNode = lambert
      .mul(float(high ? 34 : 20).div(distance.mul(distance).add(3)))
      .mul(smoothstep(reach * 0.35, reach, distance).oneMinus())
      .mul(smoothstep(-0.6, -0.5, inFront))
      .mul(smoothstep(-0.5, 0.25, toLamp.y));
    const tint = new THREE.Color(lamp.color);
    total = total.add(vec3(tint.r, tint.g, tint.b).mul(amount));
  }
  return total;
}

/** Add the lamp pools to a lit material. Call after its colour is final. */
export function lampLit(material: THREE.MeshStandardNodeMaterial, glow: TslNode): void {
  material.emissiveNode = (diffuseColor as TslNode).rgb.mul(glow);
}
