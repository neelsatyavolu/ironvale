import * as THREE from 'three/webgpu';

/**
 * Paper and paint that ends up on old walls: bill posters, faded painted
 * advertisements and the stencils on packing cases. One canvas atlas and one
 * material carry all of them.
 */
const SIZE = 1024;
const POSTER = { w: 256, h: 384, columns: 4 } as const;
const AD = { w: 512, h: 128, top: 768 } as const;
const STENCIL = 128;

/** UV rectangle in the atlas: [u0, v0, u1, v1] with v up. */
export type AtlasCell = readonly [number, number, number, number];

const cell = (x: number, y: number, w: number, h: number): AtlasCell => [x / SIZE, 1 - (y + h) / SIZE, (x + w) / SIZE, 1 - y / SIZE];

export const POSTER_COUNT = 7;
export const AD_COUNT = 4;
export const STENCIL_COUNT = 6;

export const posterCell = (index: number): AtlasCell => {
  const i = index % POSTER_COUNT;
  return cell((i % POSTER.columns) * POSTER.w, Math.floor(i / POSTER.columns) * POSTER.h, POSTER.w, POSTER.h);
};
export const adCell = (index: number): AtlasCell => {
  const i = index % AD_COUNT;
  return cell((i % 2) * AD.w, AD.top + Math.floor(i / 2) * AD.h, AD.w, AD.h);
};
export const stencilCell = (index: number): AtlasCell => {
  const i = index % STENCIL_COUNT;
  return cell(3 * POSTER.w + (i % 2) * STENCIL, POSTER.h + Math.floor(i / 2) * STENCIL, STENCIL, STENCIL);
};

type Motif = 'sun' | 'fish' | 'stripes' | 'star' | 'wave' | 'ring' | 'plain';

interface Bill {
  readonly paper: string;
  readonly ink: string;
  readonly accent: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly motif: Motif;
}

const BILLS: readonly Bill[] = [
  { paper: '#e9dfc4', ink: '#1f2d4a', accent: '#c8452e', title: 'FESTA DEL MARE', lines: ['15 AGOSTO', 'PIAZZA DEL PORTO'], motif: 'sun' },
  { paper: '#e3c15a', ink: '#2a1d14', accent: '#a4301f', title: 'CINEMA LUX', lines: ['OGNI SERA', 'ORE 21'], motif: 'star' },
  { paper: '#d9e0de', ink: '#1d3b52', accent: '#1d3b52', title: 'REGATA', lines: ['COPPA DEL MOLO', 'DOMENICA'], motif: 'wave' },
  { paper: '#e6d6c8', ink: '#5c1f1a', accent: '#c79a3f', title: 'CIRCO AURORA', lines: ['TRE GIORNI SOLI'], motif: 'ring' },
  { paper: '#efe8d6', ink: '#23231f', accent: '#2f6b4a', title: 'MERCATO', lines: ['DEL PESCE', 'OGNI MATTINA'], motif: 'fish' },
  { paper: '#d7c9a6', ink: '#3a2a1a', accent: '#8a2f24', title: 'TOMBOLA', lines: ['SALA PARROCCHIALE', 'SABATO'], motif: 'stripes' },
  { paper: '#f0ead8', ink: '#1a1a1a', accent: '#1a1a1a', title: 'AVVISO', lines: ['IL PORTO RESTA', 'CHIUSO AI CARRI', 'DOPO IL TRAMONTO'], motif: 'plain' },
];

const ADS: readonly (readonly [string, string])[] = [
  ['VINI · OLIO · SALUMI', '#5a211b'],
  ['DEPOSITO RETI', '#1f3350'],
  ['AMARO DEL PORTO', '#e8e0cc'],
  ['SALI E TABACCHI', '#1c1c1c'],
];

const STENCILS = ['FRAGILE', 'GENOVA', 'N. 47', 'ALTO', 'PORTO 12', 'VETRO'] as const;

function fit(ctx: CanvasRenderingContext2D, text: string, width: number, start: number, family: string): void {
  let size = start;
  do {
    ctx.font = `bold ${size}px ${family}`;
    size -= 2;
  } while (ctx.measureText(text).width > width && size > 10);
}

