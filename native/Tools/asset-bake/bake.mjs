#!/usr/bin/env node
// asset-bake (PLAN.md 3.5): converts the third-person soldier and carbine glTF binaries into IVM
// models with PNG textures for the native client, under native/BakedAssets/characters (git-ignored).
//   node native/Tools/asset-bake/bake.mjs [--out DIR]
// WebP textures are decoded at bake time (sharp). The output is deterministic for a given input.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { encodeIVM } from './ivm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? resolve(args[outIndex + 1]) : resolve(repoRoot, 'native/BakedAssets/characters');

const MODELS = [
  { id: 'soldier', source: 'public/assets/local/characters/soldier.glb' },
  { id: 'carbine', source: 'public/assets/local/characters/carbine.glb' },
];

/** Colour textures are sRGB; normal and packed occlusion/roughness/metalness maps are linear. */
function colorSpaceOf(material, texture) {
  return material.some((m) => m.getBaseColorTexture() === texture || m.getEmissiveTexture() === texture) ? 'srgb' : 'linear';
}

async function bake(model, io) {
  const bytes = readFileSync(resolve(repoRoot, model.source));
  const doc = await io.readBinary(new Uint8Array(bytes));
  const root = doc.getRoot();
  const files = new Map();
  for (const [i, texture] of root.listTextures().entries()) {
    const image = texture.getImage();
    if (!image) throw new Error(`${model.id}: texture ${i} has no image`);
    const png = await sharp(Buffer.from(image)).png({ compressionLevel: 6 }).toBuffer();
    const meta = await sharp(png).metadata();
    const uri = `${model.id}_${texture.getName() || `texture${i}`}.png`;
    writeFileSync(resolve(outDir, uri), png);
    files.set(texture, { uri, colorSpace: colorSpaceOf(root.listMaterials(), texture), width: meta.width, height: meta.height });
  }
  const ivm = encodeIVM(doc, files);
  writeFileSync(resolve(outDir, `${model.id}.ivm`), ivm);
  return {
    id: model.id,
    source: model.source,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    ivmSha256: createHash('sha256').update(ivm).digest('hex'),
    textures: [...files.values()].map((f) => f.uri),
  };
}

mkdirSync(outDir, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const baked = [];
for (const model of MODELS) baked.push(await bake(model, io));
writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify({ models: baked }, null, 2)}\n`);
for (const b of baked) console.log(`${b.id}: ${b.ivmSha256.slice(0, 16)} (${b.textures.length} textures)`);
