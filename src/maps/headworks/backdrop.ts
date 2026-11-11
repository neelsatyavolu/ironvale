import * as THREE from 'three/webgpu';
import { V, type Kit } from './kit';
import { COAT, type Materials } from './materials';
import { HALF_X, HALF_Z } from './plan';
import { buildRange } from './range';
import { buildSky } from './sky';

/** Everything outside the wall: the sky, the mountains and the things that show above the wall. */
export function buildBackdrop(kit: Kit, m: Materials): void {
  buildSky(kit);
  buildRange(kit);
  buildSkyline(kit, m);
}

/** Lattice pylon: four legs tapering to a head with three cross-arms. */
function pylon(kit: Kit, m: Materials, x: number, z: number, height: number, yaw: number): void {
  const base = height * 0.11;
  const frame = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, 0, z);
  const p = (lx: number, y: number, lz: number): THREE.Vector3 => V(lx, y, lz).applyMatrix4(frame);
  const spread = (y: number): number => base * (1 - (y / height) * 0.86);
  const levels = 7;
  for (let i = 0; i < levels; i++) {
    const y0 = (height * 0.8 * i) / levels;
    const y1 = (height * 0.8 * (i + 1)) / levels;
    const [s0, s1] = [spread(y0), spread(y1)];
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, -1],
      [-1, 1],
    ] as const) {
      kit.beam(m.galvanised, p(sx * s0, y0, sz * s0), p(sx * s1, y1, sz * s1), 0.16);
      // One diagonal per face per level, alternating direction.
      const [nx, nz] = [-sz, sx];
      const flip = i % 2 === 0;
      kit.beam(m.galvanised, p(sx * (flip ? s0 : s1), flip ? y0 : y1, sz * (flip ? s0 : s1)), p(nx * (flip ? s1 : s0), flip ? y1 : y0, nz * (flip ? s1 : s0)), 0.09);
    }
  }
  const top = spread(height * 0.8);
  for (const [sx, sz] of [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ] as const) {
    kit.beam(m.galvanised, p(sx * top, height * 0.8, sz * top), p(0, height, 0), 0.12);
  }
  for (const [y, reach] of [
    [height * 0.8, height * 0.24],
    [height * 0.9, height * 0.18],
  ] as const) {
    kit.beam(m.galvanised, p(-reach, y, 0), p(reach, y, 0), 0.14);
    for (const s of [-1, 1]) kit.tube(m.matte, p(s * reach, y, 0), p(s * reach, y - 1.6, 0), 0.05, COAT.black, 5);
  }
}

/**
 * Things that stand just outside the wall and show above it: the intake tower
 * and surge shaft to the north, and a power line marching up the valley.
 */
function buildSkyline(kit: Kit, m: Materials): void {
  const north = -HALF_Z - 14;
  // Intake tower: a tall shaft with a cantilevered head and a slot window.
  kit.slab(m.concrete, 22, 29, 0, 19, north - 7, north, 0.12, 0xe7e4dc);
  kit.slab(m.concrete, 20.6, 30.4, 19, 23.5, north - 8.4, north + 1.4, 0.14, 0xf0ede6);
  kit.slab(m.glass, 21.4, 29.6, 20.6, 21.8, north + 1.38, north + 1.44, 0.01);
  kit.slab(m.concrete, -31, -22, 0, 9.5, north - 6, north + 1, 0.12, 0xdcd9d1);
  kit.slab(m.concrete, -31.6, -21.4, 9.5, 10.4, north - 6.6, north + 1.6, 0.08, 0xe9e6de);
  // South of the wall: the long roof of the old filter house.
  const south = HALF_Z + 9;
  kit.slab(m.concrete, -30, 34, 0, 7.4, south, south + 14, 0.12, 0xd9d6ce);
  kit.slab(m.concrete, -31, 35, 7.4, 8.3, south - 1, south + 15, 0.08, 0xe6e3db);
  for (let x = -26; x < 34; x += 6) kit.slab(m.glass, x, x + 3.6, 4.6, 6.4, south - 0.04, south + 0.02, 0.01);
  kit.slab(m.concrete, HALF_X + 12, HALF_X + 22, 0, 11, -12, 6, 0.12, 0xe2dfd7);
  kit.slab(m.concrete, -HALF_X - 24, -HALF_X - 11, 0, 8.6, -20, -2, 0.12, 0xe0ddd5);

  const line: readonly (readonly [number, number, number])[] = [
    [-HALF_X - 30, 34, 34],
    [-HALF_X + 14, -HALF_Z - 46, 36],
    [36, -HALF_Z - 96, 38],
    [118, -HALF_Z - 168, 40],
  ];
  line.forEach(([x, z, height], i) => {
    pylon(kit, m, x, z, height, 0.55);
    const next = line[i + 1];
    if (!next) return;
    // Conductors sag between the arms of one pylon and the next.
    for (const [level, reach] of [
      [0.8, 0.24],
      [0.9, 0.18],
    ] as const) {
      for (const s of [-1, 1]) {
        const a = V(x + Math.cos(0.55) * s * reach * height, height * level - 1.6, z - Math.sin(0.55) * s * reach * height);
        const b = V(next[0] + Math.cos(0.55) * s * reach * next[2], next[2] * level - 1.6, next[1] - Math.sin(0.55) * s * reach * next[2]);
        const steps = 8;
        for (let k = 0; k < steps; k++) {
          const sag = (t: number): number => -5 * 4 * t * (1 - t);
          const [t0, t1] = [k / steps, (k + 1) / steps];
          kit.tube(m.matte, a.clone().lerp(b, t0).add(V(0, sag(t0), 0)), a.clone().lerp(b, t1).add(V(0, sag(t1), 0)), 0.035, COAT.black, 4);
        }
      }
    }
  });
}
