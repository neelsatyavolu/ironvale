import * as THREE from 'three/webgpu';
import { dot, float, mix, mx_fractal_noise_float, normalWorld, positionWorld, smoothstep, vec3 } from 'three/tsl';
import type { Kit } from './kit';
import { LIGHTING } from './lighting';
import { TANK } from './plan';
import type { TslNode } from './surfaces';

const INNER = 300;
const OUTER = 840;
const SPOKES = 560;
const ROWS = 44;
const PEAK = 290;
/** Bearing (atan2(x, z)) of the view north through the slot, square to the line between the tank centres. */
const SLOT_BEARING = Math.atan2(-TANK.z, TANK.x);
/** Haze the range sinks into with distance; the same pale blue as the foot of the sky. */
const HAZE = [0.6, 0.71, 0.86] as const;
/** The range is drawn unlit, so its colours are scene-referred: this lifts sunlit snow to the brightness of sunlit concrete. */
const GAIN = 1.25;

const fold = (v: number): number => 1 - 2 * Math.abs(v);
const hash2 = (x: number, y: number): number => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
/** Smooth value noise, -1 to 1. */
function noise2(x: number, y: number): number {
  const [ix, iy] = [Math.floor(x), Math.floor(y)];
  const [fx, fy] = [x - ix, y - iy];
  const [ux, uy] = [fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)];
  const top = hash2(ix, iy) + (hash2(ix + 1, iy) - hash2(ix, iy)) * ux;
  const bottom = hash2(ix, iy + 1) + (hash2(ix + 1, iy + 1) - hash2(ix, iy + 1)) * ux;
  return (top + (bottom - top) * uy) * 2 - 1;
}
/** Ridged fractal: sharp crests with gullies running off them, 0 to 1. */
function ridged(x: number, y: number, octaves: number): number {
  let sum = 0;
  let weight = 0.5;
  let total = 0;
  for (let i = 0; i < octaves; i++) {
    const crest = 1 - Math.abs(noise2(x, y));
    sum += crest * crest * weight;
    total += weight;
    weight *= 0.5;
    x = x * 2.03 + 17.1;
    y = y * 2.03 - 9.3;
  }
  return sum / total;
}

/** Height of the range at a bearing and a distance from the level. */
export function mountainHeight(angle: number, distance: number): number {
  const t = THREE.MathUtils.clamp((distance - INNER) / (OUTER - INNER), 0, 1);
  // Foothills rise first, the main wall stands two thirds of the way out, and the far side falls away.
  const section = Math.sin(Math.min(1, t * 1.45) * Math.PI * 0.5) * (1 - Math.max(0, t - 0.72) * 2.2);
  const [x, z] = [Math.sin(angle) * distance, Math.cos(angle) * distance];
  // A few big massifs round the horizon, each cut into crests and gullies.
  const massif = 0.62 + 0.3 * Math.sin(angle * 3 + 1.3) + 0.2 * fold(Math.sin(angle * 5 + 4.1)) * t;
  const crests = ridged(x / 260, z / 260, 5);
  // One great peak stands on the line of the slot between the clarifiers, to be seen over the bridge.
  const off = Math.atan2(Math.sin(angle - SLOT_BEARING), Math.cos(angle - SLOT_BEARING));
  const horn = 1.25 * Math.exp(-((off / 0.24) ** 2)) * Math.sin(Math.min(1, t * 2.2) * Math.PI * 0.5);
  return section * (Math.max(0.38, massif) + horn) * (0.45 + 0.75 * crests) * PEAK;
}

/**
 * Mountains all round the station, outside the level. The terrain is a ring
 * of ridged ground; rock, scree and snow are worked out per pixel from height
 * and slope, lit by the level's sun and set back by haze. Nothing here is
 * lit by the scene, so the sky image's brown foreground cannot tint it.
 */
