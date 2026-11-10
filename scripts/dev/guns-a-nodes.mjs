// Prints local TRS of nodes whose name matches a pattern. Usage: node scripts/dev/guns-a-nodes.mjs <file.glb> <regex>
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const [file, pattern] = process.argv.slice(2);
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(file);
const f = (n) => n.map((v) => v.toFixed(4)).join(',');
for (const node of doc.getRoot().listNodes()) {
  if (!new RegExp(pattern).test(node.getName())) continue;
  process.stdout.write(`${node.getName()} t=${f(node.getTranslation())} r=${f(node.getRotation())} s=${f(node.getScale())}\n`);
}
