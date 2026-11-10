import * as THREE from 'three/webgpu';
import { clamp, float, max, positionWorld, step, texture, vec2 } from 'three/tsl';
import { ALLEY, RAMP, TERRACE_Y } from './layout';

// TSL node types are too loose in @types/three to be worth threading through.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TslNode = any;

const SIZE = 256;

/** Tileable value noise: `octaves` layers on lattices that wrap at the texture edge. Result is stretched to 0 - 1. */
function tileNoise(freqX: number, freqY: number, octaves: number, random: () => number): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  let amplitude = 1;
  for (let octave = 0; octave < octaves; octave++) {
    const fx = freqX * 2 ** octave;
    const fy = freqY * 2 ** octave;
    const lattice = new Float32Array(fx * fy);
    for (let i = 0; i < lattice.length; i++) lattice[i] = random();
    const at = (ix: number, iy: number): number => lattice[(iy % fy) * fx + (ix % fx)]!;
    for (let y = 0; y < SIZE; y++) {
      const gy = (y / SIZE) * fy;
      const iy = Math.floor(gy);
      const ty = gy - iy;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < SIZE; x++) {
        const gx = (x / SIZE) * fx;
        const ix = Math.floor(gx);
        const tx = gx - ix;
        const sx = tx * tx * (3 - 2 * tx);
        const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
        const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
        out[y * SIZE + x]! += (top + (bottom - top) * sy) * amplitude;
      }
    }
    amplitude *= 0.5;
  }
  let low = Infinity;
  let high = -Infinity;
  for (const value of out) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  for (let i = 0; i < out.length; i++) out[i] = (out[i]! - low) / (high - low);
  return out;
}

/**
 * One small noise atlas shared by every weathered material, so dirt costs a
 * texture fetch instead of procedural noise per pixel.
 *
 *   R  broad blotches            G  vertical drips (fine across, long down)
 *   B  fine grain                A  island shapes, for thresholding into patches
 */
export function createGrimeMap(random: () => number): THREE.DataTexture {
  const channels = [tileNoise(4, 4, 5, random), tileNoise(40, 3, 3, random), tileNoise(24, 24, 3, random), tileNoise(6, 6, 5, random)];
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(channels[c]![i]! * 255);
  }
  const map = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  return map;
}

/** Samples the atlas in metres: `scale` is the size one repeat covers. */
export function grimeSampler(map: THREE.Texture): (coord: TslNode, scale: number | TslNode, offset?: number) => TslNode {
  return (coord, scale, offset = 0) => texture(map, coord.div(scale).add(offset));
}

/** Along-wall and height coordinate for axis-aligned walls: one of x or z is constant on any wall. */
export const wallCoord = vec2(positionWorld.x.add(positionWorld.z), positionWorld.y);
export const groundCoord = positionWorld.xz;

/**
 * Height of the street under a wall, from the terraced layout: quay level,
 * the terrace, then the two unreachable tiers behind, with the stepped alley
 * and the east ramp climbing between the first two.
 */
function groundLevel(): TslNode {
  const x = positionWorld.x;
  const z = positionWorld.z;
  const tiers = step(z, float(-15.8))
    .mul(TERRACE_Y)
    .add(step(z, float(-34)).mul(9.2 - TERRACE_Y))
    .add(step(z, float(-48)).mul(17.4 - 9.2));
  const inAlley = step(float(ALLEY.x0 - 0.3), x).mul(step(x, float(ALLEY.x1 + 0.3)));
  const alley = clamp(float(ALLEY.stepsFromZ).sub(z).div(ALLEY.risers * ALLEY.tread), 0, 1).mul(TERRACE_Y);
  const inRamp = step(float(RAMP.x0 - 0.3), x).mul(step(x, float(RAMP.x1 + 0.3)));
  const ramp = clamp(float(RAMP.z1).sub(z).div(RAMP.z1 - RAMP.z0), 0, 1).mul(TERRACE_Y);
  return max(tiers, max(inAlley.mul(alley), inRamp.mul(ramp)));
}

/** Height of a wall fragment above the street it stands on. */
export const heightAboveStreet = positionWorld.y.sub(groundLevel());
