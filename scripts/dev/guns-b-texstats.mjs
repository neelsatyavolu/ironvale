// Roughness and base-colour statistics of a gun GLB's materials, split by metal and non-metal texels.
// Usage: node scripts/dev/guns-b-texstats.mjs <file.glb>
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';

const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(process.argv[2]);
const raw = (texture) => sharp(texture.getImage()).resize(256, 256).removeAlpha().raw().toBuffer();
const percentiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => (sorted[Math.floor(q * (sorted.length - 1))] / 255).toFixed(2)).join(' ');
};
for (const material of doc.getRoot().listMaterials()) {
  const orm = material.getMetallicRoughnessTexture();
  if (!orm) continue;
  const [o, c] = await Promise.all([raw(orm), raw(material.getBaseColorTexture())]);
  for (const [label, test] of [['metal', (m) => m > 128], ['non-metal', (m) => m <= 128]]) {
    const rough = [];
    const luma = [];
    const ao = [];
    for (let i = 0; i < o.length; i += 3) {
      if (!test(o[i + 2])) continue;
      rough.push(o[i + 1]);
      ao.push(o[i]);
      luma.push(0.2126 * c[i] + 0.7152 * c[i + 1] + 0.0722 * c[i + 2]);
    }
    if (rough.length === 0) continue;
    console.log(`${material.getName()} ${label} (${((rough.length / (o.length / 3)) * 100).toFixed(0)}%): rough p5..p95 ${percentiles(rough)} | colour luma ${percentiles(luma)} | ao ${percentiles(ao)}`);
  }
}
