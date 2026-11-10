// Prints the structure of a GLB: nodes, skins, meshes, materials, textures, clips.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const r = doc.getRoot();
const out = (s) => process.stdout.write(s + '\n');
out('ext: ' + r.listExtensionsUsed().map((e) => e.extensionName).join(','));
const walk = (n, d) => {
  const t = n.getTranslation().map((v) => +v.toFixed(3));
  const q = n.getRotation().map((v) => +v.toFixed(3));
  const s = n.getScale().map((v) => +v.toFixed(3));
  out(`${'  '.repeat(d)}${n.getName()} t=${t} q=${q} s=${s}${n.getMesh() ? ' MESH' : ''}${n.getSkin() ? ' SKIN' : ''}`);
  for (const c of n.listChildren()) walk(c, d + 1);
};
if (process.argv.includes('--nodes')) for (const scene of r.listScenes()) for (const n of scene.listChildren()) walk(n, 0);
for (const skin of r.listSkins()) out(`skin ${skin.getName()} joints=${skin.listJoints().length} skeleton=${skin.getSkeleton()?.getName()}`);
for (const m of r.listMeshes()) {
  for (const p of m.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    out(`mesh ${m.getName()} prim verts=${pos.getCount()} tris=${(p.getIndices()?.getCount() ?? pos.getCount()) / 3} mat=${p.getMaterial()?.getName()} attrs=${p.listSemantics().join(',')} min=${pos.getMin([]).map((v) => v.toFixed(2))} max=${pos.getMax([]).map((v) => v.toFixed(2))}`);
    const uv = p.getAttribute('TEXCOORD_0');
    if (uv) out(`   uv min=${uv.getMin([]).map((v) => v.toFixed(3))} max=${uv.getMax([]).map((v) => v.toFixed(3))}`);
  }
}
for (const m of r.listMaterials()) {
  const exts = m.listExtensions().map((e) => e.extensionName);
  out(`mat ${m.getName()} base=${m.getBaseColorTexture()?.getName()} normal=${m.getNormalTexture()?.getName()} mr=${m.getMetallicRoughnessTexture()?.getName()} occ=${m.getOcclusionTexture()?.getName()} alpha=${m.getAlphaMode()} ds=${m.getDoubleSided()} factor=${m.getBaseColorFactor()} m=${m.getMetallicFactor()} r=${m.getRoughnessFactor()} ext=${exts}`);
}
for (const t of r.listTextures()) out(`tex ${t.getName()} ${t.getMimeType()} ${t.getSize()} ${t.getImage()?.byteLength}`);
for (const a of r.listAnimations()) {
  const ch = a.listChannels();
  let dur = 0;
  for (const s of a.listSamplers()) dur = Math.max(dur, s.getInput().getMax([])[0]);
  out(`clip ${a.getName()} channels=${ch.length} dur=${dur.toFixed(2)}`);
}