function drawMotif(ctx: CanvasRenderingContext2D, motif: Motif, cx: number, cy: number, accent: string, ink: string): void {
  ctx.fillStyle = accent;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 6;
  switch (motif) {
    case 'sun':
      ctx.beginPath();
      ctx.arc(cx, cy, 44, 0, Math.PI * 2);
      ctx.fill();
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * 54, cy + Math.sin(a) * 54);
        ctx.lineTo(cx + Math.cos(a) * 78, cy + Math.sin(a) * 78);
        ctx.stroke();
      }
      break;
    case 'star':
      ctx.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
        const r = k % 2 === 0 ? 70 : 28;
        ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      break;
    case 'wave':
      for (let row = 0; row < 4; row++) {
        ctx.beginPath();
        for (let x = -90; x <= 90; x += 6) ctx.lineTo(cx + x, cy - 40 + row * 26 + Math.sin(x * 0.09 + row) * 9);
        ctx.stroke();
      }
      break;
    case 'ring':
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.arc(cx, cy, 58, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.arc(cx, cy, 20, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'fish':
      ctx.beginPath();
      ctx.ellipse(cx - 10, cy, 62, 30, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + 44, cy);
      ctx.lineTo(cx + 88, cy - 30);
      ctx.lineTo(cx + 88, cy + 30);
      ctx.closePath();
      ctx.fill();
      break;
    case 'stripes':
      for (let k = 0; k < 5; k++) ctx.fillRect(cx - 90 + k * 40, cy - 60, 20, 120);
      break;
    case 'plain':
      ctx.fillStyle = ink;
      ctx.fillRect(cx - 90, cy + 50, 180, 4);
      ctx.fillRect(cx - 90, cy - 54, 180, 4);
      break;
  }
}

