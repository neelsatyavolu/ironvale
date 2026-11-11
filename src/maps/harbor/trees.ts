import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/** Welded icosphere, so it can be reshaped and still shade as one soft mass. */
function softSphere(detail: number): THREE.BufferGeometry {
  const raw = new THREE.IcosahedronGeometry(0.5, detail);
  raw.deleteAttribute('normal');
  raw.deleteAttribute('uv');
  const welded = mergeVertices(raw, 1e-4);
  raw.dispose();
  return welded;
}

/**
 * Crown of a stone pine, one unit wide and tall: a flat-bottomed umbrella
 * whose rim breaks into rounded lobes, with a domed top that is higher on one
 * side. The base sits where the trunk forks.
 */
export function stonePineCrown(): THREE.BufferGeometry {
  const geometry = softSphere(2);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const around = Math.atan2(z, x);
    const lobes = 1 + 0.16 * Math.cos(around * 5 + 0.7) + 0.09 * Math.cos(around * 9 + 2.1) + 0.07 * Math.sin(around * 3 + y * 9);
    // Underside nearly flat and tucked in; top domed and lumpy.
    const top = y > 0;
    const height = top ? y * (0.5 + 0.1 * Math.cos(around * 4 + 1.3) + 0.08 * Math.sin(x * 11 + z * 7)) : y * 0.14;
    const reach = top ? lobes : lobes * (1 - 0.3 * Math.min(1, -y * 3));
    position.setXYZ(i, x * reach, 0.74 + height, z * reach);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Bare trunk of a stone pine, leaning a little, forking into three limbs under the crown. */
export function stonePineTrunk(): THREE.BufferGeometry[] {
  const limb = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r0: number, r1: number): THREE.BufferGeometry => {
    const from = new THREE.Vector3(x0, y0, z0);
    const to = new THREE.Vector3(x1, y1, z1);
    const geometry = new THREE.CylinderGeometry(r1, r0, from.distanceTo(to), 5, 1, true);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()));
    geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return geometry;
  };
  return [
    limb(0, 0, 0, 0.03, 0.5, 0.01, 0.034, 0.024),
    limb(0.03, 0.5, 0.01, 0.2, 0.74, 0.06, 0.02, 0.01),
    limb(0.03, 0.5, 0.01, -0.17, 0.75, 0.1, 0.02, 0.01),
    limb(0.03, 0.5, 0.01, -0.02, 0.76, -0.2, 0.018, 0.01),
  ];
}

/**
 * Unit-height Italian cypress: a narrow flame that is fullest low down, with
 * a ragged outline from foliage standing off the column in vertical flutes.
 */
export function cypressTree(): THREE.BufferGeometry {
  const profile = [
    [0.001, 0],
    [0.07, 0.015],
    [0.125, 0.09],
    [0.15, 0.22],
    [0.148, 0.38],
    [0.13, 0.55],
    [0.1, 0.72],
    [0.06, 0.87],
    [0.025, 0.96],
    [0.001, 1],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const lathe = new THREE.LatheGeometry(profile, 10);
  lathe.deleteAttribute('normal');
  lathe.deleteAttribute('uv');
  const geometry = mergeVertices(lathe, 1e-4);
  lathe.dispose();
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const around = Math.atan2(z, x);
    const flute = 1 + 0.2 * Math.cos(around * 5 + y * 7) * Math.sin(y * Math.PI) + 0.12 * Math.sin(around * 3 - y * 23);
    position.setXYZ(i, x * flute + 0.012 * Math.sin(y * 9), y, z * flute);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Low rounded shrub for macchia scrub. */
export function scrubBush(): THREE.BufferGeometry {
  // Thousands of these stand on the hill, so each is the coarsest sphere there is.
  const geometry = softSphere(0);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const lump = 1 + 0.22 * Math.sin(x * 10.6 + y * 6.2) * Math.cos(z * 9.4 - y * 4.6);
    position.setXYZ(i, x * lump, 0.3 + Math.max(y, -0.2) * lump * 0.8, z * lump);
  }
  geometry.computeVertexNormals();
  return geometry;
}
