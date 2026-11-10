// Prints the node tree, triangle counts, materials and world bounds of a glTF/GLB.
// Usage: node scripts/dev/guns-b-inspect.mjs <file>
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const r = doc.getRoot();
const f = (v) => v.map((x) => x.toFixed(3)).join(',');
console.log('extensions', r.listExtensionsUsed().map((e) => e.extensionName).join(' ') || 'none');
console.log('animations', r.listAnimations().length, 'skins', r.listSkins().length);
for (const m of r.listMaterials()) {
  const tex = (t) => (t ? `${t.getName() || t.getURI() || 'tex'}[${t.getSize()?.join('x')} ${t.getMimeType()}]` : '-');
  console.log(`material "${m.getName()}" base=${f(m.getBaseColorFactor())} metal=${m.getMetallicFactor()} rough=${m.getRoughnessFactor()} alpha=${m.getAlphaMode()} ds=${m.getDoubleSided()}`,
    'color', tex(m.getBaseColorTexture()), 'mr', tex(m.getMetallicRoughnessTexture()), 'n', tex(m.getNormalTexture()), 'ao', tex(m.getOcclusionTexture()), 'em', tex(m.getEmissiveTexture()),
    'ext', m.listExtensions().map((e) => e.extensionName).join(' '));
}
let total = 0;
const walk = (node, depth) => {
  const mesh = node.getMesh();
  let line = `${'  '.repeat(depth)}${node.getName() || '(unnamed)'} t=${f(node.getTranslation())} r=${f(node.getRotation())} s=${f(node.getScale())}`;
  if (mesh) {
    for (const p of mesh.listPrimitives()) {
      const tris = (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
      total += tris;
      const b = getBounds(node);
      line += ` | tris=${tris} mat="${p.getMaterial()?.getName()}" attrs=${p.listSemantics().join('/')} min=${f(b.min)} max=${f(b.max)}`;
    }
  }
  console.log(line);
  for (const c of node.listChildren()) walk(c, depth + 1);
};
for (const scene of r.listScenes()) {
  const b = getBounds(scene);
  console.log(`scene "${scene.getName()}" min=${f(b.min)} max=${f(b.max)}`);
  for (const n of scene.listChildren()) walk(n, 1);
}
console.log('total tris', total);
