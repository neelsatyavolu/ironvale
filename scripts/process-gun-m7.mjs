// Builds public/assets/local/guns/m7.glb from nothing: an original model of the M7 rifle.
// Usage: node scripts/process-gun-m7.mjs [--scale 0.25] [--skip-blender]
//
// The mesh, its UVs and its textures are made by a headless Blender run of
// scripts/blender/build-m7.py (geometry in m7_parts.py, baking in m7_bake.py).
// This script then packs Blender's output into the game's GLB: one node per
// moving part under a single root, three texture sets as WebP, and compact
// normals and texture coordinates.
//   --scale         shrinks the baked textures for a quick trial (1 is full size)
//   --skip-blender  repacks the last Blender output without running Blender again
// Needs Blender 4.2 or later; set BLENDER to its path if it is not /opt/homebrew/bin/blender.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, prune, quantize, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import { report } from './lib/guns-c-gltf.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public/assets/local/guns/m7.glb');
const build = join(root, '.cache/guns-c/m7/build');
const blender = process.env.BLENDER ?? '/opt/homebrew/bin/blender';
/** Blender is held to four threads: the bake is the one heavy step and this keeps a laptop cool. */
const THREADS = 4;
/** Pixels along each side of a texture set in the game file. */
const TEXTURE_SIZE = { m7_receiver: 2048, m7_furniture: 1024, m7_steel: 1024 };
const PARTS = ['body', 'magazine', 'bolt', 'chargingHandle', 'trigger'];

const args = process.argv.slice(2);
const scaleAt = args.indexOf('--scale');
if (!args.includes('--skip-blender')) {
  if (!existsSync(blender)) throw new Error(`Blender not found at ${blender}. Install it or set BLENDER to its path.`);
  const run = spawnSync(
    blender,
    ['-b', '-t', String(THREADS), '--factory-startup', '-P', join(root, 'scripts/blender/build-m7.py'), '--', build, ...(scaleAt >= 0 ? ['--scale', args[scaleAt + 1]] : [])],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const summary = run.stdout.split('\n').find((line) => line.startsWith('m7: '));
  if (run.status !== 0 || !summary) {
    process.stderr.write(`${run.stdout.split('\n').slice(-25).join('\n')}\n${run.stderr}\n`);
    throw new Error('The Blender build failed');
  }
  process.stdout.write(`${summary}\n`);
}

const io = new NodeIO().registerExtensions([EXTTextureWebP, KHRMeshQuantization]);
const doc = await io.read(join(build, 'm7-raw.glb'));
const scene = doc.getRoot().listScenes()[0];

// One root with the parts under it, each still at its pivot and unrotated.
const gun = doc.createNode('m7');
for (const name of PARTS) {
  const part = scene.listChildren().find((child) => child.getName() === name);
  if (!part) throw new Error(`Blender output has no part named "${name}"`);
  if (part.getRotation().some((value, index) => Math.abs(value - (index === 3 ? 1 : 0)) > 1e-6)) throw new Error(`Part "${name}" came out rotated`);
  scene.removeChild(part);
  gun.addChild(part);
}
if (scene.listChildren().length > 0) throw new Error(`Unexpected objects in the Blender output: ${scene.listChildren().map((child) => child.getName()).join(', ')}`);
scene.addChild(gun);

// The textures Blender baked, attached by texture set. Occlusion, roughness and metalness share one image.
for (const material of doc.getRoot().listMaterials()) {
  const set = material.getName();
  if (!(set in TEXTURE_SIZE)) throw new Error(`Unexpected material "${set}" in the Blender output`);
  const texture = async (suffix) =>
    doc.createTexture(`${set}_${suffix}`).setMimeType('image/png').setImage(await readFile(join(build, `${set}_${suffix}.png`)));
  const packed = await texture('orm');
  material
    .setBaseColorFactor([1, 1, 1, 1])
    .setBaseColorTexture(await texture('color'))
    .setNormalTexture(await texture('normal'))
    .setMetallicRoughnessTexture(packed)
    .setOcclusionTexture(packed)
    .setMetallicFactor(1)
    .setRoughnessFactor(1)
    .setDoubleSided(false);
}

await doc.transform(
  dedup(),
  prune(),
  ...Object.entries(TEXTURE_SIZE).flatMap(([set, size]) => [
    textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 86, resize: [size, size], pattern: new RegExp(`^${set}_(color|orm)$`) }),
    // Normal maps show compression as false relief, so they are kept at a higher quality.
    textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 92, resize: [size, size], pattern: new RegExp(`^${set}_normal$`) }),
  ]),
  // Positions stay as floats so the part nodes keep a plain translation and no scale.
  quantize({ pattern: /^(NORMAL|TEXCOORD_\d+)$/, quantizeNormal: 12, quantizeTexcoord: 14 }),
);
const unsized = doc.getRoot().listTextures().filter((texture) => texture.getMimeType() !== 'image/webp');
if (unsized.length > 0) throw new Error(`Textures left uncompressed: ${unsized.map((texture) => texture.getName() || '(unnamed)').join(', ')}`);
await mkdir(dirname(out), { recursive: true });
await io.write(out, doc);
await report(out, doc);
