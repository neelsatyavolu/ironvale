import * as THREE from 'three/webgpu';
import { V } from './kit';
import type { Block } from './plan';

export type Side = 'n' | 's' | 'e' | 'w';

const NORMAL: Readonly<Record<Side, readonly [number, number]>> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
export const SIDES: readonly Side[] = ['n', 'e', 's', 'w'];

/**
 * A frame fixed to one side of a block, for hanging things on it: `u` runs
 * along the face (left to right when you look at it from outside, 0 at its
 * middle), `y` is height above the block's underside and `out` is distance
 * out from the face.
 */
export interface Face {
  readonly side: Side;
  readonly width: number;
  readonly height: number;
  readonly normal: THREE.Vector3;
  /** Matrix for something centred at (u, y), `out` metres proud of the face, facing outward. */
  at(u: number, y: number, out?: number): THREE.Matrix4;
  point(u: number, y: number, out?: number): THREE.Vector3;
}

export function faceOf(b: Block, side: Side): Face {
  const [nx, nz] = NORMAL[side];
  const normal = V(nx, 0, nz);
  const up = V(0, 1, 0);
  // Looking at the face from outside, +u is to the viewer's right.
  const u = up.clone().cross(normal);
  const cx = (b.x0 + b.x1) / 2 + (nx * (b.x1 - b.x0)) / 2;
  const cz = (b.z0 + b.z1) / 2 + (nz * (b.z1 - b.z0)) / 2;
  const basis = new THREE.Matrix4().makeBasis(u, up, normal).setPosition(cx, b.y, cz);
  const at = (du: number, y: number, out = 0): THREE.Matrix4 => basis.clone().multiply(new THREE.Matrix4().makeTranslation(du, y, out));
  return {
    side,
    width: nx !== 0 ? b.z1 - b.z0 : b.x1 - b.x0,
    height: b.h,
    normal,
    at,
    point: (du, y, out = 0) => V(du, y, out).applyMatrix4(basis),
  };
}

/** The two long sides of a block, then the two short ones. */
export function longSides(b: Block): readonly [Side, Side, Side, Side] {
  return b.x1 - b.x0 >= b.z1 - b.z0 ? ['n', 's', 'e', 'w'] : ['e', 'w', 'n', 's'];
}

/** Block shrunk by `inset` on every side, between two heights above its underside. */
export function inner(b: Block, inset: number, y0: number, y1: number): Block {
  return { ...b, x0: b.x0 + inset, x1: b.x1 - inset, z0: b.z0 + inset, z1: b.z1 - inset, y: b.y + y0, h: y1 - y0 };
}
