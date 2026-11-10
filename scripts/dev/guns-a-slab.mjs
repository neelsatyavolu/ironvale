// Prints the bounds of one part's vertices inside a box, to measure features such as a muzzle ring.
// Usage: node scripts/dev/guns-a-slab.mjs <id> <part> <minX,minY,minZ,maxX,maxY,maxZ in metres>
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const [id, part, boxText] = process.argv.slice(2);
const box = boxText.split(',').map(Number);
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(`public/assets/local/guns/${id}.glb`);
const points = [];
for (const node of doc.getRoot().listNodes()) {
  if (!node.getMesh() || (part !== '*' && node.getName() !== part)) continue;
  const t = node.getTranslation();
  for (const prim of node.getMesh().listPrimitives()) {
    const position = prim.getAttribute('POSITION');
    const e = [];
    for (let i = 0; i < position.getCount(); i++) {
      position.getElement(i, e);
      const p = [e[0] + t[0], e[1] + t[1], e[2] + t[2]];
      if (p.every((value, axis) => value >= box[axis] && value <= box[axis + 3])) points.push(p);
    }
  }
}
const range = (axis) => [Math.min(...points.map((p) => p[axis])), Math.max(...points.map((p) => p[axis]))];
process.stdout.write(`${points.length} vertices\n`);
for (const axis of [0, 1, 2]) {
  const [low, high] = range(axis);
  process.stdout.write(`${'xyz'[axis]} ${(low * 1000).toFixed(2)} .. ${(high * 1000).toFixed(2)} mm, centre ${(((low + high) / 2) * 1000).toFixed(2)}\n`);
}
