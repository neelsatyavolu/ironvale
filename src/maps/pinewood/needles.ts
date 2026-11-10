import * as THREE from 'three/webgpu';

const SIZE = 1024;
/** Alpha cut-off the branch cards are drawn with; mip levels are tuned to it. */
export const NEEDLE_ALPHA_TEST = 0.34;
/** Mean needle colour; fills fully transparent texels so filtering does not bleed black. */
const FILL: readonly [number, number, number] = [36, 55, 27];
/** Needle length in texels by twig level: stem, side twig, branchlet, sprig. */
const NEEDLE_LENGTH: readonly number[] = [11, 10, 8.5, 7];
const STEP = 3;

interface Twig {
  /** Centre line sampled every STEP texels: x, y, heading. */
  readonly points: readonly (readonly [number, number, number])[];
  readonly level: number;
}

/** A twig that bends by `curve` radians over its length. */
function twig(x: number, y: number, angle: number, length: number, curve: number, level: number): Twig {
  const points: [number, number, number][] = [];
  const steps = Math.max(2, Math.ceil(length / STEP));
  let px = x;
  let py = y;
  for (let i = 0; i <= steps; i++) {
    const heading = angle + (curve * i) / steps;
    points.push([px, py, heading]);
    px += Math.cos(heading) * (length / steps);
    py += Math.sin(heading) * (length / steps);
  }
  return { points, level };
}

/**
 * One conifer bough seen from above: a stem with side twigs that carry
 * branchlets and sprigs. It is narrow at the trunk end, widest two fifths of
 * the way out and tapers to the tip, with irregular spacing throughout so the
 * gaps between branchlets never line up into a pattern.
 */
function layoutFrond(random: () => number): Twig[] {
  const stemLength = SIZE - 30;
  const twigs: Twig[] = [twig(SIZE / 2, 8, Math.PI / 2, stemLength, 0, 0)];
  let side = 1;
  for (let t = 0.05; t < 0.97; t += 0.028 + random() * 0.03) {
    side = random() < 0.85 ? -side : side;
    const envelope = t < 0.42 ? 0.28 + (t / 0.42) * 0.72 : 1 - ((t - 0.42) / 0.58) ** 1.3 * 0.92;
    const sweep = (1.12 - 0.5 * t) * (0.9 + random() * 0.2);
    // Stay inside the texture: side twigs stop short of its edges and of the stem's tip.
    const room = Math.min((envelope * SIZE * 0.4) / Math.sin(sweep), ((1 - t) * stemLength * 0.92 + 16) / Math.cos(sweep));
    const length = room * (0.7 + random() * 0.3);
    const branch = twig(SIZE / 2, 8 + t * stemLength, Math.PI / 2 - side * sweep, length, side * 0.28, 1);
    twigs.push(branch);
    let branchSide = random() < 0.5 ? 1 : -1;
    for (let along = 12 + random() * 14; along < length - 10; along += 19 + random() * 17) {
      branchSide = random() < 0.8 ? -branchSide : branchSide;
      const [bx, by, heading] = branch.points[Math.floor(along / (length / (branch.points.length - 1)))] as readonly [number, number, number];
      const reach = Math.min((length - along) * 0.75, 84) * (0.45 + random() * 0.55) + 10;
      const branchlet = twig(bx, by, heading + branchSide * (0.6 + random() * 0.35), reach, -branchSide * 0.18, 2);
      twigs.push(branchlet);
      if (reach < 50) continue;
      // Long branchlets carry a sprig or two of their own.
      for (let k = 0.35 + random() * 0.2; k < 0.85; k += 0.3 + random() * 0.2) {
        const [sx, sy, at] = branchlet.points[Math.floor(k * (branchlet.points.length - 1))] as readonly [number, number, number];
        twigs.push(twig(sx, sy, at + (random() < 0.5 ? 1 : -1) * (0.6 + random() * 0.3), 14 + random() * 16, 0, 3));
      }
    }
  }
  return twigs;
}

/** Needle colour for a paint pass (0 shaded, 1 body, 2 sunlit new growth). */
function needleColor(pass: number, tip: number, random: () => number): string {
  const v = random();
  if (pass === 0) return `rgb(${Math.round(15 + v * 10)},${Math.round(29 + v * 14)},${Math.round(15 + v * 7)})`;
  if (pass === 1) return `rgb(${Math.round(32 + v * 16 + tip * 8)},${Math.round(53 + v * 18 + tip * 10)},${Math.round(25 + v * 8)})`;
  return `rgb(${Math.round(60 + v * 24)},${Math.round(84 + v * 22)},${Math.round(36 + v * 12)})`;
}

