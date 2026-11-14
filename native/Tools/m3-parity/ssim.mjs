#!/usr/bin/env node
// Structural similarity between two images, as the reference implementation of Wang, Bovik,
// Sheikh and Simoncelli (2004, ssim_index.m with its recommended automatic downsampling):
//   1. luminance Y = 0.2989 R + 0.5870 G + 0.1140 B on the 8-bit encoded values (MATLAB rgb2gray);
//   2. downsample by f = max(1, round(min(H, W) / 256)): an f x f box filter with symmetric edges,
//      then every f-th pixel;
//   3. 11 x 11 Gaussian window, sigma 1.5, K1 0.01, K2 0.03, L 255, 'valid' region; mean SSIM.
// Both images must have the same size.
//
// Usage: node native/Tools/m3-parity/ssim.mjs A.png B.png      prints the score
//        import { ssim } from './ssim.mjs'                         ssim(pathA, pathB) -> number
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

async function luminance(path) {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const y = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    y[i] = 0.2989 * data[i * channels] + 0.587 * data[i * channels + 1] + 0.114 * data[i * channels + 2];
  }
  return { width, height, y };
}

function downsample({ width, height, y }, f) {
  if (f <= 1) return { width, height, y };
  // MATLAB 'symmetric' padding mirrors including the edge pixel; imfilter 'same' with an even
  // kernel centres it at floor((f + 1) / 2).
  const centre = Math.floor((f + 1) / 2) - 1;
  const mirror = (i, n) => {
    while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1;
    return i;
  };
  const w = Math.ceil(width / f);
  const h = Math.ceil(height / f);
  const out = new Float64Array(w * h);
  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      let sum = 0;
      for (let dy = 0; dy < f; dy++) {
        const sy = mirror(oy * f + dy - centre, height);
        for (let dx = 0; dx < f; dx++) sum += y[sy * width + mirror(ox * f + dx - centre, width)];
      }
      out[oy * w + ox] = sum / (f * f);
    }
  }
  return { width: w, height: h, y: out };
}

function gaussian(size, sigma) {
  const k = [];
  const half = (size - 1) / 2;
  let total = 0;
  for (let i = 0; i < size; i++) {
    const v = Math.exp(-((i - half) ** 2) / (2 * sigma * sigma));
    k.push(v);
    total += v;
  }
  return k.map((v) => v / total);
}

/** Separable 'valid' filtering with a symmetric 1-D kernel. */
function filterValid(src, width, height, k) {
  const n = k.length;
  const w = width - n + 1;
  const h = height - n + 1;
  const tmp = new Float64Array(w * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += k[i] * src[y * width + x + i];
      tmp[y * w + x] = s;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += k[i] * tmp[(y + i) * w + x];
      out[y * w + x] = s;
    }
  }
  return { out, w, h };
}

export function ssimOfLuminance(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const f = Math.max(1, Math.round(Math.min(a.width, a.height) / 256));
  const da = downsample(a, f);
  const db = downsample(b, f);
  const { width, height } = da;
  const k = gaussian(11, 1.5);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const product = (p, q) => p.map((v, i) => v * q[i]);
  const mu1 = filterValid(da.y, width, height, k);
  const mu2 = filterValid(db.y, width, height, k);
  const s11 = filterValid(product(da.y, da.y), width, height, k).out;
  const s22 = filterValid(product(db.y, db.y), width, height, k).out;
  const s12 = filterValid(product(da.y, db.y), width, height, k).out;
  let total = 0;
  const count = mu1.w * mu1.h;
  for (let i = 0; i < count; i++) {
    const m1 = mu1.out[i];
    const m2 = mu2.out[i];
    const v1 = s11[i] - m1 * m1;
    const v2 = s22[i] - m2 * m2;
    const c12 = s12[i] - m1 * m2;
    total += ((2 * m1 * m2 + C1) * (2 * c12 + C2)) / ((m1 * m1 + m2 * m2 + C1) * (v1 + v2 + C2));
  }
  return total / count;
}

export async function ssim(pathA, pathB) {
  return ssimOfLuminance(await luminance(pathA), await luminance(pathB));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error('usage: ssim.mjs A.png B.png');
    process.exit(2);
  }
  console.log((await ssim(a, b)).toFixed(4));
}
