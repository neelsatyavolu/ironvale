// Prints a side-view (z across, y down) occupancy map of selected mesh nodes of a glTF/GLB after an
// optional canonical transform, to find grips, ports and part boundaries.
// Usage: node scripts/dev/guns-b-profile.mjs <file> [--scale s] [--yaw deg] [--node substring] [--mat name]
//        [--z from,to] [--y from,to] [--x from,to] [--cell metres] [--axes zy|zx|xy]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { bakeScene, canonicalMatrix } from '../lib/guns-b-mesh.mjs';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const range = (name) => (arg(name, '') ? arg(name).split(',').map(Number) : [-Infinity, Infinity]);
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(process.argv[2]);
for (const node of doc.getRoot().listNodes()) {
  if (node.getMesh() && node.getParentNode() && /^(defaultMaterial|Object_\d+)$/.test(node.getName())) node.setName(node.getParentNode().getName());
}
bakeScene(doc, canonicalMatrix({ scale: Number(arg('scale', '1')), yaw: (Number(arg('yaw', '0')) * Math.PI) / 180 }));
const limits = [range('x'), range('y'), range('z')];
const axes = arg('axes', 'zy');
const [across, down] = [...axes].map((letter) => 'xyz'.indexOf(letter));
const cell = Number(arg('cell', '0.005'));
const points = [];
for (const node of doc.getRoot().listNodes()) {
  if (!node.getMesh() || !node.getName().includes(arg('node', ''))) continue;
  for (const prim of node.getMesh().listPrimitives()) {
    if (arg('mat', '') && prim.getMaterial()?.getName() !== arg('mat')) continue;
    const position = prim.getAttribute('POSITION');
    const indices = prim.getIndices();
    const count = indices ? indices.getCount() : position.getCount();
    const corner = [[], [], []];
    for (let i = 0; i < count; i += 3) {
      for (let k = 0; k < 3; k++) position.getElement(indices ? indices.getScalar(i + k) : i + k, corner[k]);
      // Sample the triangle so thin, large faces still show up.
      for (let u = 0; u <= 1; u += 0.125) for (let v = 0; v <= 1 - u; v += 0.125) {
        const point = [0, 1, 2].map((c) => corner[0][c] + (corner[1][c] - corner[0][c]) * u + (corner[2][c] - corner[0][c]) * v);
        if (point.every((value, c) => value >= limits[c][0] && value <= limits[c][1])) points.push(point);
      }
    }
  }
}
if (!points.length) throw new Error('No geometry matched');
const min = [0, 1, 2].map((c) => points.reduce((low, p) => Math.min(low, p[c]), Infinity));
const max = [0, 1, 2].map((c) => points.reduce((high, p) => Math.max(high, p[c]), -Infinity));
process.stdout.write(`bounds min=${min.map((v) => v.toFixed(4))} max=${max.map((v) => v.toFixed(4))}\n`);
const columns = Math.ceil((max[across] - min[across]) / cell) + 1;
const rows = Math.ceil((max[down] - min[down]) / cell) + 1;
const grid = Array.from({ length: rows }, () => new Array(columns).fill(' '));
for (const p of points) grid[Math.round((max[down] - p[down]) / cell)][Math.round((p[across] - min[across]) / cell)] = '#';
grid.forEach((row, index) => process.stdout.write(`${(max[down] - index * cell).toFixed(3).padStart(7)} |${row.join('')}\n`));
process.stdout.write(`${axes[0]} from ${min[across].toFixed(3)} to ${max[across].toFixed(3)}, ${cell} per column\n`);
