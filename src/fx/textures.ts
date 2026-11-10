import * as THREE from 'three/webgpu';
import { seededRandom } from '../core/random';

/** Cells per side of the particle sprite sheet. */
export const SPRITE_GRID = 4;
const SPRITE_CELL = 128;

/** Cell index of each sprite in the sheet from `createSpriteSheet`. */
export const SPRITE = {
  puffA: 0,
  puffB: 1,
  wisp: 2,
  chipA: 3,
  chipB: 4,
  splinter: 5,
  shard: 6,
  leaf: 7,
  drop: 8,
  splash: 9,
  streak: 10,
  glow: 11,
  flare: 12,
  grains: 13,
} as const;

export type Ctx = CanvasRenderingContext2D;
export type Random = () => number;

export function createCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: Ctx } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Effects need a 2D canvas to draw their sprites');
  return { canvas, ctx };
}

export function finish(canvas: HTMLCanvasElement, colorSpace: THREE.ColorSpace): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = colorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Soft round blob: `inner` (0 - 1) of the radius is solid, the rest falls away. */
export function blob(ctx: Ctx, x: number, y: number, radius: number, alpha: number, shade = 255, inner = 0): void {
  const gradient = ctx.createRadialGradient(x, y, radius * inner, x, y, radius);
  gradient.addColorStop(0, `rgba(${shade},${shade},${shade},${alpha})`);
  gradient.addColorStop(0.55, `rgba(${shade},${shade},${shade},${alpha * 0.42})`);
  gradient.addColorStop(1, `rgba(${shade},${shade},${shade},0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** Erase toward the cell edge so a sprite never ends on a hard line. */
export function softEdge(ctx: Ctx, size: number, solid: number): void {
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, half * solid, half, half, half * 0.98);
  gradient.addColorStop(0, 'rgba(0,0,0,1)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
}

/** Tileable-enough value noise on a small lattice, smoothed between points. */
function createNoise(random: Random, lattice: number): (x: number, y: number) => number {
  const values = new Float32Array(lattice * lattice);
  for (let i = 0; i < values.length; i++) values[i] = random();
  const at = (ix: number, iy: number): number => values[(iy % lattice) * lattice + (ix % lattice)]!;
  return (x, y) => {
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const ix = Math.floor(x) + lattice * 8;
    const iy = Math.floor(y) + lattice * 8;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
    const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
    return top + (bottom - top) * sy;
  };
}

/** Four octaves of noise, 0 - 1. */
function fractal(noise: (x: number, y: number) => number, x: number, y: number): number {
  let sum = 0;
  let weight = 0.5;
  let scale = 1;
  for (let octave = 0; octave < 4; octave++) {
    sum += noise(x * scale + octave * 7.3, y * scale + octave * 3.1) * weight;
    weight *= 0.5;
    scale *= 2;
  }
  return sum / 0.9375;
}

/**
 * A billow of dust or smoke: ragged, uneven coverage that is dense in the
 * middle and breaks up toward the edge, shaded as if lit from above.
 * `density` lifts the coverage; `squash` flattens the shape vertically.
 */
function drawPuff(ctx: Ctx, size: number, random: Random, density: number, squash: number): void {
  const noise = createNoise(random, 16);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size - 0.5) * 2;
      const v = (((y + 0.5) / size - 0.5) * 2) / squash;
      const radius = Math.sqrt(u * u + v * v);
      const falloff = Math.max(0, 1 - radius);
      const body = fractal(noise, u * 1.7 + 4, v * 1.7 + 4);
      // Noise pushes the outline in and out by up to half the radius, so no two edges look alike.
      const edge = falloff - (0.62 - body) * 1.1 - (1 - density) * 0.25;
      const coverage = Math.min(1, Math.max(0, edge * 3.2)) * Math.min(1, falloff * 4);
      const lumps = fractal(noise, u * 2.6 + 11, v * 2.6 + 2);
      const lit = 0.72 + 0.3 * lumps - 0.16 * v;
      const offset = (y * size + x) * 4;
      const shade = Math.round(Math.min(1, Math.max(0, lit)) * 255);
      image.data[offset] = shade;
      image.data[offset + 1] = shade;
      image.data[offset + 2] = shade;
      image.data[offset + 3] = Math.round(coverage * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
}

function drawWisp(ctx: Ctx, size: number, random: Random): void {
  const half = size / 2;
  for (let i = 0; i < 26; i++) {
    const t = i / 25;
    const y = size * (0.12 + t * 0.76);
    const x = half + Math.sin(t * 5.2 + 0.8) * size * 0.13 + (random() - 0.5) * size * 0.08;
    blob(ctx, x, y, size * (0.07 + 0.09 * Math.sin(t * Math.PI)), 0.2 + random() * 0.12, 215 + Math.floor(random() * 40));
  }
  softEdge(ctx, size, 0.3);
}

function drawPolygon(ctx: Ctx, size: number, random: Random, points: number, aspect: number, jitter: number): void {
  const half = size / 2;
  const radius = half * 0.62;
  ctx.beginPath();
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2 + random() * 0.5;
    const reach = radius * (1 - jitter + random() * jitter);
    const x = half + Math.cos(angle) * reach * aspect;
    const y = half + Math.sin(angle) * reach;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** A broken fragment, lit from the upper left so it reads as solid. */
function drawChip(ctx: Ctx, size: number, random: Random, aspect: number): void {
  drawPolygon(ctx, size, random, 6, aspect, 0.45);
  const gradient = ctx.createLinearGradient(size * 0.25, size * 0.2, size * 0.75, size * 0.8);
  gradient.addColorStop(0, 'rgb(255,255,255)');
  gradient.addColorStop(0.55, 'rgb(190,190,190)');
  gradient.addColorStop(1, 'rgb(110,110,110)');
  ctx.fillStyle = gradient;
  ctx.fill();
}

function drawShard(ctx: Ctx, size: number, random: Random): void {
  drawPolygon(ctx, size, random, 3, 0.7, 0.3);
  const gradient = ctx.createLinearGradient(size * 0.2, size * 0.2, size * 0.8, size * 0.8);
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.3)');
  gradient.addColorStop(1, 'rgba(255,255,255,0.7)');
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = size * 0.03;
  ctx.stroke();
}

function drawLeaf(ctx: Ctx, size: number): void {
  const half = size / 2;
  ctx.beginPath();
  ctx.moveTo(half, size * 0.14);
  ctx.quadraticCurveTo(size * 0.82, half, half, size * 0.86);
  ctx.quadraticCurveTo(size * 0.18, half, half, size * 0.14);
  const gradient = ctx.createLinearGradient(size * 0.25, 0, size * 0.75, 0);
  gradient.addColorStop(0, 'rgb(255,255,255)');
  gradient.addColorStop(0.5, 'rgb(170,170,170)');
  gradient.addColorStop(1, 'rgb(225,225,225)');
  ctx.fillStyle = gradient;
  ctx.fill();
}

function drawSplash(ctx: Ctx, size: number, random: Random): void {
  const half = size / 2;
  for (let i = 0; i < 34; i++) {
    const lean = (random() - 0.5) * 0.55;
    const height = 0.2 + random() * 0.65;
    const steps = 6;
    for (let s = 0; s < steps; s++) {
      const t = (s / (steps - 1)) * height;
      const x = half + lean * t * size;
      const y = size * (0.93 - t * 0.86);
      blob(ctx, x, y, size * (0.035 + 0.03 * (1 - t)), 0.2 + random() * 0.1);
    }
  }
  softEdge(ctx, size, 0.35);
}

/** Streak for velocity-stretched sprites: the head is at the top, the tail fades downward. */
function drawStreak(ctx: Ctx, size: number): void {
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const along = 1 - y / (size - 1);
    const lengthwise = Math.pow(along, 1.6) * Math.min(1, (1 - along) * 14);
    for (let x = 0; x < size; x++) {
      const across = Math.abs((x + 0.5) / size - 0.5) * 2;
      const core = Math.exp(-across * across * 9);
      const alpha = Math.min(1, core * lengthwise * 1.25);
      const offset = (y * size + x) * 4;
      image.data[offset] = 255;
      image.data[offset + 1] = 255;
      image.data[offset + 2] = 255;
      image.data[offset + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
}

function drawGlow(ctx: Ctx, size: number): void {
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = ((x + 0.5) / size - 0.5) * 2;
      const dy = ((y + 0.5) / size - 0.5) * 2;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const alpha = Math.max(0, Math.exp(-distance * distance * 7) - 0.001) * Math.max(0, 1 - distance);
      const offset = (y * size + x) * 4;
      image.data[offset] = 255;
      image.data[offset + 1] = 255;
      image.data[offset + 2] = 255;
      image.data[offset + 3] = Math.round(Math.min(1, alpha * 1.3) * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** One soft spike from the centre outward, drawn as a squashed radial gradient. */
export function spike(ctx: Ctx, cx: number, cy: number, angle: number, length: number, width: number, alpha: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.scale(1, width / length);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, length);
  gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
  gradient.addColorStop(0.3, `rgba(255,255,255,${alpha * 0.5})`);
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, length, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFlare(ctx: Ctx, size: number, random: Random): void {
  const half = size / 2;
  ctx.globalCompositeOperation = 'lighter';
  blob(ctx, half, half, half * 0.42, 0.9);
  for (let i = 0; i < 7; i++) {
    spike(ctx, half, half, random() * Math.PI * 2, half * (0.5 + random() * 0.45), half * 0.07, 0.8);
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawGrains(ctx: Ctx, size: number, random: Random): void {
  for (let i = 0; i < 7; i++) {
    const x = size * (0.2 + random() * 0.6);
    const y = size * (0.2 + random() * 0.6);
    const shade = 150 + Math.floor(random() * 105);
    blob(ctx, x, y, size * (0.035 + random() * 0.045), 1, shade, 0.55);
  }
}

/**
 * Sprite sheet for the particle pools: white shapes with their own shading in
 * RGB and coverage in alpha. Particles tint them.
 */
export function createSpriteSheet(): THREE.CanvasTexture {
  const { canvas, ctx } = createCanvas(SPRITE_GRID * SPRITE_CELL, SPRITE_GRID * SPRITE_CELL);
  const random = seededRandom(0x51f7);
  const draw = (cell: number, paint: (cellCtx: Ctx, size: number) => void): void => {
    const tile = createCanvas(SPRITE_CELL, SPRITE_CELL);
    paint(tile.ctx, SPRITE_CELL);
    ctx.drawImage(tile.canvas, (cell % SPRITE_GRID) * SPRITE_CELL, Math.floor(cell / SPRITE_GRID) * SPRITE_CELL);
  };
  draw(SPRITE.puffA, (c, s) => drawPuff(c, s, random, 0.75, 1));
  draw(SPRITE.puffB, (c, s) => drawPuff(c, s, random, 0.6, 0.85));
  draw(SPRITE.wisp, (c, s) => drawWisp(c, s, random));
  draw(SPRITE.chipA, (c, s) => drawChip(c, s, random, 1));
  draw(SPRITE.chipB, (c, s) => drawChip(c, s, random, 0.7));
  draw(SPRITE.splinter, (c, s) => drawChip(c, s, random, 0.22));
  draw(SPRITE.shard, (c, s) => drawShard(c, s, random));
  draw(SPRITE.leaf, (c, s) => drawLeaf(c, s));
  draw(SPRITE.drop, (c, s) => blob(c, s / 2, s / 2, s * 0.4, 1, 255, 0.35));
  draw(SPRITE.splash, (c, s) => drawSplash(c, s, random));
  draw(SPRITE.streak, (c, s) => drawStreak(c, s));
  draw(SPRITE.glow, (c, s) => drawGlow(c, s));
  draw(SPRITE.flare, (c, s) => drawFlare(c, s, random));
  draw(SPRITE.grains, (c, s) => drawGrains(c, s, random));
  return finish(canvas, THREE.NoColorSpace);
}
