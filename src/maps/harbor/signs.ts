import * as THREE from 'three/webgpu';
import type { Kit } from './facade';
import { QUAY_NORTH, STREET_NORTH, STREET_SOUTH } from './layout';

interface Sign {
  readonly text: string;
  readonly ink: string;
  readonly ground: string;
  readonly x: number;
  /** Wall plane the board hangs on, and which way that wall faces along Z. */
  readonly z: number;
  readonly facing: 1 | -1;
  readonly width: number;
  readonly y?: number;
}

const CREAM = '#e6dcc3';
const GREEN = '#24402f';
const OXBLOOD = '#6e2a22';
const NAVY = '#243a55';
const OCHRE = '#c79a3f';

/** Painted shop boards over the doors that have canopies. */
const SIGNS: readonly Sign[] = [
  { text: 'BAR CENTRALE', ink: CREAM, ground: GREEN, x: -4.5, z: QUAY_NORTH, facing: 1, width: 3.4, y: 3.5 },
  { text: 'BAR', ink: CREAM, ground: GREEN, x: -3, z: STREET_SOUTH, facing: -1, width: 1.7 },
  { text: 'RETI E CORDAMI', ink: NAVY, ground: CREAM, x: -30.25, z: QUAY_NORTH, facing: 1, width: 3.2, y: 3.25 },
  { text: 'PESCHERIA', ink: CREAM, ground: NAVY, x: 18, z: QUAY_NORTH, facing: 1, width: 2.6 },
  { text: 'ALIMENTARI', ink: OXBLOOD, ground: CREAM, x: 16.5, z: STREET_NORTH, facing: 1, width: 2.6 },
  { text: 'TABACCHI', ink: CREAM, ground: OXBLOOD, x: -36, z: STREET_NORTH, facing: 1, width: 2.2 },
  { text: 'TRATTORIA DA GINO', ink: OCHRE, ground: OXBLOOD, x: -44.5, z: QUAY_NORTH, facing: 1, width: 3.2 },
  { text: 'FERRAMENTA', ink: CREAM, ground: GREEN, x: 38.5, z: STREET_NORTH, facing: 1, width: 2.4 },
  { text: 'PANIFICIO', ink: OXBLOOD, ground: OCHRE, x: -20.5, z: STREET_SOUTH, facing: -1, width: 2.4 },
  { text: 'OSTERIA DEL MOLO', ink: CREAM, ground: NAVY, x: 28, z: QUAY_NORTH, facing: 1, width: 3.2 },
];

const CELL_W = 512;
const CELL_H = 128;
const COLUMNS = 2;
const SIGN_Y = 3.42;

/** One canvas with every board on it: lettering, a ruled border, then scuffs and rain streaks. */
function drawAtlas(random: () => number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * COLUMNS;
  canvas.height = CELL_H * Math.ceil(SIGNS.length / COLUMNS);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Harbor: 2D canvas is not available for the shop signs');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  SIGNS.forEach((sign, i) => {
    const x = (i % COLUMNS) * CELL_W;
    const y = Math.floor(i / COLUMNS) * CELL_H;
    ctx.globalAlpha = 1;
    ctx.fillStyle = sign.ground;
    ctx.fillRect(x, y, CELL_W, CELL_H);
    ctx.strokeStyle = sign.ink;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 10, y + 10, CELL_W - 20, CELL_H - 20);
    let size = 76;
    do {
      ctx.font = `bold ${size}px Georgia, 'Times New Roman', serif`;
      size -= 4;
    } while (ctx.measureText(sign.text).width > CELL_W - 64 && size > 20);
    ctx.fillStyle = sign.ink;
    ctx.fillText(sign.text, x + CELL_W / 2, y + CELL_H / 2 + 4);
    // Wear: flecks of bare board and darker streaks running down from the top edge.
    for (let k = 0; k < 240; k++) {
      ctx.globalAlpha = 0.08 + random() * 0.3;
      ctx.fillStyle = random() < 0.6 ? '#8f8674' : sign.ground;
      ctx.fillRect(x + random() * CELL_W, y + random() * CELL_H, 1 + random() * 14, 1 + random() * 2.5);
    }
    for (let k = 0; k < 16; k++) {
      ctx.globalAlpha = 0.06 + random() * 0.1;
      ctx.fillStyle = '#2a241c';
      ctx.fillRect(x + random() * CELL_W, y, 2 + random() * 5, CELL_H * (0.3 + random() * 0.7));
    }
  });
  return canvas;
}

/** Shop signs. All of them share one texture and one draw call. */
export function addSigns(kit: Kit): { dispose(): void } {
  const { batch, mats, random } = kit;
  const map = new THREE.CanvasTexture(drawAtlas(random));
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const material = new THREE.MeshStandardNodeMaterial({ map, roughness: 0.85 });
  const rows = Math.ceil(SIGNS.length / COLUMNS);

  SIGNS.forEach((sign, i) => {
    const height = sign.width / 4;
    const y = sign.y ?? SIGN_Y;
    const board = new THREE.PlaneGeometry(sign.width, height);
    const u0 = (i % COLUMNS) / COLUMNS;
    const v1 = 1 - Math.floor(i / COLUMNS) / rows;
    const uv = board.getAttribute('uv');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) / COLUMNS, v1 - (1 - uv.getY(k)) / rows);
    if (sign.facing < 0) board.rotateY(Math.PI);
    board.translate(sign.x, y, sign.z + sign.facing * 0.046);
    batch.add(material, board);
    batch.box(mats.planksShade, sign.width + 0.1, height + 0.1, 0.04, sign.x, y, sign.z + sign.facing * 0.022, { tile: 1.2 });
  });

  return {
    dispose: () => {
      material.dispose();
      map.dispose();
    },
  };
}
