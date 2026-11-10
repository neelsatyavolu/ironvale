// Prints the bounds and mean of the vertices of matching nodes inside a box, to locate features.
// Usage: node scripts/dev/guns-c-probe.mjs in.glb <nodeRegex> [minX,maxX,minY,maxY,minZ,maxZ] ...
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const [file, ...queries] = process.argv.slice(2);
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(file);
const f = (v) => v.map((n) => (n * 100).toFixed(2)).join(', ');
for (let q = 0; q < queries.length; q += 2) {
  const pattern = new RegExp(queries[q]);
  const box = (queries[q + 1] ?? '').split(',').map((t) => (t === '' || t === undefined ? NaN : Number(t)));
  const lo = [0, 2, 4].map((i) => (Number.isFinite(box[i]) ? box[i] : -Infinity));
  const hi = [1, 3, 5].map((i) => (Number.isFinite(box[i]) ? box[i] : Infinity));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const sum = [0, 0, 0];
  let count = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || !pattern.test(node.getName())) continue;
    const m = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      for (let i = 0; i < position.getCount(); i++) {
        const p = position.getElement(i, []);
        const w = [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
        if (w.some((v, a) => v < lo[a] || v > hi[a])) continue;
        count++;
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], w[a]);
          max[a] = Math.max(max[a], w[a]);
          sum[a] += w[a];
        }
      }
    }
  }
  console.log(`${queries[q]} [${queries[q + 1] ?? ''}] n=${count} min(cm)=${f(min)} max=${f(max)} mean=${f(sum.map((s) => s / count))}`);
}