function paintWood(ctx: CanvasRenderingContext2D, twigs: readonly Twig[]): void {
  ctx.strokeStyle = 'rgb(56,43,32)';
  for (const { points, level } of twigs) {
    if (level === 3) continue;
    const last = points.length - 1;
    for (let i = 0; i < last; i++) {
      const [x0, y0] = points[i] as readonly [number, number, number];
      const [x1, y1] = points[i + 1] as readonly [number, number, number];
      ctx.lineWidth = level === 0 ? 6 - 4.2 * (i / last) : level === 1 ? 2.4 - 1.2 * (i / last) : 1.3;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
}

/** Needles in three passes, darkest first, with the woody twigs between the first two. */
function paintFrond(ctx: CanvasRenderingContext2D, twigs: readonly Twig[], random: () => number): void {
  ctx.lineCap = 'round';
  for (let pass = 0; pass < 3; pass++) {
    if (pass === 1) paintWood(ctx, twigs);
    const every = pass === 0 ? 0.55 : pass === 1 ? 0.72 : 1.3;
    ctx.lineWidth = pass === 0 ? 2.0 : pass === 1 ? 1.5 : 1.15;
    for (const { points, level } of twigs) {
      const last = points.length - 1;
      const base = NEEDLE_LENGTH[level] as number;
      // The stem is bare where it leaves the trunk.
      const first = level === 0 ? Math.floor(last * 0.07) : 0;
      for (let f = first; f <= last; f += every * (0.6 + random() * 0.8)) {
        const [x0, y0, heading] = points[Math.floor(f)] as readonly [number, number, number];
        const [x1, y1] = points[Math.min(last, Math.floor(f) + 1)] as readonly [number, number, number];
        const x = x0 + (x1 - x0) * (f % 1);
        const y = y0 + (y1 - y0) * (f % 1);
        const tip = f / last;
        if (pass === 2 && random() > 0.25 + tip * 0.6) continue;
        const side = random() < 0.5 ? 1 : -1;
        const spread = heading + (tip > 0.96 ? (random() - 0.5) * 1.3 : side * (0.7 + random() * 0.55));
        const length = base * (0.7 + random() * 0.55) * (pass === 0 ? 1.15 : 1);
        ctx.strokeStyle = needleColor(pass, tip, random);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(spread) * length, y + Math.sin(spread) * length);
        ctx.stroke();
      }
    }
  }
}

/** Fraction of texels that pass the alpha test when alpha is multiplied by `gain`. */
function coverage(data: Uint8Array, gain: number): number {
  const cut = NEEDLE_ALPHA_TEST * 255;
  let passed = 0;
  for (let i = 3; i < data.length; i += 4) if ((data[i] as number) * gain >= cut) passed++;
  return passed / (data.length / 4);
}

/**
 * Mip chain whose alpha is rescaled per level so the same share of each card
 * survives the alpha test at any distance. Plain mipmaps thin foliage out
 * until far trees are bare.
 */
function coverageMips(base: Uint8Array): { data: Uint8Array; width: number; height: number }[] {
  const target = coverage(base, 1);
  const levels = [{ data: base, width: SIZE, height: SIZE }];
  let previous = base;
  for (let size = SIZE / 2; size >= 1; size /= 2) {
    const next = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        for (let c = 0; c < 4; c++) {
          const a = (y * 2 * size * 2 + x * 2) * 4 + c;
          const b = a + size * 2 * 4;
          next[(y * size + x) * 4 + c] =
            ((previous[a] as number) + (previous[a + 4] as number) + (previous[b] as number) + (previous[b + 4] as number)) / 4;
        }
      }
    }
    previous = next;
    const scaled = next.slice();
    let low = 1;
    let high = 12;
    for (let i = 0; i < 12; i++) {
      const mid = (low + high) / 2;
      if (coverage(next, mid) < target) low = mid;
      else high = mid;
    }
    for (let i = 3; i < scaled.length; i += 4) scaled[i] = Math.min(255, (next[i] as number) * high);
    levels.push({ data: scaled, width: size, height: size });
  }
  return levels;
}

/**
 * Paints one conifer bough seen from above (base at V = 0, tip at V = 1, stem
 * along U = 0.5) and returns it as an alpha-tested texture for branch cards. Generated because the
 * only CC0 needle atlas is an ambientCG zip the asset fetcher cannot unpack.
 */
export function createNeedleTexture(random: () => number, anisotropy = 4): THREE.DataTexture {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Pinewood needs a 2D canvas to paint its needle texture');
  paintFrond(ctx, layoutFrond(random), random);

  const image = ctx.getImageData(0, 0, SIZE, SIZE);
  const data = new Uint8Array(image.data.buffer.slice(0));
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] as number) < 24) data.set(FILL, i);
  }
  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  texture.mipmaps = coverageMips(data) as unknown as THREE.DataTexture['mipmaps'];
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}