export function buildRange(kit: Kit): void {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= ROWS; row++) {
    const distance = INNER + ((OUTER - INNER) * row) / ROWS;
    for (let spoke = 0; spoke <= SPOKES; spoke++) {
      const angle = (spoke / SPOKES) * Math.PI * 2;
      positions.push(Math.sin(angle) * distance, mountainHeight(angle, distance) - 2, Math.cos(angle) * distance);
    }
  }
  const stride = SPOKES + 1;
  for (let row = 0; row < ROWS; row++) {
    for (let spoke = 0; spoke < SPOKES; spoke++) {
      const a = row * stride + spoke;
      // Wound so the faces look up and in toward the level.
      indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
    }
  }
  const terrain = kit.own(new THREE.BufferGeometry());
  terrain.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  terrain.setIndex(indices);
  terrain.computeVertexNormals();

  const p: TslNode = positionWorld;
  const n: TslNode = normalWorld;
  const sun = LIGHTING.sunDirection;
  const coarse: TslNode = mx_fractal_noise_float(p.mul(0.011), 4);
  const fine: TslNode = mx_fractal_noise_float(p.mul(vec3(0.05, 0.11, 0.05)), 3);
  // Small relief the mesh is too coarse to carry: it tilts the light and breaks the snow line.
  const relief: TslNode = coarse.mul(0.4).add(fine.mul(0.22));
  const lit: TslNode = dot(n, vec3(sun.x, sun.y, sun.z)).add(relief).clamp(0, 1);
  const slope: TslNode = n.y.add(relief.mul(0.6));
  // Snow lies above a ragged line and only where the ground is not too steep; gullies hold it lower down.
  const snowLine: TslNode = float(150).add(coarse.mul(60));
  const snow: TslNode = smoothstep(snowLine.sub(14), snowLine.add(26), p.y.add(fine.mul(18))).mul(smoothstep(0.56, 0.74, slope));
  const dusting: TslNode = smoothstep(0.1, 0.5, fine).mul(smoothstep(70, 140, p.y)).mul(smoothstep(0.62, 0.8, slope)).mul(0.45);
  const strata: TslNode = mx_fractal_noise_float(vec3(p.x.mul(0.004), p.y.mul(0.09), p.z.mul(0.004)), 3).mul(0.5).add(0.5);
  const rock: TslNode = mix(vec3(0.1, 0.105, 0.115), vec3(0.26, 0.25, 0.24), strata);
  const scree: TslNode = mix(vec3(0.2, 0.19, 0.17), vec3(0.15, 0.16, 0.14), coarse.mul(0.5).add(0.5));
  const ground: TslNode = mix(scree, rock, smoothstep(30, 90, p.y.add(coarse.mul(20))));
  const surface: TslNode = mix(ground, vec3(0.93, 0.95, 0.98), snow.add(dusting).clamp(0, 1));
  // Sunlight is warm and the shade is lit by blue sky, which is what makes snow read as snow.
  const light: TslNode = vec3(1, 0.97, 0.92).mul(lit.mul(1.25)).add(vec3(0.16, 0.22, 0.34));
  const distance: TslNode = p.xz.length();
  const haze: TslNode = smoothstep(INNER - 60, OUTER, distance).mul(0.3).add(0.07).add(smoothstep(70, 0, p.y).mul(0.25));
  const material = kit.own(new THREE.MeshBasicNodeMaterial({ fog: false }));
  material.colorNode = mix(surface.mul(light), vec3(...HAZE), haze.clamp(0, 0.92)).mul(GAIN);

  const range = new THREE.Mesh(terrain, material);
  range.castShadow = false;
  range.receiveShadow = false;
  range.frustumCulled = false;
  kit.root.add(range);

  const floorMaterial = kit.own(new THREE.MeshBasicNodeMaterial({ fog: false }));
  floorMaterial.colorNode = mix(vec3(0.27, 0.27, 0.25), vec3(...HAZE), smoothstep(40, INNER, positionWorld.xz.length()).mul(0.5).add(0.2)).mul(GAIN);
  const floor = new THREE.Mesh(kit.own(new THREE.CircleGeometry(INNER + 20, 48)), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.35;
  floor.receiveShadow = false;
  kit.root.add(floor);
}
