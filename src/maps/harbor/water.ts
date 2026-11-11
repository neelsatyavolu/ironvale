import * as THREE from 'three/webgpu';
import { cameraPosition, color, cos, float, max, mix, normalize, positionLocal, positionWorld, sin, smoothstep, step, texture, time, transformNormalToView, vec2, vec3 } from 'three/tsl';
import type { TslNode } from './grime';
import { JETTIES, MOLE, QUAY_EDGE, SLIPWAY, WATER_Y } from './layout';

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

/** Sheet origin in world space; the swell is worked out in world metres from it. */
const ORIGIN_Z = QUAY_EDGE - 0.3 + 450;

/** Long swell rolling in from the south-west: [direction x, direction z, wavelength m, height m, speed m/s]. */
const SWELLS: readonly (readonly [number, number, number, number, number])[] = [
  [0.62, -0.78, 23, 0.05, 2.6],
  [0.86, -0.5, 13.5, 0.03, 2.1],
  [0.2, -0.98, 7.3, 0.016, 1.7],
];

/** Grid lines for the sheet: fine across the harbour where the swell is seen up close, coarse out to the horizon. */
function gridLines(inner0: number, inner1: number, step: number, outer0: number, outer1: number): number[] {
  const lines: number[] = [];
  for (let reach = outer0; reach < inner0 - 1; reach += Math.max(step * 4, (inner0 - reach) * 0.45)) lines.push(reach);
  for (let v = inner0; v <= inner1 + 1e-6; v += step) lines.push(v);
  let reach = inner1;
  while (reach < outer1 - 1) {
    reach += Math.max(step * 4, (reach - inner1) * 0.8 + step * 4);
    lines.push(Math.min(reach, outer1));
  }
  return lines;
}

