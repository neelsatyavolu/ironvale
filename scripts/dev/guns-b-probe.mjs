// Prints vertices of one node of a processed gun GLB inside a box, as a coarse front-view (x/y)
// occupancy map plus per-column height, to locate sight apertures and blade tops.
// Usage: node scripts/dev/guns-b-probe.mjs <file> <node> minX,minY,minZ maxX,maxY,maxZ [cell]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const [file, name, minText, maxText, cellText] = process.argv.slice(2);
const min = minText.split(',').map(Number);
const max = maxText.split(',').map(Number);
const cell = Number(cellText ?? 0.0005);
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(file);
const node = doc.getRoot().listNodes().find((candidate) => candidate.getName() === name);
const world = node.getWorldTranslation();
const points = [];
for (const prim of node.getMesh().listPrimitives()) {
  const position = prim.getAttribute('POSITION');
  for (let i = 0; i < position.getCount(); i++) {
    const p = position.getElement(i, []).map((value, axis) => value + world[axis]);
    if (p.every((value, axis) => value >= min[axis] && value <= max[axis])) points.push(p);
  }
}
const cols = Math.ceil((max[0] - min[0]) / cell);
const rows = Math.ceil((max[1] - min[1]) / cell);
const grid = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(' '));
for (const p of points) grid[Math.floor((p[1] - min[1]) / cell)][Math.floor((p[0] - min[0]) / cell)] = '#';
console.log(`${points.length} vertices; x ${min[0]}..${max[0]} left to right, y ${max[1]} (top) .. ${min[1]}, cell ${cell}`);
grid.reverse().forEach((row, index) => console.log(`${(max[1] - index * cell).toFixed(4)} |${row.join('')}|`));
const bounds = [0, 1, 2].map((axis) => [Math.min(...points.map((p) => p[axis])), Math.max(...points.map((p) => p[axis]))]);
console.log('bounds', bounds.map((b) => b.map((v) => v.toFixed(4)).join('..')).join('  '));
