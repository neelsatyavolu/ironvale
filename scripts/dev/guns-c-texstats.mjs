// Prints mean and spread of each material's base colour, roughness, metalness and occlusion in a GLB.
// Usage: node scripts/dev/guns-c-texstats.mjs file.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';

const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(process.argv[2]);
const stats = async (texture) => {
  if (!texture) return null;
  const { channels } = await sharp(texture.getImage()).stats();
  return channels.slice(0, 3).map((c) => `${(c.mean / 255).toFixed(2)}±${(c.stdev / 255).toFixed(2)}`).join(' ');
};
for (const m of doc.getRoot().listMaterials()) {
  process.stdout.write(
    `${m.getName()}: factors rough=${m.getRoughnessFactor()} metal=${m.getMetallicFactor()} | base rgb ${await stats(m.getBaseColorTexture())} | o/r/m ${await stats(m.getMetallicRoughnessTexture())} | sameAO=${m.getOcclusionTexture() === m.getMetallicRoughnessTexture()}\n`,
  );
}
