// Prints where each object of the R700 source lands in the processed frame, and profiles of the scope, barrel and stock.
// Usage: node scripts/dev/m24-measure.mjs   (needs scripts/fetch-guns-b.mjs to have run)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { bakeScene, canonicalMatrix, endRingCentre } from '../lib/guns-b-mesh.mjs';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read('.cache/guns-b/r700-domevans/source.glb');
for (const node of doc.getRoot().listNodes()) {
  if (!node.getMesh()) continue;
  node.setName(`${node.getParentNode().getName()}:${node.getMesh().listPrimitives()[0].getMaterial().getName()}`);
}
bakeScene(doc, canonicalMatrix({ scale: 1.092 / 2, yaw: Math.PI / 2 }));
const barrel = doc.getRoot().listNodes().find((node) => node.getName() === 'Barrel_LP:Metal');
const crown = endRingCentre(barrel.getMesh().listPrimitives()[0], 2, -1);
bakeScene(doc, canonicalMatrix({ translate: [-crown[0], 0.057 - crown[1], -0.781 - crown[2]] }));

const points = (node) => {
  const position = node.getMesh().listPrimitives()[0].getAttribute('POSITION');
  return Array.from({ length: position.getCount() }, (_, i) => position.getElement(i, [0, 0, 0]));
};
const f = (v) => v.toFixed(4);
for (const node of doc.getRoot().listNodes()) {
  if (!node.getMesh()) continue;
  const p = points(node);
  const box = [0, 1, 2].map((a) => [Math.min(...p.map((v) => v[a])), Math.max(...p.map((v) => v[a]))]);
  process.stdout.write(`${node.getName().padEnd(26)} x ${box[0].map(f)}  y ${box[1].map(f)}  z ${box[2].map(f)}\n`);
}
const profile = (name, axisY, step, radius) => {
  const p = points(doc.getRoot().listNodes().find((node) => node.getName() === name));
  const bins = new Map();
  for (const [x, y, z] of p) {
    const key = Math.round(z / step) * step;
    const entry = bins.get(key) ?? { r: 0, top: -9, bottom: 9, half: 0 };
    entry.r = Math.max(entry.r, Math.hypot(x, y - axisY));
    entry.top = Math.max(entry.top, y);
    entry.bottom = Math.min(entry.bottom, y);
    entry.half = Math.max(entry.half, Math.abs(x));
    bins.set(key, entry);
  }
  process.stdout.write(`${name}\n`);
  for (const [z, e] of [...bins].sort((a, b) => a[0] - b[0])) {
    process.stdout.write(radius ? `  z ${f(z)} r ${f(e.r)}\n` : `  z ${f(z)} top ${f(e.top)} bottom ${f(e.bottom)} half ${f(e.half)}\n`);
  }
};
const arg = process.argv[2] ?? '';
if (arg.includes('scope')) profile('Scope_LP:Metal', Number(process.argv[3] ?? 0.105), 0.01, true);
if (arg.includes('barrel')) profile('Barrel_LP:Metal', 0.057, 0.04, true);
if (arg.includes('stock')) profile('Body_LP:Paint', 0, 0.03, false);
