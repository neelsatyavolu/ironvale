// Finds the sun in the Pinewood HDRI: decodes the Radiance .hdr, reports the
// brightest direction (three.js equirect convention) and the mean horizon colour.
// Usage: node scripts/dev/map-pinewood-sun.mjs [path/to/file.hdr]
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = process.argv[2] ?? join(root, 'public/assets/dl/hdri/kloofendal_misty_morning_puresky_1k.hdr');
const data = await readFile(file);

// Header: text lines up to a blank line, then "-Y H +X W".
let offset = 0;
const readLine = () => {
  const end = data.indexOf(0x0a, offset);
  const line = data.toString('latin1', offset, end);
  offset = end + 1;
  return line;
};
while (readLine() !== '') {
  /* skip header lines */
}
const size = /-Y (\d+) \+X (\d+)/.exec(readLine());
if (!size) throw new Error('Unsupported .hdr orientation');
const height = Number(size[1]);
const width = Number(size[2]);

// Scanlines are run-length encoded per channel (new-style RLE).
const pixels = new Float32Array(width * height * 3);
const scan = new Uint8Array(width * 4);
for (let y = 0; y < height; y++) {
  if (data[offset] !== 2 || data[offset + 1] !== 2) throw new Error('Only RLE .hdr files are supported');
  offset += 4;
  for (let channel = 0; channel < 4; channel++) {
    let x = 0;
    while (x < width) {
      const count = data[offset++];
      if (count > 128) {
        scan.fill(data[offset++], channel * width + x, channel * width + x + count - 128);
        x += count - 128;
      } else {
        for (let i = 0; i < count; i++) scan[channel * width + x++] = data[offset++];
      }
    }
  }
  for (let x = 0; x < width; x++) {
    const scale = scan[3 * width + x] === 0 ? 0 : 2 ** (scan[3 * width + x] - 136);
    for (let c = 0; c < 3; c++) pixels[(y * width + x) * 3 + c] = scan[c * width + x] * scale;
  }
}

const luminance = (i) => 0.2126 * pixels[i * 3] + 0.7152 * pixels[i * 3 + 1] + 0.0722 * pixels[i * 3 + 2];
/** Direction for a pixel, matching three.js equirectangular sampling with flipY. */
const direction = (px, py) => {
  const azimuth = ((px + 0.5) / width - 0.5) * Math.PI * 2;
  const elevation = (0.5 - (py + 0.5) / height) * Math.PI;
  return [Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth)];
};

// The sun is the centroid of the brightest 0.05 % of the sky, weighted by luminance and solid angle.
const order = Array.from({ length: width * height }, (_, i) => i).sort((a, b) => luminance(b) - luminance(a));
const top = order.slice(0, Math.max(16, Math.round(width * height * 0.0005)));
const sun = [0, 0, 0];
for (const i of top) {
  const py = Math.floor(i / width);
  const dir = direction(i % width, py);
  const weight = luminance(i) * Math.cos((0.5 - (py + 0.5) / height) * Math.PI);
  for (let c = 0; c < 3; c++) sun[c] += dir[c] * weight;
}
const length = Math.hypot(...sun);
const unit = sun.map((value) => value / length);

// Mean colour of the band just above the horizon: what fog should fade to.
const horizon = [0, 0, 0];
let samples = 0;
for (let py = Math.floor(height * 0.44); py < Math.floor(height * 0.5); py++) {
  for (let px = 0; px < width; px++) {
    for (let c = 0; c < 3; c++) horizon[c] += pixels[(py * width + px) * 3 + c];
    samples++;
  }
}
const zenith = [0, 0, 0];
for (let px = 0; px < width; px++) for (let c = 0; c < 3; c++) zenith[c] += pixels[(Math.floor(height * 0.1) * width + px) * 3 + c] / width;

const fixed = (values) => values.map((value) => value.toFixed(3)).join(', ');
process.stdout.write(
  [
    `file: ${file} (${width} x ${height})`,
    `sun direction (hdriRotation 0): ${fixed(unit)}`,
    `sun elevation: ${((Math.asin(unit[1]) * 180) / Math.PI).toFixed(1)} deg, azimuth atan2(z, x): ${((Math.atan2(unit[2], unit[0]) * 180) / Math.PI).toFixed(1)} deg`,
    `peak luminance: ${luminance(order[0]).toFixed(1)}, median: ${luminance(order[order.length >> 1]).toFixed(3)}`,
    `horizon colour (linear): ${fixed(horizon.map((value) => value / samples))}`,
    `zenith colour (linear): ${fixed(zenith)}`,
    '',
  ].join('\n'),
);
