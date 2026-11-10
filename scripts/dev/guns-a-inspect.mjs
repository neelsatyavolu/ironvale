// Prints the structure of a GLB: nodes with world bounds, triangle counts, materials, textures.
// Usage: node scripts/dev/guns-a-inspect.mjs <file.glb>
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
const f = (n) => n.map((v) => v.toFixed(3)).join(',');
process.stdout.write(`extensions: ${root.listExtensionsUsed().map((e) => e.extensionName).join(' ') || 'none'}\n`);
let total = 0;
const walk = (node, depth) => {
  const mesh = node.getMesh();
  let tris = 0;
  const mats = new Set();
  if (mesh) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      tris += (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
      mats.add(prim.getMaterial()?.getName() ?? '-');
    }
  }
  total += tris;
  const b = getBounds(node);
  const bounds = Number.isFinite(b.min[0]) ? ` [${f(b.min)}]..[${f(b.max)}]` : '';
  const skin = node.getSkin() ? ' SKIN' : '';
  process.stdout.write(`${'  '.repeat(depth)}${node.getName() || '(unnamed)'}${mesh ? ` tris=${tris} mat=${[...mats].join('|')}` : ''}${skin}${bounds}\n`);
  for (const child of node.listChildren()) walk(child, depth + 1);
};
for (const scene of root.listScenes()) for (const node of scene.listChildren()) walk(node, 0);
process.stdout.write(`total tris: ${total}\n`);
for (const m of root.listMaterials()) {
  const tex = (t) => (t ? `${t.getName() || t.getURI() || 'tex'}(${t.getSize()?.join('x')},${t.getMimeType()})` : '-');
  process.stdout.write(
    `material ${m.getName()}: base=${f(m.getBaseColorFactor())} ${tex(m.getBaseColorTexture())} mr=${m.getMetallicFactor()}/${m.getRoughnessFactor()} ${tex(m.getMetallicRoughnessTexture())} normal=${tex(m.getNormalTexture())} ao=${tex(m.getOcclusionTexture())} alpha=${m.getAlphaMode()} ds=${m.getDoubleSided()} ext=${m.listExtensions().map((e) => e.extensionName).join(' ')}\n`,
  );
}
process.stdout.write(`animations: ${root.listAnimations().map((a) => a.getName()).join(', ') || 'none'}\n`);
