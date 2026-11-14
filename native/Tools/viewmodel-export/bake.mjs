#!/usr/bin/env node
// View-model bake (PLAN.md 3.5, M9 view-model lane): turns the gun-export GLBs (native/MapPackages/guns,
// from map-export) and the first-person arms (public/assets/local/guns/arms.glb) into IVM models with
// PNG textures under native/BakedAssets/viewmodel (git-ignored).
//   node native/Tools/viewmodel-export/bake.mjs [--out DIR]
//
// The guns-c finishes (src/weapons/models/lib/guns-c-materials.ts tunedFinish) read the source
// model's base colour and packed roughness/metalness textures through TSL nodes, which GLTFExporter
// cannot write, so the gun-export GLB has only their normal and occlusion maps. The bake copies those
// two textures from the source GLB (the material named in Contract/viewmodel.json finishes.tuned) onto
// the exported material's base colour and metallic-roughness slots; ViewModel.metal applies the tweak.
// A sidecar materials.json keeps what IVM does not carry (unlit, clearcoat, side).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { encodeIVM } from '../asset-bake/ivm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? resolve(args[outIndex + 1]) : resolve(repoRoot, 'native/BakedAssets/viewmodel');
const constants = JSON.parse(readFileSync(resolve(repoRoot, 'native/Contract/viewmodel.json'), 'utf8'));
const GUNS = Object.keys(constants.weapons);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** Copies `texture` (from another document) into `doc`, once per source texture. */
function adopt(doc, texture, cache) {
  if (!texture) return null;
  if (cache.has(texture)) return cache.get(texture);
  const copy = doc.createTexture(texture.getName()).setImage(texture.getImage()).setMimeType(texture.getMimeType());
  cache.set(texture, copy);
  return copy;
}

async function bakeGun(id) {
  const path = resolve(repoRoot, `native/MapPackages/guns/${id}.glb`);
  const doc = await io.read(path);
  const tuned = constants.finishes.tuned[id] ?? {};
  if (Object.keys(tuned).length > 0) {
    const source = await io.read(resolve(repoRoot, `public/assets/local/guns/${id}.glb`));
    const cache = new Map();
    for (const material of doc.getRoot().listMaterials()) {
      const finish = tuned[material.getName()];
      if (!finish) continue;
      const original = source.getRoot().listMaterials().find((m) => m.getName() === finish.source);
      if (!original) throw new Error(`${id}: source material ${finish.source} is missing`);
      material.setBaseColorTexture(adopt(doc, original.getBaseColorTexture(), cache));
      material.setMetallicRoughnessTexture(adopt(doc, original.getMetallicRoughnessTexture(), cache));
    }
  }
  return bake(id, doc, readFileSync(path));
}

async function bake(id, doc, sourceBytes) {
  const root = doc.getRoot();
  const files = new Map();
  for (const [i, texture] of root.listTextures().entries()) {
    const image = texture.getImage();
    if (!image) throw new Error(`${id}: texture ${i} has no image`);
    const png = await sharp(Buffer.from(image)).png({ compressionLevel: 6 }).toBuffer();
    const meta = await sharp(png).metadata();
    const uri = `${id}_t${i}.png`;
    writeFileSync(resolve(outDir, uri), png);
    const srgb = root.listMaterials().some((m) => m.getBaseColorTexture() === texture || m.getEmissiveTexture() === texture);
    files.set(texture, { uri, colorSpace: srgb ? 'srgb' : 'linear', width: meta.width, height: meta.height });
  }
  const ivm = encodeIVM(doc, files);
  writeFileSync(resolve(outDir, `${id}.ivm`), ivm);
  const materials = root.listMaterials().map((m) => {
    const ext = (name) => m.listExtensions().find((e) => e.extensionName === name);
    const clearcoat = ext('KHR_materials_clearcoat');
    return {
      name: m.getName(),
      unlit: Boolean(ext('KHR_materials_unlit')),
      clearcoat: clearcoat ? clearcoat.getClearcoatFactor() : 0,
      clearcoatRoughness: clearcoat ? clearcoat.getClearcoatRoughnessFactor() : 0,
    };
  });
  return {
    id,
    sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    ivmSha256: createHash('sha256').update(ivm).digest('hex'),
    textures: [...files.values()].map((f) => f.uri),
    materials,
  };
}

mkdirSync(outDir, { recursive: true });
const baked = [];
for (const id of GUNS) baked.push(await bakeGun(id));
const armsPath = resolve(repoRoot, 'public/assets/local/guns/arms.glb');
baked.push(await bake('arms', await io.read(armsPath), readFileSync(armsPath)));
writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify({ models: baked }, null, 2)}\n`);
for (const b of baked) console.log(`${b.id}: ${b.ivmSha256.slice(0, 16)} (${b.textures.length} textures, ${b.materials.length} materials)`);
