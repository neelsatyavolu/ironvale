import * as THREE from 'three/webgpu';
import { seededRandom } from '../core/random';
import { blob, createCanvas, finish, softEdge, spike, type Ctx, type Random } from './textures';

export const FLASH_GRID = 2;
const FLASH_CELL = 256;
/** Cells of the sheet from `createFlashSheet`. */
export const FLASH = { star: 0, round: 1, small: 2, jet: 3 } as const;

function drawFlashFront(ctx: Ctx, size: number, random: Random, spikes: number, reach: number, core: number): void {
  const half = size / 2;
  ctx.globalCompositeOperation = 'lighter';
  blob(ctx, half, half, half * core, 1);
  blob(ctx, half, half, half * core * 0.55, 1);
  for (let i = 0; i < spikes; i++) {
    const angle = (i / spikes) * Math.PI * 2 + (random() - 0.5) * 0.7;
    const length = half * reach * (0.55 + random() * 0.45);
    spike(ctx, half, half, angle, length, half * (0.07 + random() * 0.06), 0.9);
    spike(ctx, half, half, angle + (random() - 0.5) * 0.3, length * 0.6, half * 0.16, 0.5);
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawFlashRound(ctx: Ctx, size: number, random: Random): void {
  const half = size / 2;
  ctx.globalCompositeOperation = 'lighter';
  blob(ctx, half, half, half * 0.6, 0.9);
  for (let i = 0; i < 22; i++) {
    const angle = random() * Math.PI * 2;
    const reach = half * (0.15 + random() * 0.42);
    blob(ctx, half + Math.cos(angle) * reach, half + Math.sin(angle) * reach, half * (0.12 + random() * 0.2), 0.35);
  }
  for (let i = 0; i < 12; i++) spike(ctx, half, half, random() * Math.PI * 2, half * (0.6 + random() * 0.3), half * 0.09, 0.45);
  ctx.globalCompositeOperation = 'source-over';
}

/** Side view: a tongue of flame leaving the muzzle at the bottom edge and tapering upward. */
function drawFlashJet(ctx: Ctx, size: number, random: Random): void {
  const half = size / 2;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 40; i++) {
    const t = i / 39;
    const y = size * (0.92 - t * 0.84);
    const width = size * (0.05 + 0.15 * Math.sin(Math.min(1, t * 1.5) * Math.PI) * (1 - t * 0.5));
    const x = half + (random() - 0.5) * size * 0.05 * t;
    blob(ctx, x, y, width, 0.3 * (1 - t * 0.65));
  }
  for (let i = 0; i < 5; i++) {
    spike(ctx, half, size * 0.9, -Math.PI / 2 + (random() - 0.5) * 0.5, size * (0.4 + random() * 0.4), size * 0.03, 0.5);
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** Brightness masks for muzzle flashes. The shader colours them. */
export function createFlashSheet(): THREE.CanvasTexture {
  const { canvas, ctx } = createCanvas(FLASH_GRID * FLASH_CELL, FLASH_GRID * FLASH_CELL);
  const random = seededRandom(0xf1a5);
  const draw = (cell: number, paint: (cellCtx: Ctx, size: number) => void): void => {
    const tile = createCanvas(FLASH_CELL, FLASH_CELL);
    paint(tile.ctx, FLASH_CELL);
    softEdge(tile.ctx, FLASH_CELL, 0.55);
    ctx.drawImage(tile.canvas, (cell % FLASH_GRID) * FLASH_CELL, Math.floor(cell / FLASH_GRID) * FLASH_CELL);
  };
  draw(FLASH.star, (c, s) => drawFlashFront(c, s, random, 6, 0.95, 0.3));
  draw(FLASH.round, (c, s) => drawFlashRound(c, s, random));
  draw(FLASH.small, (c, s) => drawFlashFront(c, s, random, 5, 0.6, 0.26));
  draw(FLASH.jet, (c, s) => drawFlashJet(c, s, random));
  return finish(canvas, THREE.NoColorSpace);
}
