// Finds the sun in an equirectangular Radiance .hdr and prints its direction in
// the convention three.js uses for equirect lookups (u = atan2(z, x) / 2pi + 0.5).
// Usage: node scripts/dev/map-harbor-sun.mjs [path/to/file.hdr]
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = process.argv[2] ?? join(root, 'public/assets/dl/hdri/venice_sunset_1k.hdr');

function decodeHdr(buffer) {
  let offset = 0;
  const readLine = () => {
    const end = buffer.indexOf(0x0a, offset);
    const line = buffer.toString('latin1', offset, end);
    offset = end + 1;
    return line;
  };
  let line = readLine();
  if (!line.startsWith('#?')) throw new Error('not a Radiance file');
  while (line !== '') line = readLine();
  const size = /-Y (\d+) \+X (\d+)/.exec(readLine());
  if (!size) throw new Error('unsupported orientation');
  const height = Number(size[1]);
  const width = Number(size[2]);
  const data = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    if (buffer[offset] !== 2 || buffer[offset + 1] !== 2) throw new Error('only RLE scanlines are supported');
    offset += 4;
    for (let channel = 0; channel < 4; channel++) {
      let x = 0;
      while (x < width) {
        let count = buffer[offset++];
        if (count > 128) {
          count -= 128;
          const value = buffer[offset++];
          for (let i = 0; i < count; i++) scan[(x++) * 4 + channel] = value;
        } else {
          for (let i = 0; i < count; i++) scan[(x++) * 4 + channel] = buffer[offset++];
        }
      }
    }
    for (let x = 0; x < width; x++) {
      const e = scan[x * 4 + 3];
      const scale = e === 0 ? 0 : Math.pow(2, e - 136);
      const index = (y * width + x) * 3;
      data[index] = scan[x * 4] * scale;
      data[index + 1] = scan[x * 4 + 1] * scale;
      data[index + 2] = scan[x * 4 + 2] * scale;
    }
  }
  return { width, height, data };
}

const { width, height, data } = decodeHdr(await readFile(file));
const luminance = new Float32Array(width * height);
let peak = 0;
for (let i = 0; i < width * height; i++) {
  luminance[i] = 0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2];
  if (luminance[i] > peak) peak = luminance[i];
}
// Luminance-weighted centroid of everything within 50% of the peak, on the unit sphere.
const centroid = [0, 0, 0];
const color = [0, 0, 0];
let weight = 0;
for (let y = 0; y < height; y++) {
  const elevation = (0.5 - (y + 0.5) / height) * Math.PI;
  for (let x = 0; x < width; x++) {
    const l = luminance[y * width + x];
    if (l < peak * 0.5) continue;
    const azimuth = ((x + 0.5) / width - 0.5) * Math.PI * 2;
    centroid[0] += Math.cos(elevation) * Math.cos(azimuth) * l;
    centroid[1] += Math.sin(elevation) * l;
    centroid[2] += Math.cos(elevation) * Math.sin(azimuth) * l;
    for (let c = 0; c < 3; c++) color[c] += data[(y * width + x) * 3 + c];
    weight += l;
  }
}
const length = Math.hypot(...centroid);
const dir = centroid.map((v) => v / length);
const elevationDeg = (Math.asin(dir[1]) * 180) / Math.PI;
const azimuthDeg = (Math.atan2(dir[2], dir[0]) * 180) / Math.PI;
const maxChannel = Math.max(...color);

// Average sky colour in a band just above the horizon, for the fog colour.
const horizon = [0, 0, 0];
let samples = 0;
for (let y = Math.floor(height * 0.44); y < Math.floor(height * 0.49); y++) {
  for (let x = 0; x < width; x++) {
    for (let c = 0; c < 3; c++) horizon[c] += Math.min(4, data[(y * width + x) * 3 + c]);
    samples++;
  }
}

process.stdout.write(
  [
    `file: ${file} (${width}x${height}), peak luminance ${peak.toFixed(1)}`,
    `sun direction (rotation 0): [${dir.map((v) => v.toFixed(4)).join(', ')}]`,
    `sun elevation ${elevationDeg.toFixed(2)} deg, azimuth atan2(z, x) ${azimuthDeg.toFixed(2)} deg`,
    `sun colour (normalised): [${color.map((v) => (v / maxChannel).toFixed(3)).join(', ')}]`,
    `horizon band mean (linear): [${horizon.map((v) => (v / samples).toFixed(3)).join(', ')}]`,
    '',
  ].join('\n'),
);
