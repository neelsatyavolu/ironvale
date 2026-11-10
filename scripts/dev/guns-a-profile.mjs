// Prints a histogram along Z of one part's vertices inside a box, to find edges such as an ejection port.
// Usage: node scripts/dev/guns-a-profile.mjs <id> <part> <minX,minY,minZ,maxX,maxY,maxZ in metres> [binMm]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const [id, part, boxText, binText] = process.argv.slice(2);
const box = boxText.split(',').map(Number);
const bin = Number(binText ?? 2);
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(`public/assets/local/guns/${id}.glb`);
const bins = new Map();
for (const node of doc.getRoot().listNodes()) {
  if (!node.getMesh() || (part !== '*' && node.getName() !== part)) continue;
  const t = node.getTranslation();
  for (const prim of node.getMesh().listPrimitives()) {
    const position = prim.getAttribute('POSITION');
    const e = [];
    for (let i = 0; i < position.getCount(); i++) {
      position.getElement(i, e);
      const p = [e[0] + t[0], e[1] + t[1], e[2] + t[2]];
      if (!p.every((value, axis) => value >= box[axis] && value <= box[axis + 3])) continue;
      const key = Math.round((p[2] * 1000) / bin) * bin;
      const entry = bins.get(key) ?? { count: 0, minY: Infinity, maxY: -Infinity, minX: Infinity, maxX: -Infinity };
      entry.count++;
      entry.minY = Math.min(entry.minY, p[1]);
      entry.maxY = Math.max(entry.maxY, p[1]);
      entry.minX = Math.min(entry.minX, p[0]);
      entry.maxX = Math.max(entry.maxX, p[0]);
      bins.set(key, entry);
    }
  }
}
const mm = (value) => (value * 1000).toFixed(1);
for (const [z, e] of [...bins].sort((a, b) => a[0] - b[0])) {
  process.stdout.write(`z ${String(z).padStart(5)}  n=${String(e.count).padStart(4)}  x ${mm(e.minX)}..${mm(e.maxX)}  y ${mm(e.minY)}..${mm(e.maxY)}\n`);
}
