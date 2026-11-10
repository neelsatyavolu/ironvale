import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  cross,
  distance,
  dot,
  float,
  max,
  mix,
  mx_noise_float,
  normalize,
  positionWorld,
  smoothstep,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { PLAY, type Heightfield } from './layout';
import type { Crown } from './trees';

/** TSL graphs are loosely typed upstream; keep that looseness inside this file. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

const CELL = 8;
const MAX_LENGTH = 44;
const SEGMENTS = 4;

/** Is the path from a point toward the sun clear of every crown for `reach` metres? */
function sunlit(grid: Map<string, Crown[]>, origin: THREE.Vector3, sun: THREE.Vector3, reach: number): boolean {
  for (let s = 1.5; s < reach; s += 1.2) {
    const x = origin.x + sun.x * s;
    const y = origin.y + sun.y * s;
    const z = origin.z + sun.z * s;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) {
      for (let k = -1; k <= 1; k++) {
        for (const crown of grid.get(`${cx + i},${cz + k}`) ?? []) {
          if (y < crown.bottom - 0.6 || y > crown.top) continue;
          const t = (y - crown.bottom) / (crown.top - crown.bottom);
          const radius = crown.reach * (1 - Math.max(0, t) ** 1.25) * 0.92 + 0.35;
          if ((x - crown.x) ** 2 + (z - crown.z) ** 2 < radius * radius) return false;
        }
      }
    }
  }
  return true;
}

/**
 * Sun shafts as additive ribbons. The engine's ray-marched light shafts are
 * too faint to read in this fog, so the map places its own: a beam wherever a
 * clear line runs from the forest floor up through the canopy to the sun. Each
 * ribbon turns about the sun's axis to face the viewer.
 */
export function buildShafts(
  crowns: readonly Crown[],
  field: Heightfield,
  sun: THREE.Vector3,
  sunColor: number,
  random: () => number,
  count: number,
): { readonly mesh: THREE.Mesh; dispose(): void } {
  const grid = new Map<string, Crown[]>();
  for (const crown of crowns) {
    const key = `${Math.floor(crown.x / CELL)},${Math.floor(crown.z / CELL)}`;
    const list = grid.get(key);
    if (list) list.push(crown);
    else grid.set(key, [crown]);
  }
  const side = new THREE.Vector3().crossVectors(sun, new THREE.Vector3(0, 1, 0)).normalize();
  const reach = 30 / sun.y;

  const base: number[] = [];
  const axis: number[] = [];
  const halfWidth: number[] = [];
  const seed: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const origin = new THREE.Vector3();
  const probe = new THREE.Vector3();
  let made = 0;
  for (let attempt = 0; attempt < count * 400 && made < count; attempt++) {
    const x = PLAY.minX + random() * (PLAY.maxX - PLAY.minX);
    const z = PLAY.minZ + random() * (PLAY.maxZ - PLAY.minZ);
    origin.set(x, field.sample(x, z), z);
    if (!sunlit(grid, origin, sun, reach)) continue;
    // Widen the beam while both edges still see the sun.
    let half = 0;
    for (const candidate of [0.7, 1.3, 2.0]) {
      const clear = [-1, 1].every((dir) => sunlit(grid, probe.copy(origin).addScaledVector(side, dir * candidate), sun, reach));
      if (!clear) break;
      half = candidate;
    }
    if (half === 0) continue;
    const length = Math.min(MAX_LENGTH, (22 + random() * 8) / sun.y);
    const start = base.length / 3;
    const shaftSeed = random() * 100;
    for (let row = 0; row <= SEGMENTS; row++) {
      for (const edge of [-1, 1]) {
        base.push(origin.x - sun.x * 0.4, origin.y - sun.y * 0.4, origin.z - sun.z * 0.4);
        axis.push(sun.x * length, sun.y * length, sun.z * length);
        halfWidth.push(edge * half * (0.9 + random() * 0.2));
        seed.push(shaftSeed);
        uvs.push(edge * 0.5 + 0.5, row / SEGMENTS);
      }
      if (row < SEGMENTS) {
        const a = start + row * 2;
        index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    }
    made++;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(base, 3));
  geometry.setAttribute('shaftAxis', new THREE.Float32BufferAttribute(axis, 3));
  geometry.setAttribute('shaftHalf', new THREE.Float32BufferAttribute(halfWidth, 1));
  geometry.setAttribute('shaftSeed', new THREE.Float32BufferAttribute(seed, 1));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const shaftAxis: TslNode = attribute('shaftAxis', 'vec3');
  const centre: TslNode = attribute('position', 'vec3').add(shaftAxis.mul(uv().y));
  const toCamera: TslNode = cameraPosition.sub(centre);
  const axisDir: TslNode = normalize(shaftAxis);
  const sideways: TslNode = normalize(cross(axisDir, toCamera));
  material.positionNode = centre.add(sideways.mul(attribute('shaftHalf', 'float')));

  const sunDir: TslNode = vec3(sun.x, sun.y, sun.z);
  const across: TslNode = uv().x;
  const along: TslNode = uv().y;
  const profile: TslNode = smoothstep(0, 0.5, across).mul(smoothstep(1, 0.5, across)).pow(1.4);
  const ends: TslNode = smoothstep(0, 0.035, along).mul(smoothstep(1, 0.45, along));
  const streakUv: TslNode = vec2(across.mul(5).add(attribute('shaftSeed', 'float')), along.mul(1.3));
  const streaks: TslNode = mx_noise_float(streakUv).mul(0.5).add(0.5);
  const range: TslNode = distance(cameraPosition, positionWorld);
  // Mist scatters forward: beams are brightest looking up-sun, faint looking down-sun.
  const facing: TslNode = max(dot(normalize(positionWorld.sub(cameraPosition)), sunDir), 0);
  // A ribbon cannot stand in for a beam seen end-on, so it fades out as the view lines up with the sun.
  const phase: TslNode = float(0.22).add(facing.pow(2.5).mul(0.78)).mul(smoothstep(0.97, 0.72, facing));
  // Close up a ribbon reads as a flat sheet, so beams only build up from a few metres away.
  const fade: TslNode = smoothstep(3, 16, range).mul(smoothstep(95, 45, range));
  const strength: TslNode = profile.mul(ends).mul(mix(float(0.55), float(1), streaks)).mul(phase).mul(fade);
  const tint = new THREE.Color(sunColor);
  material.colorNode = vec4(vec3(tint.r, tint.g, tint.b).mul(strength).mul(0.36), float(1));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return {
    mesh,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
