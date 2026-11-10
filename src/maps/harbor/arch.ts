import * as THREE from 'three/webgpu';

const SEGMENTS = 14;

/**
 * Wall panel `width` x `height` with an arched doorway cut up from the floor,
 * extruded to `thickness` and centred on Z. The arch is a half ellipse that
 * springs at `spring` and rises `rise` above it.
 */
export function archInsert(width: number, height: number, openWidth: number, spring: number, rise: number, thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const hw = width / 2;
  const ho = openWidth / 2;
  shape.moveTo(-hw, 0);
  shape.lineTo(-ho, 0);
  shape.lineTo(-ho, spring);
  shape.absellipse(0, spring, ho, rise, Math.PI, 0, true);
  shape.lineTo(ho, 0);
  shape.lineTo(hw, 0);
  shape.lineTo(hw, height);
  shape.lineTo(-hw, height);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: SEGMENTS });
  geometry.translate(0, 0, -thickness / 2);
  return geometry;
}

/** Flat arched panel facing +Z, for a closed gate or church door. */
export function archedPanel(openWidth: number, spring: number, rise: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const ho = openWidth / 2;
  shape.moveTo(-ho, 0);
  shape.lineTo(ho, 0);
  shape.lineTo(ho, spring);
  shape.absellipse(0, spring, ho, rise, 0, Math.PI, false);
  shape.lineTo(-ho, 0);
  shape.closePath();
  return new THREE.ShapeGeometry(shape, SEGMENTS);
}

/** Raised stone band around an arched opening, `band` wide and `depth` proud of the wall. */
export function archSurround(openWidth: number, spring: number, rise: number, band: number, depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const ho = openWidth / 2;
  shape.moveTo(-ho - band, 0);
  shape.lineTo(-ho - band, spring);
  shape.absellipse(0, spring, ho + band, rise + band, Math.PI, 0, true);
  shape.lineTo(ho + band, 0);
  shape.lineTo(ho, 0);
  shape.lineTo(ho, spring);
  shape.absellipse(0, spring, ho, rise, 0, Math.PI, false);
  shape.lineTo(-ho, 0);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: SEGMENTS });
}
