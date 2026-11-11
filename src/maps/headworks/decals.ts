import * as THREE from 'three/webgpu';
import { abs, float, fract, mix, mx_noise_float, positionWorld, smoothstep, uv, vec3 } from 'three/tsl';
import type { Kit } from './kit';
import type { TslNode } from './surfaces';

/**
 * Thin overlays laid a hair off the surface they mark: stains, run-off,
 * painted lines, tyre marks and signs. All take their colour from vertex
 * colour and none cast shadows.
 */

function overlay(material: THREE.MeshStandardNodeMaterial, units: number): THREE.MeshStandardNodeMaterial {
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = units;
  material.vertexColors = true;
  return material;
}

/** Soft blot: spilt oil, a rust bloom, a damp patch or a salt ring. UVs 0 - 1 across the patch. */
export function stain(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.6, transparent: true, depthWrite: false });
  const fromCentre: TslNode = uv().sub(0.5).length().mul(2);
  const shape: TslNode = mx_noise_float(positionWorld.mul(1.9)).mul(0.5).add(0.5);
  const speckle: TslNode = mx_noise_float(positionWorld.mul(13)).mul(0.5).add(0.5);
  const body: TslNode = smoothstep(0.3, 1.0, fromCentre.add(shape.sub(0.5).mul(0.8))).oneMinus();
  material.opacityNode = body.mul(mix(float(0.55), float(1), speckle)).mul(0.92);
  return overlay(material, -6);
}

/**
 * Run-off down a wall from an outlet, a joint or a fixing. UV v is 1 at the
 * source and 0 at the foot of the streak; u runs across it. Strong and narrow
 * at the top, fanning out and breaking into threads lower down.
 */
export function runOff(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.85, transparent: true, depthWrite: false });
  const st: TslNode = uv();
  const across: TslNode = abs(st.x.sub(0.5)).mul(2);
  const spread: TslNode = mix(float(1), float(0.3), st.y);
  const core: TslNode = smoothstep(spread.mul(0.25), spread, across).oneMinus();
  const threads: TslNode = mx_noise_float(vec3(positionWorld.x.mul(14).add(positionWorld.z.mul(14)), positionWorld.y.mul(0.9), 2)).mul(0.5).add(0.5);
  const fade: TslNode = smoothstep(0, 0.7, st.y);
  material.opacityNode = core.mul(fade).mul(mix(float(0.35), float(1), threads)).mul(0.78);
  return overlay(material, -6);
}

/** Line paint, worn through in patches. */
export function linePaint(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.55 });
  const coarse: TslNode = mx_noise_float(positionWorld.xz.mul(1.4)).mul(0.5).add(0.5);
  const fine: TslNode = mx_noise_float(positionWorld.xz.mul(16)).mul(0.5).add(0.5);
  material.opacityNode = smoothstep(0.3, 0.36, coarse.mul(0.45).add(fine.mul(0.55)));
  material.alphaTest = 0.5;
  material.colorNode = vec3(mix(float(0.6), float(1), fine));
  return overlay(material, -8);
}

/** A pair of tyre tracks. UV u runs across the pair, v along it; the marks fade in and out along their length. */
export function tyreMarks(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x0c0c0c, roughness: 0.5, transparent: true, depthWrite: false });
  const st: TslNode = uv();
  const track: TslNode = smoothstep(0.1, 0.16, abs(abs(st.x.sub(0.5)).sub(0.36))).oneMinus();
  const tread: TslNode = mix(float(0.55), float(1), smoothstep(0.3, 0.5, abs(fract(st.y.mul(60)).sub(0.5))));
  const patchy: TslNode = smoothstep(0.3, 0.7, mx_noise_float(positionWorld.xz.mul(0.7)).mul(0.5).add(0.5));
  const ends: TslNode = smoothstep(0, 0.2, st.y).mul(smoothstep(0, 0.2, st.y.oneMinus()));
  material.opacityNode = track.mul(tread).mul(patchy).mul(ends).mul(0.5);
  return overlay(material, -6);
}

/** Text and symbols drawn once into one canvas. Each entry is a sign plate or a stencil. */
export const SIGNS = [
  'CLARIFIER 1',
  'CLARIFIER 2',
  'FILTER WALK',
  'VALVE COURT',
  'PUMP HOUSE A',
  'PUMP HOUSE B',
  'CONTROL',
  'DANGER  DEEP WATER',
  'DANGER  400 V',
  'NO ENTRY',
  'HEADWORKS',
  'RAW WATER',
  'WASHWATER',
  'P-101',
  'P-102',
  'MCC-2',
] as const;
export type SignText = (typeof SIGNS)[number];

const ROW_PIXELS = 96;
const ATLAS_WIDTH = 768;
/** Plates wider than tall by this ratio. */
export const SIGN_ASPECT = ATLAS_WIDTH / ROW_PIXELS;
const PLATE: Readonly<Record<string, readonly [string, string]>> = {
  DANGER: ['#e3b20a', '#111111'],
  NO: ['#a61c16', '#f3f1ea'],
};

/**
 * Sign atlas. The top half of the canvas holds every text on a painted plate
 * (blue information plates, yellow and red warnings); the bottom half holds
 * the same texts as bare stencils on a clear ground for lettering sprayed
 * straight onto concrete.
 */
export function signAtlas(kit: Kit): THREE.MeshStandardNodeMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_WIDTH;
  canvas.height = ROW_PIXELS * SIGNS.length * 2;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Headworks signs need a 2D canvas');
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  SIGNS.forEach((text, row) => {
    const [ground, ink] = PLATE[text.split(' ')[0] as string] ?? ['#1c4a63', '#f3f1ea'];
    for (const stencil of [false, true]) {
      const top = (row + (stencil ? SIGNS.length : 0)) * ROW_PIXELS;
      if (!stencil) {
        context.fillStyle = ink;
        context.fillRect(0, top, ATLAS_WIDTH, ROW_PIXELS);
        context.fillStyle = ground;
        context.fillRect(5, top + 5, ATLAS_WIDTH - 10, ROW_PIXELS - 10);
      }
      let size = 62;
      const font = (): string => `700 ${size}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
      context.font = font();
      const measured = context.measureText(text).width;
      if (measured > ATLAS_WIDTH - 60) size = Math.floor((size * (ATLAS_WIDTH - 60)) / measured);
      context.font = font();
      context.fillStyle = stencil ? '#ffffff' : ink;
      context.fillText(text, ATLAS_WIDTH / 2, top + ROW_PIXELS / 2 + 3);
    }
  });
  const map = kit.own(new THREE.CanvasTexture(canvas));
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const material = new THREE.MeshStandardNodeMaterial({ map, roughness: 0.55, alphaTest: 0.45 });
  return overlay(material, -8);
}

/** Flat panel carrying one sign. `width` in metres; `stencil` picks the bare lettering. */
export function signGeometry(text: SignText, width: number, stencil = false): THREE.PlaneGeometry {
  const rows = SIGNS.length * 2;
  const row = SIGNS.indexOf(text) + (stencil ? SIGNS.length : 0);
  const geometry = new THREE.PlaneGeometry(width, width / SIGN_ASPECT);
  const uvs = geometry.getAttribute('uv');
  const top = 1 - row / rows;
  const bottom = 1 - (row + 1) / rows;
  for (let i = 0; i < uvs.count; i++) uvs.setY(i, uvs.getY(i) > 0.5 ? top : bottom);
  return geometry;
}
