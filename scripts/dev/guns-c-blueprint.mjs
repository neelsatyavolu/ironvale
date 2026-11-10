// Draws an orthographic wireframe of a GLB with a centimetre grid, to read off coordinates.
// Usage: node scripts/dev/guns-c-blueprint.mjs in.glb out.png <axes: zy|zx|xy> [scale px/m] [minA,maxA,minB,maxB] [nodeFilterRegex]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';

const [file, out, axes = 'zy', scaleText = '2000', boundsText, filter] = process.argv.slice(2);
const scale = Number(scaleText);
const ai = 'xyz'.indexOf(axes[0]);
const bi = 'xyz'.indexOf(axes[1]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(file);
const palette = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9a6324', '#ffe119', '#800000', '#aaffc3', '#808000'];
const lines = [];
const legend = [];
let min = [Infinity, Infinity];
let max = [-Infinity, -Infinity];
const apply = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
let colorIndex = 0;
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh || (filter && !new RegExp(filter).test(node.getName()))) continue;
  const color = palette[colorIndex++ % palette.length];
  legend.push([node.getName(), color]);
  const matrix = node.getWorldMatrix();
  for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    const indices = primitive.getIndices();
    const count = indices ? indices.getCount() : position.getCount();
    const points = [];
    for (let i = 0; i < position.getCount(); i++) {
      const p = apply(matrix, position.getElement(i, []));
      points.push([p[ai], p[bi]]);
      min = [Math.min(min[0], p[ai]), Math.min(min[1], p[bi])];
      max = [Math.max(max[0], p[ai]), Math.max(max[1], p[bi])];
    }
    for (let i = 0; i < count; i += 3) {
      const tri = [0, 1, 2].map((k) => points[indices ? indices.getScalar(i + k) : i + k]);
      lines.push([color, tri]);
    }
  }
}
if (boundsText) {
  const b = boundsText.split(',').map(Number);
  min = [b[0], b[2]];
  max = [b[1], b[3]];
} else {
  min = min.map((v) => Math.floor(v * 100 - 1) / 100);
  max = max.map((v) => Math.ceil(v * 100 + 1) / 100);
}
const W = Math.round((max[0] - min[0]) * scale);
const H = Math.round((max[1] - min[1]) * scale);
const X = (a) => ((a - min[0]) * scale).toFixed(1);
const Y = (b) => ((max[1] - b) * scale).toFixed(1);
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#111"/>`;
for (let a = Math.ceil(min[0] * 100); a <= max[0] * 100; a++) {
  const major = a % 5 === 0;
  svg += `<line x1="${X(a / 100)}" x2="${X(a / 100)}" y1="0" y2="${H}" stroke="${a === 0 ? '#fff' : major ? '#666' : '#2c2c2c'}" stroke-width="1"/>`;
  if (major) svg += `<text x="${X(a / 100)}" y="12" fill="#ccc" font-size="11" font-family="monospace">${a}</text>`;
}
for (let b = Math.ceil(min[1] * 100); b <= max[1] * 100; b++) {
  const major = b % 5 === 0;
  svg += `<line y1="${Y(b / 100)}" y2="${Y(b / 100)}" x1="0" x2="${W}" stroke="${b === 0 ? '#fff' : major ? '#666' : '#2c2c2c'}" stroke-width="1"/>`;
  if (major) svg += `<text y="${Y(b / 100)}" x="2" fill="#ccc" font-size="11" font-family="monospace">${b}</text>`;
}
for (const [color, tri] of lines)
  svg += `<path d="M${X(tri[0][0])} ${Y(tri[0][1])}L${X(tri[1][0])} ${Y(tri[1][1])}L${X(tri[2][0])} ${Y(tri[2][1])}Z" fill="none" stroke="${color}" stroke-width="0.6" stroke-opacity="0.75"/>`;
legend.forEach(([name, color], i) => (svg += `<text x="${W - 150}" y="${H - 8 - i * 12}" fill="${color}" font-size="11" font-family="monospace">${name}</text>`));
svg += '</svg>';
await sharp(Buffer.from(svg)).png().toFile(out);
process.stdout.write(`${out} ${W}x${H} axes ${axes} (cm grid) a:[${min[0]},${max[0]}] b:[${min[1]},${max[1]}]\n`);
