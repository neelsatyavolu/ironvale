// Prints the bounds and anchor positions of the processed mp5 file (metres, gun space).
// Usage: node scripts/dev/guns-a-anchors.mjs
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const fixed = (values) => values.map((value) => value.toFixed(4)).join(', ');
for (const id of ['mp5']) {
  const doc = await io.read(`public/assets/local/guns/${id}.glb`);
  const scene = doc.getRoot().listScenes()[0];
  const bounds = getBounds(scene);
  process.stdout.write(`${id}: min ${fixed(bounds.min)}  max ${fixed(bounds.max)}  length ${(bounds.max[2] - bounds.min[2]).toFixed(4)}\n`);
  for (const node of scene.listChildren()) {
    if (!node.getMesh()) process.stdout.write(`  ${node.getName().padEnd(20)} ${fixed(node.getTranslation())}\n`);
  }
}
