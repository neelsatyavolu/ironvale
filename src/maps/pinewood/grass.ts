import * as THREE from 'three/webgpu';
import type { Assets } from '../../core/assets';

/**
 * Clump photographs in the grass sheet (Poly Haven grass_medium_01), in texels
 * of its 1024 px layout: left, top, right, ground line. The rest of the sheet
 * holds single blades that are no use as cards.
 */
const CLUMPS: readonly (readonly [number, number, number, number])[] = [
  [205, 764, 500, 902],
  [605, 774, 835, 878],
  [30, 894, 195, 998],
  [250, 909, 505, 1000],
  [590, 884, 805, 1012],
];
const SHEET = 1024;
/** Size of one texel on a card. The clumps come out 0.35 - 0.65 m wide and about 0.3 m tall. */
const METRES_PER_TEXEL = 0.0022;

/** Clump combinations, one geometry each, so neighbouring tufts differ. */
export const GRASS_VARIANTS: readonly (readonly number[])[] = [
  [0, 2],
  [1, 4, 3],
  [3, 0, 2],
];

/** A tuft of crossed cards, each cut from one clump of the sheet and leaning outward a little. */
export function grassTuftGeometry(clumps: readonly number[], random: () => number): THREE.BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  clumps.forEach((clump, card) => {
    const [x0, y0, x1, y1] = CLUMPS[clump] as readonly [number, number, number, number];
    const half = ((x1 - x0) * METRES_PER_TEXEL) / 2;
    const height = (y1 - y0) * METRES_PER_TEXEL;
    const yaw = (card / clumps.length) * Math.PI + (random() - 0.5) * 0.6;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const lean = (random() - 0.5) * 0.12;
    const cx = (random() - 0.5) * 0.12;
    const cz = (random() - 0.5) * 0.12;
    const base = position.length / 3;
    for (const [side, top] of [
      [-1, 0],
      [1, 0],
      [-1, 1],
      [1, 1],
    ] as const) {
      position.push(cx + cos * side * half - sin * lean * top, top * height - 0.03, cz + sin * side * half + cos * lean * top);
      // Lit as if facing up, like the ground it grows from.
      normal.push(0, 1, 0);
      uv.push((side < 0 ? x0 : x1) / SHEET, 1 - (top ? y0 : y1) / SHEET);
    }
    // Both windings, so the back of a card keeps its upward normal instead of going black.
    index.push(base, base + 1, base + 2, base + 2, base + 1, base + 3, base, base + 2, base + 1, base + 2, base + 3, base + 1);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

export interface GrassMaterial {
  readonly material: THREE.MeshStandardNodeMaterial;
  dispose(): void;
}

/** Alpha-tested grass in the dry olive of a shaded forest floor. */
export function createGrassMaterial(assets: Assets): GrassMaterial {
  const alpha = assets.texture('tex-pinewood-grass-alpha').clone();
  alpha.colorSpace = THREE.NoColorSpace;
  alpha.needsUpdate = true;
  const material = new THREE.MeshStandardNodeMaterial({
    map: assets.texture('tex-pinewood-grass'),
    alphaMap: alpha,
    alphaTest: 0.42,
    roughness: 0.9,
    metalness: 0,
  });
  // The photographs are dark; lift them to sit with the litter they grow from.
  material.color.setRGB(1.2, 1.12, 0.8);
  return {
    material,
    dispose: () => {
      alpha.dispose();
      material.dispose();
    },
  };
}

/** A dead branch lying on the ground: a main stick with a few side twigs, about 2 m long. */
export function fallenBranchGeometry(random: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const stick = (length: number, thick: number, at: number, yaw: number, rise: number): void => {
    const part = new THREE.CylinderGeometry(thick * 0.35, thick, length, 5, 1);
    part.translate(0, length / 2, 0);
    part.rotateZ(-Math.PI / 2 + rise);
    part.rotateY(yaw);
    part.translate(at, 0, 0);
    parts.push(part);
  };
  stick(2.2, 0.03, -1.1, 0, 0.02);
  for (let i = 0; i < 4; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    stick(0.45 + random() * 0.5, 0.012, -0.7 + i * 0.42 + random() * 0.2, side * (0.5 + random() * 0.5), 0.05 + random() * 0.25);
  }
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  for (const part of parts) {
    const flat = part.toNonIndexed();
    position.push(...(flat.getAttribute('position').array as Float32Array));
    normal.push(...(flat.getAttribute('normal').array as Float32Array));
    uv.push(...(flat.getAttribute('uv').array as Float32Array));
    flat.dispose();
    part.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geometry;
}
