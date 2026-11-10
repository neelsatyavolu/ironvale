// Prints the bounds of the vertices of a processed gun GLB that fall inside a box, in gun space.
// Usage: node scripts/dev/guns-c-measure.mjs file.glb "label:x0,x1,y0,y1,z0,z1" ... (use _ for an open bound)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const [file, ...queries] = process.argv.slice(2);
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(file);
const points = [];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    for (let i = 0; i < position.getCount(); i++) {
      const p = position.getElement(i, []);
      points.push([m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], node.getName()]);
    }
  }
}
const f = (v) => v.map((x) => x.toFixed(4)).join(' ');
for (const query of queries) {
  const [label, box] = query.split(':');
  const b = box.split(',').map((t, i) => (t === '_' ? (i % 2 ? Infinity : -Infinity) : Number(t)));
  const inside = points.filter((p) => p[0] >= b[0] && p[0] <= b[1] && p[1] >= b[2] && p[1] <= b[3] && p[2] >= b[4] && p[2] <= b[5]);
  if (inside.length === 0) {
    process.stdout.write(`${label}: no vertices\n`);
    continue;
  }
  const min = [0, 1, 2].map((k) => Math.min(...inside.map((p) => p[k])));
  const max = [0, 1, 2].map((k) => Math.max(...inside.map((p) => p[k])));
  const mean = [0, 1, 2].map((k) => inside.reduce((sum, p) => sum + p[k], 0) / inside.length);
  process.stdout.write(`${label}: n=${inside.length} min=${f(min)} max=${f(max)} mean=${f(mean)} nodes=${[...new Set(inside.map((p) => p[3]))].join(',')}\n`);
}
