import * as THREE from 'three/webgpu';
import { abs, dot, float, max, mix, mx_fractal_noise_float, mx_noise_float, normalize, normalWorld, positionWorld, pow, smoothstep, vec3 } from 'three/tsl';
import type { Kit } from './kit';
import { FOG_COLOR, LIGHTING, SUN_COLOR } from './lighting';
import { TANK } from './plan';
import type { TslNode } from './surfaces';

const INNER = 300;
const OUTER = 840;
const SPOKES = 720;
const ROWS = 72;
const PEAK = 290;
/** Bearing (atan2(x, z)) of the view north through the slot, square to the line between the tank centres. */
const SLOT_BEARING = Math.atan2(-TANK.z, TANK.x);
/** The range is drawn unlit, so its colours are scene-referred: this sets sunlit snow against sunlit concrete. */
const GAIN = 0.8;
const STEP = 2;

/** Crest lines of a noise field, 0 in the gullies and 1 on the ridge. */
const crest = (at: TslNode): TslNode => {
  const fall: TslNode = abs(mx_noise_float(at)).oneMinus();
  return fall.mul(fall);
};

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
  const sun = LIGHTING.sunDirection;
  const sunward: TslNode = vec3(sun.x, sun.y, sun.z);
  const coarse: TslNode = mx_fractal_noise_float(p.mul(0.011), 4);
  const fine: TslNode = mx_fractal_noise_float(p.mul(vec3(0.05, 0.11, 0.05)), 3);
  // Relief the mesh is too coarse to carry, in metres: spurs and gullies running down the fall line, then
  // broken rock. Its slope tilts the surface normal, so the low sun picks out every rib.
  const relief = (at: TslNode): TslNode =>
    crest(vec3(at.x.mul(0.016), at.y.mul(0.004), at.z.mul(0.016)))
      .mul(18)
      .add(crest(vec3(at.x.mul(0.045), at.y.mul(0.012), at.z.mul(0.045)).add(7.3)).mul(5))
      .add(mx_fractal_noise_float(at.mul(0.09), 3).mul(1.2));
  const height: TslNode = relief(p);
  const crags: TslNode = mx_fractal_noise_float(p.mul(0.09), 2);
  const flat: TslNode = normalize(normalWorld);
  // Slope of the relief by differences two metres apart, which stays smooth where screen derivatives would step.
  const gx: TslNode = relief(p.add(vec3(STEP, 0, 0))).sub(height).div(STEP);
  const gz: TslNode = relief(p.add(vec3(0, 0, STEP))).sub(height).div(STEP);
  const n: TslNode = normalize(flat.sub(vec3(gx, 0, gz).mul(0.8)));

  const facing: TslNode = dot(n, sunward);
  // No shadows are cast out here; ground that the broad shape turns from the sun counts as shaded by its own ridge.
  const lit: TslNode = smoothstep(-0.05, 0.5, facing).mul(smoothstep(-0.22, 0.12, dot(flat, sunward)));
  const slope: TslNode = n.y;
  // Winter: snow on everything that is not steep, thinning to bare ground toward the valley floor.
  const snowLine: TslNode = float(46).add(coarse.mul(26));
  const snow: TslNode = smoothstep(snowLine.sub(12), snowLine.add(30), p.y.add(fine.mul(14))).mul(smoothstep(0.42, 0.62, slope.add(fine.mul(0.08))));
  const strata: TslNode = mx_fractal_noise_float(vec3(p.x.mul(0.02), p.y.mul(0.16).add(coarse.mul(3)), p.z.mul(0.02)), 3).mul(0.5).add(0.5);
  const rock: TslNode = mix(vec3(0.045, 0.047, 0.055), vec3(0.17, 0.155, 0.14), strata.mul(smoothstep(-0.6, 0.8, crags)));
  // Dark conifers on the lower slopes give the range its size.
  const stand: TslNode = mx_noise_float(p.mul(0.3)).mul(0.5).add(0.5);
  const forest: TslNode = smoothstep(40, 96, p.y.add(coarse.mul(30))).oneMinus().mul(smoothstep(0.4, 0.55, mx_noise_float(p.mul(0.035)).mul(0.5).add(0.5).mul(0.6).add(stand.mul(0.4)))).mul(smoothstep(0.35, 0.6, slope));
  const ground: TslNode = mix(rock, vec3(0.9, 0.92, 0.96), snow);
  const surface: TslNode = mix(ground, mix(vec3(0.02, 0.035, 0.03), vec3(0.06, 0.08, 0.07), stand), forest.mul(0.9));
  // Low sun is straw-coloured and the shade is lit by blue sky, which is what makes snow read as snow.
  const sunLight = new THREE.Color(SUN_COLOR);
  const light: TslNode = vec3(sunLight.r, sunLight.g, sunLight.b).mul(lit.mul(1.5)).add(vec3(0.13, 0.19, 0.33).mul(slope.mul(0.4).add(0.6)));
  // Aerial haze: thick in the valley, thinner up the faces, and warm where the view runs toward the sun.
  const distance: TslNode = p.xz.length();
  const fogTone = new THREE.Color(FOG_COLOR);
  const towardSun: TslNode = max(dot(normalize(vec3(p.x, 0, p.z)), normalize(vec3(sun.x, 0, sun.z))), 0);
  const hazeColour: TslNode = mix(vec3(fogTone.r, fogTone.g, fogTone.b).mul(1.35), vec3(sunLight.r, sunLight.g, sunLight.b).mul(1.7), pow(towardSun, 5).mul(0.8));
  const haze: TslNode = smoothstep(INNER - 80, OUTER, distance).mul(0.34).add(0.3).add(smoothstep(0, 120, p.y).oneMinus().mul(0.4)).add(pow(towardSun, 5).mul(0.2));
  const material = kit.own(new THREE.MeshBasicNodeMaterial({ fog: false }));
  material.colorNode = mix(surface.mul(light).mul(GAIN), hazeColour.mul(0.62), haze.clamp(0, 0.94));

  const range = new THREE.Mesh(terrain, material);
  range.castShadow = false;
  range.receiveShadow = false;
  range.frustumCulled = false;
  kit.root.add(range);

  const floorMaterial = kit.own(new THREE.MeshBasicNodeMaterial({ fog: false }));
  // The valley floor outside the wall: old snow over rough ground, lost in haze before it reaches the slopes.
  const drift: TslNode = smoothstep(0.35, 0.6, mx_fractal_noise_float(positionWorld.mul(0.05), 3).mul(0.5).add(0.5));
  floorMaterial.colorNode = mix(mix(vec3(0.09, 0.09, 0.085), vec3(0.42, 0.47, 0.56), drift), hazeColour.mul(0.62), smoothstep(40, INNER, positionWorld.xz.length()).mul(0.6).add(0.15));
  const floor = new THREE.Mesh(kit.own(new THREE.CircleGeometry(INNER + 20, 48)), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.35;
  floor.receiveShadow = false;
  kit.root.add(floor);
}