function drawBill(ctx: CanvasRenderingContext2D, bill: Bill, x: number, y: number, random: () => number): void {
  const { w, h } = POSTER;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = bill.paper;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = bill.ink;
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 12, y + 12, w - 24, h - 24);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = bill.ink;
  fit(ctx, bill.title, w - 44, 58, "Georgia, 'Times New Roman', serif");
  ctx.fillText(bill.title, x + w / 2, y + 62);
  drawMotif(ctx, bill.motif, x + w / 2, y + 180, bill.accent, bill.ink);
  ctx.fillStyle = bill.ink;
  bill.lines.forEach((line, i) => {
    fit(ctx, line, w - 56, 30, 'Helvetica, Arial, sans-serif');
    ctx.fillText(line, x + w / 2, y + 290 + i * 30);
  });

  // Sun fade, damp stains and grime running down from the top edge.
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#f2ecd9';
  ctx.fillRect(x, y, w, h);
  for (let k = 0; k < 14; k++) {
    ctx.globalAlpha = 0.05 + random() * 0.1;
    ctx.fillStyle = '#3a2f1e';
    ctx.fillRect(x + random() * w, y, 4 + random() * 22, h * (0.2 + random() * 0.8));
  }
  for (let k = 0; k < 5; k++) {
    ctx.globalAlpha = 0.1 + random() * 0.1;
    ctx.fillStyle = '#4a3b22';
    ctx.beginPath();
    ctx.ellipse(x + random() * w, y + random() * h, 18 + random() * 40, 14 + random() * 30, random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Tears: bites out of the corners and edges, and sometimes a strip ripped off.
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-out';
  const bite = (bx: number, by: number, radius: number): void => {
    ctx.beginPath();
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2;
      const r = radius * (0.55 + random() * 0.6);
      ctx.lineTo(bx + Math.cos(a) * r, by + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  };
  for (const [cx, cy] of [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ] as const) {
    if (random() < 0.75) bite(cx, cy, 20 + random() * 50);
  }
  for (let k = 0; k < 7; k++) {
    const along = random();
    const edge = Math.floor(random() * 4);
    bite(edge < 2 ? x + along * w : x + (edge - 2) * w, edge < 2 ? y + edge * h : y + along * h, 8 + random() * 20);
  }
  if (random() < 0.5) {
    const from = y + h * (0.55 + random() * 0.3);
    ctx.beginPath();
    ctx.moveTo(x, from);
    for (let px = 0; px <= w; px += 16) ctx.lineTo(x + px, from + (random() - 0.5) * 26 - px * 0.12);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Lettering painted straight onto plaster and mostly weathered away. */
function drawAd(ctx: CanvasRenderingContext2D, text: string, ink: string, x: number, y: number, random: () => number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, AD.w, AD.h);
  ctx.clip();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fit(ctx, text, AD.w - 36, 84, "Georgia, 'Times New Roman', serif");
  ctx.fillText(text, x + AD.w / 2, y + AD.h / 2 + 2);
  ctx.fillRect(x + 14, y + 10, AD.w - 28, 5);
  ctx.fillRect(x + 14, y + AD.h - 15, AD.w - 28, 5);
  ctx.globalCompositeOperation = 'destination-out';
  for (let k = 0; k < 900; k++) {
    ctx.globalAlpha = 0.25 + random() * 0.6;
    ctx.fillRect(x + random() * AD.w, y + random() * AD.h, 1 + random() * 9, 1 + random() * 5);
  }
  for (let k = 0; k < 26; k++) {
    ctx.globalAlpha = 0.3 + random() * 0.5;
    ctx.beginPath();
    ctx.ellipse(x + random() * AD.w, y + random() * AD.h, 6 + random() * 30, 5 + random() * 16, random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawStencil(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, random: () => number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, STENCIL, STENCIL);
  ctx.clip();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#16120d';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fit(ctx, text, STENCIL - 14, 40, "'Courier New', Courier, monospace");
  ctx.fillText(text, x + STENCIL / 2, y + STENCIL / 2);
  ctx.strokeStyle = '#16120d';
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 6, y + STENCIL / 2 - 28, STENCIL - 12, 56);
  ctx.globalCompositeOperation = 'destination-out';
  for (let k = 0; k < 160; k++) {
    ctx.globalAlpha = 0.3 + random() * 0.6;
    ctx.fillRect(x + random() * STENCIL, y + random() * STENCIL, 1 + random() * 5, 1 + random() * 3);
  }
  ctx.restore();
}

export function createPosterMap(random: () => number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Harbor: 2D canvas is not available for the posters');
  ctx.clearRect(0, 0, SIZE, SIZE);
  BILLS.forEach((bill, i) => drawBill(ctx, bill, (i % POSTER.columns) * POSTER.w, Math.floor(i / POSTER.columns) * POSTER.h, random));
  ADS.forEach(([text, ink], i) => drawAd(ctx, text, ink, (i % 2) * AD.w, AD.top + Math.floor(i / 2) * AD.h, random));
  STENCILS.forEach((text, i) => drawStencil(ctx, text, 3 * POSTER.w + (i % 2) * STENCIL, POSTER.h + Math.floor(i / 2) * STENCIL, random));
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return map;
}

/** Paper and paint lying on a wall: blended over it, a hair in front, casting nothing. */
export function posterMaterial(map: THREE.Texture): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ map, color: 0xa1988a, roughness: 0.92, transparent: true, depthWrite: false });
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -6;
  return material;
}

/**
 * Upright quad showing one atlas cell, centred on (x, y, z) and facing along
 * `yaw` (0 faces +Z). `roll` tips it in its own plane.
 */
export function decalQuad(atlas: AtlasCell, width: number, height: number, x: number, y: number, z: number, yaw: number, roll = 0): THREE.BufferGeometry {
  const quad = new THREE.PlaneGeometry(width, height);
  const uv = quad.getAttribute('uv');
  const [u0, v0, u1, v1] = atlas;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) * (u1 - u0), v0 + uv.getY(k) * (v1 - v0));
  if (roll !== 0) quad.rotateZ(roll);
  quad.rotateY(yaw);
  quad.translate(x, y, z);
  return quad;
}
