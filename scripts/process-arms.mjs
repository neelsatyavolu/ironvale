// Builds public/assets/local/guns/arms.glb from "First Person arms" by DJMaesen (CC BY 4.0, Objaverse mirror).
// The skeleton and skin are kept as they are; only the textures are recompressed.
// Usage: node scripts/process-arms.mjs
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { EXTTextureWebP } from '@gltf-transform/extensions';
import { prune, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import { download } from './lib/guns-c-download.mjs';
import { report } from './lib/guns-c-gltf.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public/assets/local/guns/arms.glb');
const SOURCE = 'https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-013/e3c42c05b22944e5839deb8e003f0987.glb';

const io = new NodeIO().registerExtensions([EXTTextureWebP]);
const doc = await io.read(await download(SOURCE, join(root, '.cache/guns-c/arms/arms-bumstrum.glb')));
await doc.transform(prune({ keepLeaves: true }), textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 90, resize: [1024, 1024] }));
await mkdir(dirname(out), { recursive: true });
await io.write(out, doc);
await report(out, doc);