function sheetGeometry(): THREE.BufferGeometry {
  const xs = gridLines(-84, 84, 1.6, -900, 900);
  const zs = gridLines(QUAY_EDGE - 0.3, QUAY_EDGE + 62, 1.6, QUAY_EDGE - 0.3, QUAY_EDGE + 900).map((z) => z - ORIGIN_Z);
  const positions: number[] = [];
  const indices: number[] = [];
  for (const z of zs) for (const x of xs) positions.push(x, 0, z);
  for (let j = 0; j < zs.length - 1; j++) {
    for (let i = 0; i < xs.length - 1; i++) {
      const a = j * xs.length + i;
      const b = a + xs.length;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(positions.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * The sea: a sheet that heaves with a low swell inside the harbour, with
 * normals from three scrolling layers of the wave map on top. The standard
 * material then does the rest: Fresnel sky reflection from the environment
 * map, a sun glitter path from the directional light and screen-space
 * reflections of boats and quay on the high tiers. Foam gathers where the
 * water works against the quay, the mole, the slipway and the jetty piles.
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

  // Swell: displaces the sheet near the harbour and tilts its normal everywhere it is drawn.
  const wx: TslNode = positionLocal.x;
  const wz: TslNode = positionLocal.z.add(ORIGIN_Z);
  // The basin is sheltered by the mole; the swell builds outside it and dies out toward the horizon mesh.
  const exposure = mix(float(0.55), float(1), smoothstep(QUAY_EDGE + 20, QUAY_EDGE + 60, wz)).mul(smoothstep(QUAY_EDGE - 0.3, QUAY_EDGE + 2.5, wz).mul(0.6).add(0.4));
  let heave: TslNode = float(0);
  let tiltX: TslNode = float(0);
  let tiltZ: TslNode = float(0);
  for (const [dx, dz, wavelength, height, speed] of SWELLS) {
    const k = (Math.PI * 2) / wavelength;
    const phase = wx.mul(dx * k).add(wz.mul(dz * k)).sub(time.mul(speed * k));
    heave = heave.add(sin(phase).mul(height));
    tiltX = tiltX.add(cos(phase).mul(height * k * dx));
    tiltZ = tiltZ.add(cos(phase).mul(height * k * dz));
  }
  const reach = smoothstep(260, 70, wz.sub(QUAY_EDGE).abs().add(wx.abs().mul(0.5)));
  material.positionNode = positionLocal.add(vec3(0, heave.mul(exposure).mul(reach), 0));

  const calm = mix(float(1), float(0.6), smoothstep(60, 500, distance));
  const strength = float(0.4).mul(calm);
  const swellTilt = exposure.mul(smoothstep(420, 60, distance)).mul(1.6);
  const normal = normalize(vec3(slope.x.mul(strength).add(tiltX.mul(swellTilt)).negate(), 1, slope.y.mul(strength).add(tiltZ.mul(swellTilt)).negate()));
  material.normalNode = transformNormalToView(normal);

  // Body colour: green-brown in the shallows by the quay, deep teal further out.
  const shore = smoothstep(QUAY_EDGE + 14, QUAY_EDGE, positionWorld.z);
  const crest = slope.x.add(slope.y).mul(0.5).add(0.5);
  const body = mix(color(0x0b3340), color(0x1f4f47), shore.mul(0.7)).mul(mix(float(0.92), float(1.07), crest));
  // Foam. `edge` is how close the water is to something it breaks against, 0 - 1.
  const lap = sin(time.mul(1.1).add(positionWorld.x.mul(0.7))).mul(0.12).add(heave.mul(2.2)).add(crest.sub(0.5).mul(0.5));
  const band = (gap: TslNode, width: number): TslNode => smoothstep(float(width), float(0.04), gap.add(lap.mul(width * 0.55)));
  const px = positionWorld.x;
  const pz = positionWorld.z;
  const alongQuay = band(pz.sub(QUAY_EDGE), 0.75).mul(step(float(MOLE.x1), px));
  const alongMole = band(px.sub(MOLE.x1), 0.7).mul(step(pz, float(MOLE.z1 + 0.6))).add(band(pz.sub(MOLE.z1).abs(), 0.9).mul(step(px, float(MOLE.x1 + 0.4))));
  const onSlip = band(pz.sub(SLIPWAY.z1 - 6.2).abs(), 1.1).mul(step(float(SLIPWAY.x0), px)).mul(step(px, float(SLIPWAY.x1)));
  let piles: TslNode = float(0);
  for (const jetty of JETTIES) {
    // Rings round the piles, which stand in pairs every few metres down each side of a jetty.
    const side = px.sub(jetty.x).abs().sub(jetty.width / 2 + 0.1);
    const bays = Math.max(2, Math.round((jetty.length - 0.06) / 3.2));
    const pitch = (jetty.length - 0.06) / bays;
    const alongJetty = pz.sub(QUAY_EDGE + 0.06 - 0.25).div(pitch);
    const toPile = alongJetty.sub(alongJetty.round()).mul(pitch);
    const ring = side.mul(side).add(toPile.mul(toPile)).sqrt();
    const inRun = step(float(QUAY_EDGE + 1), pz).mul(step(pz, float(QUAY_EDGE + jetty.length + 0.3)));
    piles = max(piles, band(ring.sub(0.16), 0.5).mul(inRun));
  }
  const edge = max(max(alongQuay, alongMole), max(onSlip, piles));
  const lace = smoothstep(0.3, 0.62, crest.add(layer(1.1, 0.03, 0.02).x.mul(0.55)));
  // Out in the open a few crests break; inside the mole none do.
  const open = smoothstep(QUAY_EDGE + 34, QUAY_EDGE + 80, pz).mul(smoothstep(300, 90, distance));
  const whitecap = smoothstep(0.78, 0.9, crest.add(layer(31, 0.011, -0.006).x.mul(0.3)).add(heave.mul(2.5))).mul(open).mul(0.55);
  // The fountain pool borrows this material; it sits above street level and gets no foam.
  const atSea = step(positionWorld.y, float(WATER_Y + 0.5));
  const froth = max(edge.mul(mix(float(0.35), float(1), lace)), whitecap).mul(atSea);
  material.colorNode = mix(body, color(0xd6ddd6), froth.mul(0.8));
  // Light scattered back out of the water: keeps it turquoise where the sky reflection is weak.
  material.emissiveNode = mix(color(0x0d4650), color(0x2a6b62), shore.mul(0.6)).mul(0.2);
  material.roughnessNode = mix(float(0.06), float(0.16), smoothstep(40, 400, distance)).add(froth.mul(0.5));

  const geometry = sheetGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, WATER_Y, ORIGIN_Z);
  // The swell moves vertices on the GPU; the bounds on the CPU are those of the flat sheet, which is close enough.
  mesh.frustumCulled = false;
  mesh.name = 'harbor-sea';
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
