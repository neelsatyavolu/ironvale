import * as THREE from 'three/webgpu';
import { cameraPosition, color, float, mix, normalize, positionWorld, sin, smoothstep, step, texture, time, transformNormalToView, vec2, vec3 } from 'three/tsl';
import { MOLE, QUAY_EDGE, WATER_Y } from './layout';

const NORMAL_SIZE = 256;
const WAVE_COUNT = 28;

/**
 * Tiling slope map for small waves: a sum of sine waves with whole-number
 * frequencies, so it repeats without seams. Red and green hold the surface
 * slope along X and Z.
 */
function waveTexture(random: () => number): THREE.DataTexture {
  const waves = Array.from({ length: WAVE_COUNT }, () => {
    const kx = Math.round((random() * 2 - 1) * 9);
    const ky = Math.round((random() * 2 - 1) * 9);
    const k = Math.max(1, Math.hypot(kx, ky));
    return { kx, ky, phase: random() * Math.PI * 2, amplitude: 1 / Math.pow(k, 1.15) };
  });
  const slopeX = new Float32Array(NORMAL_SIZE * NORMAL_SIZE);
  const slopeY = new Float32Array(NORMAL_SIZE * NORMAL_SIZE);
  let peak = 1e-6;
  for (let y = 0; y < NORMAL_SIZE; y++) {
    for (let x = 0; x < NORMAL_SIZE; x++) {
      let sx = 0;
      let sy = 0;
      for (const wave of waves) {
        const c = Math.cos(((wave.kx * x + wave.ky * y) / NORMAL_SIZE) * Math.PI * 2 + wave.phase) * wave.amplitude;
        sx += c * wave.kx;
        sy += c * wave.ky;
      }
      const i = y * NORMAL_SIZE + x;
      slopeX[i] = sx;
      slopeY[i] = sy;
      peak = Math.max(peak, Math.abs(sx), Math.abs(sy));
    }
  }
  const data = new Uint8Array(NORMAL_SIZE * NORMAL_SIZE * 4);
  for (let i = 0; i < NORMAL_SIZE * NORMAL_SIZE; i++) {
    data[i * 4] = Math.round(((slopeX[i]! / peak) * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round(((slopeY[i]! / peak) * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  const map = new THREE.DataTexture(data, NORMAL_SIZE, NORMAL_SIZE, THREE.RGBAFormat);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.anisotropy = 8;
  map.needsUpdate = true;
  return map;
}

export interface Sea {
  readonly mesh: THREE.Mesh;
  /** Small-wave slope map, shared with the fountain so both surfaces move the same way. */
  readonly material: THREE.MeshStandardNodeMaterial;
  dispose(): void;
}

/**
 * The sea: a flat sheet whose normals come from three scrolling layers of the
 * wave map. The standard material then does the rest: Fresnel sky reflection
 * from the environment map, a sun glitter path from the directional light and
 * screen-space reflections of boats and quay on the high tiers.
 */
export function createSea(random: () => number): Sea {
  const waves = waveTexture(random);
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.09, metalness: 0 });
  material.envMapIntensity = 0.36;

  const p = positionWorld.xz;
  const layer = (scale: number, vx: number, vz: number) =>
    texture(waves, p.div(scale).add(vec2(vx, vz).mul(time))).xy.mul(2).sub(1);
  // Swell, chop and a fine ripple; the ripple fades first with distance so the far sea does not sparkle.
  const distance = positionWorld.sub(cameraPosition).length();
  const near = smoothstep(70, 8, distance);
  const slope = layer(6.1, 0.021, 0.013)
    .mul(0.55)
    .add(layer(15.7, -0.009, 0.012).mul(0.7))
    .add(layer(2.3, 0.04, -0.031).mul(0.3))
    .add(layer(0.83, -0.06, 0.05).mul(near.mul(0.22)));

  const calm = mix(float(1), float(0.6), smoothstep(60, 500, distance));
  const strength = float(0.4).mul(calm);
  const normal = normalize(vec3(slope.x.mul(strength).negate(), 1, slope.y.mul(strength).negate()));
  material.normalNode = transformNormalToView(normal);

  // Body colour: green-brown in the shallows by the quay, deep teal further out.
  const shore = smoothstep(QUAY_EDGE + 14, QUAY_EDGE, positionWorld.z);
  const crest = slope.x.add(slope.y).mul(0.5).add(0.5);
  const body = mix(color(0x0b3340), color(0x1f4f47), shore.mul(0.7)).mul(mix(float(0.8), float(1.15), crest));
  // A thin line of froth where the water laps the quay wall, moving with the swell.
  const lap = sin(time.mul(1.1).add(positionWorld.x.mul(0.7))).mul(0.1).add(crest.sub(0.5).mul(0.5));
  const froth = smoothstep(0.08, 0.42, positionWorld.z.sub(QUAY_EDGE).add(lap))
    .oneMinus()
    .mul(step(float(MOLE.x1), positionWorld.x))
    .mul(smoothstep(0.35, 0.6, crest.add(layer(1.1, 0.03, 0.02).x.mul(0.5))));
  material.colorNode = mix(body, color(0xc9d2cc), froth.mul(0.7));
  // Light scattered back out of the water: keeps it turquoise where the sky reflection is weak.
  material.emissiveNode = mix(color(0x0d4650), color(0x2a6b62), shore.mul(0.6)).mul(0.2);
  material.roughnessNode = mix(float(0.06), float(0.16), smoothstep(40, 400, distance)).add(froth.mul(0.5));

  const geometry = new THREE.PlaneGeometry(1800, 900, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, WATER_Y, QUAY_EDGE - 0.3 + 450);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return {
    mesh,
    material,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      waves.dispose();
    },
  };
}
