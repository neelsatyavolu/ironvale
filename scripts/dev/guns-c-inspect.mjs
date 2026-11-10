// Prints the node tree, triangle counts, bounds and materials of a GLB. Usage: node scripts/dev/guns-c-inspect.mjs file.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
const f = (v) => v.map((n) => n.toFixed(3)).join(',');
const tris = (mesh) =>
  mesh.listPrimitives().reduce((sum, p) => sum + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0);
let total = 0;
const walk = (node, depth) => {
  const mesh = node.getMesh();
  const b = getBounds(node);
  const n = mesh ? tris(mesh) : 0;
  total += n;
  const mats = mesh ? mesh.listPrimitives().map((p) => p.getMaterial()?.getName()).join('|') : '';
  if (depth <= Number(process.argv[3] ?? 9))
    console.log(`${'  '.repeat(depth)}${node.getName()} ${mesh ? `tris=${n} mat=${mats}` : ''}${node.getSkin() ? ' SKIN' : ''} min=${f(b.min)} max=${f(b.max)}`);
  for (const child of node.listChildren()) walk(child, depth + 1);
};
for (const scene of root.listScenes()) {
  const b = getBounds(scene);
  console.log(`scene ${scene.getName()} min=${f(b.min)} max=${f(b.max)}`);
  for (const child of scene.listChildren()) walk(child, 1);
}
console.log('total tris', total, 'extensions', root.listExtensionsUsed().map((e) => e.extensionName));
for (const m of root.listMaterials())
  console.log('material', m.getName(), 'base', f(m.getBaseColorFactor()), 'metal', m.getMetallicFactor(), 'rough', m.getRoughnessFactor(), 'alpha', m.getAlphaMode(), 'ds', m.getDoubleSided(), 'tex', ['BaseColor', 'MetallicRoughness', 'Normal', 'Occlusion', 'Emissive'].map((k) => (m[`get${k}Texture`]() ? k : '')).filter(Boolean).join('+'));
for (const t of root.listTextures()) console.log('texture', t.getName(), t.getMimeType(), t.getSize()?.join('x'), t.getImage()?.byteLength);
for (const s of root.listSkins()) console.log('skin', s.getName(), s.listJoints().length, 'joints');
for (const a of root.listAnimations()) console.log('anim', a.getName());
