// Dumps a GLB's textures as files for inspection. Usage: node scripts/dev/guns-a-textures.mjs <file.glb> <outDir>
import { mkdir, writeFile } from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const [file, out] = process.argv.slice(2);
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(file);
await mkdir(out, { recursive: true });
for (const material of doc.getRoot().listMaterials()) {
  const slots = { base: material.getBaseColorTexture(), orm: material.getMetallicRoughnessTexture(), normal: material.getNormalTexture(), ao: material.getOcclusionTexture() };
  for (const [slot, texture] of Object.entries(slots)) {
    if (!texture) continue;
    const ext = texture.getMimeType().split('/')[1];
    const name = `${material.getName().replace(/\W+/g, '_')}-${slot}.${ext}`;
    await writeFile(`${out}/${name}`, texture.getImage());
    process.stdout.write(`${name} ${texture.getSize().join('x')} ${texture.getImage().length}\n`);
  }
}
