// Lists the connected pieces of a gun's body inside a box, and the heights of its vertices near the centreline,
// to tell a front sight post from the hood or ears around it.
// Usage: node scripts/dev/guns-c-frontsight.mjs file.glb z0 z1 yMin
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { findIslands } from '../lib/guns-c-islands.mjs';

const [file, z0Text, z1Text, yMinText] = process.argv.slice(2);
const [z0, z1, yMin] = [Number(z0Text), Number(z1Text), Number(yMinText)];
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(file);
const body = doc.getRoot().listNodes().find((node) => node.getName() === 'body');
const f = (v) => v.map((x) => x.toFixed(4)).join(' ');
const centre = new Set();
for (const primitive of body.getMesh().listPrimitives()) {
  for (const island of findIslands(primitive)) {
    if (island.max[2] < z0 || island.min[2] > z1 || island.max[1] < yMin) continue;
    process.stdout.write(`piece tris=${island.triangles.length} min=${f(island.min)} max=${f(island.max)}\n`);
  }
  const position = primitive.getAttribute('POSITION');
  for (let i = 0; i < position.getCount(); i++) {
    const p = position.getElement(i, []);
    if (Math.abs(p[0]) < 0.0015 && p[2] >= z0 && p[2] <= z1 && p[1] >= yMin) centre.add(p[1].toFixed(4));
  }
}
process.stdout.write(`heights of vertices within 1.5 mm of the centreline: ${[...centre].sort().join(' ')}\n`);
