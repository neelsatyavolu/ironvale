import * as THREE from 'three/webgpu';
import { float, positionLocal, smoothstep } from 'three/tsl';
import type { Kit } from './facade';
import { projectUv } from './kit';
import { WATER_Y } from './layout';

/** Ridge line of a headland: [x, z, crest height, half-width at sea level]. */
type Ridge = readonly (readonly [number, number, number, number])[];

/**
 * The two arms of the bay. They run out from the ends of the mountain and
 * stand in front of the coastline baked into the sky panorama, which shows a
 * different town; the sun sets in the open water between them.
 */
const WEST_CAPE: Ridge = [
  [-290, -150, 118, 140],
  [-360, -60, 100, 130],
  [-420, 40, 84, 120],
  [-440, 140, 66, 100],
  [-415, 215, 50, 80],
  [-375, 262, 40, 58],
  [-350, 286, 33, 42],
  [-338, 300, 20, 24],
  [-332, 308, 2, 12],
];
const EAST_CAPE: Ridge = [
  [290, -150, 112, 140],
  [370, -60, 94, 130],
  [430, 30, 76, 120],
  [455, 120, 58, 100],
  [440, 200, 42, 80],
  [405, 250, 28, 56],
  [380, 280, 2, 20],
];

const HAZE_RADIUS = 860;
const HAZE_TOP = 66;

function hash(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/** Headland lofted along its ridge: a rounded cross-section with gullies, steeper on the seaward side. */
function capeGeometry(ridge: Ridge, seed: number): THREE.BufferGeometry {
  const along = 44;
  const across = 12;
  const curve = new THREE.CatmullRomCurve3(ridge.map(([x, z]) => new THREE.Vector3(x, 0, z)));
  const positions: number[] = [];
  const indices: number[] = [];
  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  for (let i = 0; i <= along; i++) {
    const t = i / along;
    curve.getPoint(t, point);
    curve.getTangent(t, tangent);
    const f = t * (ridge.length - 1);
    const k = Math.min(ridge.length - 2, Math.floor(f));
    const mixAt = f - k;
    const crest = ridge[k]![2] + (ridge[k + 1]![2] - ridge[k]![2]) * mixAt;
    const half = ridge[k]![3] + (ridge[k + 1]![3] - ridge[k]![3]) * mixAt;
    for (let j = 0; j <= across; j++) {
      const v = (j / across) * 2 - 1;
      // Rounded shoulder, with knolls along the crest and gullies down the flanks.
      const profile = Math.pow(Math.cos((v * Math.PI) / 2), 0.8);
      const knoll = 1 + 0.1 * Math.sin(t * 21 + seed) + 0.05 * Math.sin(t * 47 + seed * 2.3);
      const gully = 1 - 0.2 * Math.abs(Math.sin(v * 5 + t * 31 + seed)) * (1 - Math.abs(v));
      const ragged = 1 + (hash(i * 31 + j * 7 + seed) - 0.5) * 0.05;
      const reach = v * half * (1 + 0.12 * Math.sin(t * 17 + j + seed));
      positions.push(point.x - tangent.z * reach, WATER_Y - 3 + (crest + 3) * profile * knoll * gully * ragged, point.z + tangent.x * reach);
    }
  }
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * (across + 1) + j;
      const b = a + across + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Normals have to point up whichever way the ridge runs.
  const normal = geometry.getAttribute('normal');
  if (normal.getY(Math.floor(normal.count / 2)) < 0) {
    geometry.setIndex(indices.map((_, n) => indices[n - (n % 3) + [0, 2, 1][n % 3]!]!));
    geometry.computeVertexNormals();
  }
  projectUv(geometry, 14);
  return geometry;
}

/**
 * Sea haze at the horizon: a ring of fog-coloured air that is solid at the
 * waterline and clears a degree or two above it. It takes its colour from the
 * scene fog, so it warms toward the sun like everything else far away.
 */
function hazeBand(): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(HAZE_RADIUS, HAZE_RADIUS, HAZE_TOP - WATER_Y, 72, 1, true);
  geometry.translate(0, (HAZE_TOP + WATER_Y) / 2, 0);
  const material = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.BackSide });
  material.opacityNode = smoothstep(float(HAZE_TOP), float(20), positionLocal.y);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = 'harbor-haze';
  mesh.renderOrder = -1;
  return mesh;
}

/** The capes, a lighthouse on the western point and the horizon haze. */
export function addCapes(kit: Kit, root: THREE.Object3D): { dispose(): void } {
  const { batch, mats } = kit;
  batch.add(mats.hill, capeGeometry(WEST_CAPE, 1.7));
  batch.add(mats.hill, capeGeometry(EAST_CAPE, 4.2));

  // Lighthouse on the low western point: tapered tower, gallery, lantern and cap.
  const [lx, lz] = [-350, 286];
  const base = 30;
  const tower = new THREE.CylinderGeometry(2.1, 3.2, 20, 12);
  batch.place(mats.plasterWhite, tower, lx, base + 10, lz);
  const gallery = new THREE.CylinderGeometry(3.1, 2.6, 0.8, 12);
  batch.place(mats.iron, gallery, lx, base + 20.3, lz);
  const lantern = new THREE.CylinderGeometry(1.6, 1.6, 2.8, 10);
  batch.place(mats.lamp, lantern, lx, base + 22.1, lz);
  const cap = new THREE.ConeGeometry(2, 1.8, 10);
  batch.place(mats.iron, cap, lx, base + 24.4, lz);
  for (const geometry of [tower, gallery, lantern, cap]) geometry.dispose();
  batch.span(mats.plasterWhite, lx - 9, lx - 2.5, base - 2, base + 4.5, lz - 4, lz + 4, { tile: 3 });
  batch.span(mats.roof, lx - 9.4, lx - 2.1, base + 4.5, base + 5, lz - 4.4, lz + 4.4, { tile: 3 });
  const haze = hazeBand();
  root.add(haze);
  return {
    dispose: () => {
      haze.geometry.dispose();
      (haze.material as THREE.Material).dispose();
    },
  };
}
