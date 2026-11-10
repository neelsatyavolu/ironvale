import type * as THREE from 'three/webgpu';
import { abs, float, materialAO, max, mix, positionWorld, smoothstep, step } from 'three/tsl';
import { OFFICE as O, WAREHOUSE as W } from './plan';
import type { TslNode } from './surfaces';

/** Share of sky light left deep inside the shed, under the mezzanine and in the office. */
const SHED_FLOOR = 0.14;
const UNDER_DECK = 0.55;
const OFFICE_FLOOR = 0.24;

const between = (value: TslNode, low: number, high: number): TslNode => step(low, value).mul(step(value, high));

/**
 * How much of the sky a point can see, 0 - 1. The engine lights everything
 * from one sky image with no occlusion, so without this a roofed space is as
 * bright as the open yard. Used as the ambient occlusion of every material:
 * interiors fall dark, and the sun through the doors and the lamps do the rest.
 */
export function skyVisibility(): TslNode {
  const p: TslNode = positionWorld;
  const ridgeX = (W.west + W.east) / 2;
  const halfSpan = (W.east - W.west) / 2;
  const roofY: TslNode = float(W.ridge).sub(abs(p.x.sub(ridgeX)).div(halfSpan).mul(W.ridge - W.eaves));
  const inShed: TslNode = between(p.x, W.west + 0.1, W.east - 0.02)
    .mul(between(p.z, W.north - 0.02, W.south + 0.02))
    .mul(step(p.y, roofY.add(0.02)));

  // Daylight reaches in from the open yard side and through the two cargo doors.
  const doorX = (W.door.west + W.door.east) / 2;
  const acrossDoor: TslNode = smoothstep(3.5, 9, abs(p.x.sub(doorX))).oneMinus();
  const fromEast: TslNode = smoothstep(W.east - 8, W.east + 0.5, p.x).mul(smoothstep(4.5, 7.5, p.y).oneMinus());
  const fromNorth: TslNode = smoothstep(W.north, W.north + 9, p.z).oneMinus().mul(acrossDoor);
  const fromSouth: TslNode = smoothstep(W.south - 7, W.south, p.z).mul(acrossDoor);
  const daylight: TslNode = max(fromEast.mul(0.8), max(fromNorth.mul(0.75), fromSouth.mul(0.55)));
  const mezz = W.mezzanine;
  const underDeck: TslNode = step(p.x, mezz.east).mul(between(p.z, mezz.north, mezz.south)).mul(step(p.y, mezz.top - 0.08));
  const shed: TslNode = mix(float(SHED_FLOOR), float(1), daylight).mul(mix(float(1), float(UNDER_DECK), underDeck));

  const inOffice: TslNode = between(p.x, O.west + 0.05, O.east - 0.05)
    .mul(between(p.z, O.north + 0.05, O.south - 0.05))
    .mul(step(p.y, O.height - 0.1));
  return mix(mix(float(1), shed, inShed), float(OFFICE_FLOOR), inOffice);
}

/** Fold the sky visibility into a lit material's ambient occlusion. */
export function shelter(material: THREE.MeshStandardNodeMaterial, visibility: TslNode): void {
  material.aoNode = material.aoMap ? materialAO.mul(visibility) : visibility;
}
