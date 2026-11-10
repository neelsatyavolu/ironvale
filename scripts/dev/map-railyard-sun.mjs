// Finds the sun in the Railyard HDRI: decodes the Radiance .hdr and reports the
// brightest direction in three.js equirectangular convention, plus the average
// colour of the brightest patch. Usage: node scripts/dev/map-railyard-sun.mjs [path.hdr]
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = process.argv[2] ?? join(root, 'public/assets/dl/hdri/freight_station_1k.hdr');
const data = await readFile(file);

/** Reads the text header and returns the offset of the pixel data with the image size. */
function readHeader(buffer) {
  let offset = 0;
  const line = () => {
    const end = buffer.indexOf(0x0a, offset);
    const text = buffer.toString('latin1', offset, end);
    offset = end + 1;
    return text;
  };
  if (!line().startsWith('#?')) throw new Error('not a Radiance HDR file');
  for (let text = line(); text !== ''; text = line()) {
    if (text.startsWith('FORMAT=') && !text.includes('32-bit_rle_rgbe')) throw new Error(`unsupported ${text}`);
  }
  const size = /^-Y (\d+) \+X (\d+)$/.exec(line());
  if (!size) throw new Error('unsupported orientation');
  return { height: Number(size[1]), width: Number(size[2]), offset };
}

/** Decodes new-style run-length scanlines into a flat RGBE byte array. */
function decodeRgbe(buffer, width, height, start) {
  const out = new Uint8Array(width * height * 4);
  let p = start;
  for (let y = 0; y < height; y++) {
    if (buffer[p] !== 2 || buffer[p + 1] !== 2 || ((buffer[p + 2] << 8) | buffer[p + 3]) !== width) {
      throw new Error('scanline is not run-length encoded');
    }
    p += 4;
    for (let channel = 0; channel < 4; channel++) {
      let x = 0;
      while (x < width) {
        let count = buffer[p++];
        if (count > 128) {
          count -= 128;
          const value = buffer[p++];
          for (let i = 0; i < count; i++) out[(y * width + x++) * 4 + channel] = value;
        } else {
          for (let i = 0; i < count; i++) out[(y * width + x++) * 4 + channel] = buffer[p++];
        }
      }
    }
  }
  return out;
}

const { width, height, offset } = readHeader(data);
const rgbe = decodeRgbe(data, width, height, offset);
const pixel = (x, y) => {
  const i = (y * width + x) * 4;
  const scale = rgbe[i + 3] === 0 ? 0 : 2 ** (rgbe[i + 3] - 136);
  return [rgbe[i] * scale, rgbe[i + 1] * scale, rgbe[i + 2] * scale];
};
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Brightest pixel, then the luminance-weighted centroid of everything near it
// that is at least a quarter as bright (the sun disc and its core glow).
let best = { x: 0, y: 0, value: 0 };
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const value = luminance(pixel(x, y));
    if (value > best.value) best = { x, y, value };
  }
}
const radius = Math.round(width / 60);
let sumX = 0;
let sumY = 0;
let sumW = 0;
const colour = [0, 0, 0];
for (let dy = -radius; dy <= radius; dy++) {
  for (let dx = -radius; dx <= radius; dx++) {
    const x = (best.x + dx + width) % width;
    const y = Math.min(height - 1, Math.max(0, best.y + dy));
    const rgb = pixel(x, y);
    const w = luminance(rgb);
    if (w < best.value * 0.25) continue;
    sumX += (best.x + dx) * w;
    sumY += y * w;
    sumW += w;
    rgb.forEach((c, i) => (colour[i] += c * w));
  }
}
const cx = sumX / sumW;
const cy = sumY / sumW;

// three.js equirect lookup: u = atan2(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5, image row 0 is +Y.
const u = (cx + 0.5) / width;
const v = 1 - (cy + 0.5) / height;
const phi = (u - 0.5) * Math.PI * 2;
const lat = (v - 0.5) * Math.PI;
const direction = [Math.cos(lat) * Math.cos(phi), Math.sin(lat), Math.cos(lat) * Math.sin(phi)];
const peak = Math.max(...colour);

// Mean sky luminance of the upper hemisphere, for judging how strong the sun is against the sky.
let skySum = 0;
let skyWeight = 0;
for (let y = 0; y < height / 2; y += 2) {
  const w = Math.cos(((y + 0.5) / height - 0.5) * Math.PI);
  for (let x = 0; x < width; x += 2) {
    skySum += luminance(pixel(x, y)) * w;
    skyWeight += w;
  }
}

const fixed = (n) => Number(n.toFixed(4));
process.stdout.write(
  `${JSON.stringify(
    {
      file,
      size: [width, height],
      brightestPixel: best,
      centroid: [fixed(cx), fixed(cy)],
      azimuthDeg: fixed((phi * 180) / Math.PI),
      elevationDeg: fixed((lat * 180) / Math.PI),
      directionInTexture: direction.map(fixed),
      sunColour: colour.map((c) => fixed(c / peak)),
      meanSkyLuminance: fixed(skySum / skyWeight),
    },
    null,
    2,
  )}\n`,
);
