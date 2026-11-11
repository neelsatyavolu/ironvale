import * as THREE from 'three/webgpu';
import type { Kit } from './kit';

/** Text rows in the lettering atlas, top to bottom. Each row is 8:1. */
export const LOGO_ROWS = [
  'NORDHAVN',
  'KESTREL LINE',
  'HALCYON',
  'TERNMARK',
  'SKERRYVORE',
  'IRONVALE FREIGHT',
  'BERTH 4',
  'SITE OFFICE',
  'DANGER',
  'KEEP CLEAR',
  'HARD HATS',
  'GATE 2',
  'ROW A',
  'ROW B',
  'ROW C',
  'ROW D',
  'HIGH VOLTAGE',
  'NO ENTRY',
  'CAUTION',
  'FUEL',
  'AUTHORISED ONLY',
  'RELAY 01',
  'RELAY 02',
  'RELAY 03',
  'NHVU 482913 7',
  'KSTU 305518 2',
  'TRNU 771264 0',
  'MAX GR 30480 KG',
] as const;
export type LogoText = (typeof LOGO_ROWS)[number];

const ROW_PIXELS = 128;
const ATLAS_WIDTH = 1024;

/** White stencilled text on a transparent ground; vertex colour sets the ink. */
export function letteringAtlas(kit: Kit): THREE.MeshStandardNodeMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_WIDTH;
  canvas.height = ROW_PIXELS * LOGO_ROWS.length;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Railyard lettering needs a 2D canvas');
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  LOGO_ROWS.forEach((text, row) => {
    let size = 104;
    context.font = `700 ${size}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
    const measured = context.measureText(text).width;
    if (measured > ATLAS_WIDTH - 40) size = Math.floor((size * (ATLAS_WIDTH - 40)) / measured);
    context.font = `700 ${size}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
    context.fillText(text, ATLAS_WIDTH / 2, row * ROW_PIXELS + ROW_PIXELS / 2 + 4);
  });
  const map = kit.own(new THREE.CanvasTexture(canvas));
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const material = new THREE.MeshStandardNodeMaterial({ map, roughness: 0.6, alphaTest: 0.45 });
  material.vertexColors = true;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -8;
  return material;
}

/** Flat panel carrying one row of the lettering atlas. `width` in metres; height is width / 8. */
export function logoGeometry(text: LogoText, width: number): THREE.PlaneGeometry {
  const row = LOGO_ROWS.indexOf(text);
  const geometry = new THREE.PlaneGeometry(width, width / 8);
  const uvs = geometry.getAttribute('uv');
  const top = 1 - row / LOGO_ROWS.length;
  const bottom = 1 - (row + 1) / LOGO_ROWS.length;
  for (let i = 0; i < uvs.count; i++) uvs.setY(i, uvs.getY(i) > 0.5 ? top : bottom);
  return geometry;
}
