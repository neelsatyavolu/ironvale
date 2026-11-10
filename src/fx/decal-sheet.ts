import * as THREE from 'three/webgpu';
import { seededRandom } from '../core/random';
import { blob, createCanvas, finish, softEdge, type Ctx, type Random } from './textures';

export const DECAL_GRID = 4;
const DECAL_CELL = 128;
/** Row of the decal sheet for each kind of hole; each row holds `DECAL_GRID` variants. */
export const DECAL_ROW = { masonry: 0, metal: 1, wood: 2, soft: 3 } as const;
export type DecalKind = keyof typeof DECAL_ROW;

function ragged(ctx: Ctx, cx: number, cy: number, radius: number, random: Random, points: number, roughness: number): void {
  ctx.beginPath();
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const reach = radius * (1 - roughness + random() * roughness * 2);
    const x = cx + Math.cos(angle) * reach;
    const y = cy + Math.sin(angle) * reach;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Spalled crater: pale chipped rim, darker dished stone, a black hole in the middle. */
function drawMasonryHole(ctx: Ctx, size: number, random: Random): void {
  const half = size / 2;
  const cx = half + (random() - 0.5) * size * 0.06;
  const cy = half + (random() - 0.5) * size * 0.06;
  ragged(ctx, cx, cy, size * 0.36, random, 14, 0.22);
  ctx.fillStyle = 'rgba(150,146,139,0.5)';
  ctx.fill();
  for (let i = 0; i < 5; i++) {
    const angle = random() * Math.PI * 2;
    ragged(ctx, cx + Math.cos(angle) * size * 0.3, cy + Math.sin(angle) * size * 0.3, size * (0.04 + random() * 0.05), random, 6, 0.4);
    ctx.fillStyle = 'rgba(146,142,135,0.45)';
    ctx.fill();
  }
  ragged(ctx, cx, cy, size * 0.27, random, 12, 0.2);
  const dish = ctx.createRadialGradient(cx - size * 0.04, cy - size * 0.05, 0, cx, cy, size * 0.27);
  dish.addColorStop(0, 'rgba(52,49,46,0.96)');
  dish.addColorStop(1, 'rgba(104,99,93,0.92)');
  ctx.fillStyle = dish;
  ctx.fill();
  ragged(ctx, cx, cy, size * 0.13, random, 9, 0.25);
  ctx.fillStyle = 'rgba(12,11,10,1)';
  ctx.fill();
  blob(ctx, cx, cy, size * 0.2, 0.5, 20);
}

/** Dimple in sheet metal: a bright ring of bare steel around a dark puncture. */
function drawMetalHole(ctx: Ctx, size: number, random: Random): void {
  const half = size / 2;
  blob(ctx, half, half, size * 0.46, 0.4, 30);
  const ring = ctx.createRadialGradient(half, half, size * 0.1, half, half, size * 0.3);
  ring.addColorStop(0, 'rgba(90,92,96,1)');
  ring.addColorStop(0.45, 'rgba(232,234,238,1)');
  ring.addColorStop(0.8, 'rgba(150,152,158,0.9)');
  ring.addColorStop(1, 'rgba(120,122,128,0)');
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(half, half, size * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.ellipse(half - size * 0.08, half - size * 0.09, size * 0.07, size * 0.03, -0.8, 0, Math.PI * 2);
  ctx.fill();
  ragged(ctx, half, half, size * 0.1, random, 10, 0.12);
  ctx.fillStyle = 'rgba(6,6,7,1)';
  ctx.fill();
}

/** Ragged puncture in timber with pale torn fibres along the grain. */
function drawWoodHole(ctx: Ctx, size: number, random: Random): void {
  const half = size / 2;
  ctx.lineCap = 'round';
  for (let i = 0; i < 16; i++) {
    const x = half + (random() - 0.5) * size * 0.3;
    const reach = size * (0.12 + random() * 0.26);
    ctx.strokeStyle = `rgba(${200 + Math.floor(random() * 40)},${170 + Math.floor(random() * 30)},${120 + Math.floor(random() * 30)},0.8)`;
    ctx.lineWidth = size * (0.012 + random() * 0.02);
    ctx.beginPath();
    ctx.moveTo(x, half - reach);
    ctx.lineTo(x + (random() - 0.5) * size * 0.04, half + reach * (0.5 + random() * 0.5));
    ctx.stroke();
  }
  blob(ctx, half, half, size * 0.26, 0.6, 35);
  ctx.save();
  ctx.translate(half, half);
  ctx.scale(0.75, 1.15);
  ragged(ctx, 0, 0, size * 0.13, random, 12, 0.35);
  ctx.restore();
  ctx.fillStyle = 'rgba(14,10,7,1)';
  ctx.fill();
}

/** Scuffed pock for earth and other soft ground. */
function drawSoftHole(ctx: Ctx, size: number, random: Random): void {
  const half = size / 2;
  for (let i = 0; i < 12; i++) {
    const angle = random() * Math.PI * 2;
    const reach = random() * size * 0.22;
    blob(ctx, half + Math.cos(angle) * reach, half + Math.sin(angle) * reach, size * (0.08 + random() * 0.12), 0.35, 22);
  }
  blob(ctx, half, half, size * 0.17, 0.9, 8, 0.3);
}

/** Bullet-hole sheet: one row per material, four variants each. Real colours, so it is sRGB. */
export function createDecalSheet(): THREE.CanvasTexture {
  const { canvas, ctx } = createCanvas(DECAL_GRID * DECAL_CELL, DECAL_GRID * DECAL_CELL);
  const random = seededRandom(0xdeca1);
  const painters: Readonly<Record<DecalKind, (cellCtx: Ctx, size: number, r: Random) => void>> = {
    masonry: drawMasonryHole,
    metal: drawMetalHole,
    wood: drawWoodHole,
    soft: drawSoftHole,
  };
  for (const kind of Object.keys(DECAL_ROW) as DecalKind[]) {
    for (let variant = 0; variant < DECAL_GRID; variant++) {
      const tile = createCanvas(DECAL_CELL, DECAL_CELL);
      painters[kind](tile.ctx, DECAL_CELL, random);
      softEdge(tile.ctx, DECAL_CELL, 0.82);
      ctx.drawImage(tile.canvas, variant * DECAL_CELL, DECAL_ROW[kind] * DECAL_CELL);
    }
  }
  return finish(canvas, THREE.SRGBColorSpace);
}
