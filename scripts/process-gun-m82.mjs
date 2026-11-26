// Builds public/assets/local/guns/m82.glb from "Barrett M82 .50 BMG sniper rifle." by aid2901
// (CC BY 4.0, Objaverse mirror).
// Usage: node scripts/process-gun-m82.mjs
//
// The source shows the rifle lying in an open carry case with loose cartridges, exported from
// Collada with sheared node transforms. This script:
// - keeps the rifle's three meshes (body with scope, bolt group, scope rings) and drops the case
//   and the cartridges;
// - bakes them into gun space: the rifle's long axis (found by principal axes of the body) along
//   -Z, the scope up, the centre of the pistol grip at the origin;
// - darkens the scope lenses, painted flat sky blue, to coated glass;
// - drops the occlusion maps, whose channel is all but black in this export and would darken
//   the whole gun;
// - cuts out the magazine, the trigger and the bolt carrier with its right-side charging handle
//   by connected piece, so they can move.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress, weld } from '@gltf-transform/functions';
import sharp from 'sharp';
import { download } from './lib/guns-c-download.mjs';
import { bakePrimitives, multiply, partNode, pick, replaceScene, report, translation } from './lib/guns-c-gltf.mjs';
import { extractIslands } from './lib/guns-c-islands.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public/assets/local/guns/m82.glb');
const SOURCE = 'https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-070/69d12bfd535248838e245afb66f94836.glb';

/** Source units to metres: the rifle then comes out 1.448 m long, as an M82A1 with its 29 in barrel is. */
const SCALE = 0.0827;
/** Middle of the rifle's body in source world space. */
const CENTRE = [-0.89, 3.035, 0.18];
/** The body's principal axes in source world space: the long axis (butt to muzzle) and the scope-up axis. */
const MUZZLEWARD = [-0.0041, 0.1015, -0.9948];
const UPWARD = [-0.6904, 0.7194, 0.0763];
/** Centre of the pistol grip in gun space before it is moved to the origin. */
const GRIP = [0, -0.108, 0.3945];
/** The gun fills the view at arm's length; the bolt group and the scope rings are small. */
const TEXTURE_SIZE = { m82_main: 1024, m82_bolt: 512, m82_rings: 256 };

const normalize = (v) => v.map((x) => x / Math.hypot(...v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const z = normalize(MUZZLEWARD.map((v) => -v));
const y = normalize(UPWARD.map((v, axis) => v - dot(UPWARD, z) * z[axis]));
const x = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]];
/** Column-major: rows are the gun axes, so a source direction is projected onto each. */
const rotation = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, 0, 0, 0, 1];
const scale = [SCALE, 0, 0, 0, 0, SCALE, 0, 0, 0, 0, SCALE, 0, 0, 0, 0, 1];
const toGun = multiply(translation(GRIP.map((v) => -v)), multiply(scale, multiply(rotation, translation(CENTRE.map((v) => -v)))));

/**
 * Pieces sorted by the centre and bounds of each connected piece, in gun space (metres).
 * Every rule is checked against the triangle count it should find, so a changed download is noticed.
 */
const centre = (island, axis) => (island.min[axis] + island.max[axis]) / 2;
const near = (island, axis, value) => Math.abs(centre(island, axis) - value) < 0.01;
const RULES = {
  magazine: { triangles: 252, test: (island) => island.min[1] < -0.05 && near(island, 2, -0.182) },
  // The blade only: the guard around it is centred in the same place but is 57 mm long.
  trigger: { triangles: 50, test: (island) => near(island, 2, -0.071) && near(island, 1, 0.031) && island.max[2] - island.min[2] < 0.02 },
  // The bolt carrier seen through the receiver, and the knurled charging handle behind it on the right.
  bolt: { triangles: 62 + 1312, test: (island) => (near(island, 2, -0.168) && near(island, 1, 0.104)) || (near(island, 2, -0.029) && island.min[0] > 0.005 && island.min[1] > 0.09) },
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ sharp });
const doc = await io.read(await download(SOURCE, join(root, '.cache/guns-c/m82/m82-aid2901.glb')));

// Three texture sets: the rifle and scope, the bolt group, and the scope rings. Named for the finish in src/weapons/models/m82.gun.ts.
const NAMES = { lambert1: 'm82_main', bolt: 'm82_bolt', material: 'm82_rings' };
for (const [from, to] of Object.entries(NAMES)) {
  const material = doc.getRoot().listMaterials().find((candidate) => candidate.getName() === from);
  if (!material) throw new Error(`Source material "${from}" not found: the source model changed`);
  material.setName(to).setOcclusionTexture(null);
  const slots = { color: material.getBaseColorTexture(), orm: material.getMetallicRoughnessTexture(), normal: material.getNormalTexture() };
  for (const [slot, texture] of Object.entries(slots)) {
    if (!texture) throw new Error(`Material "${from}" has no ${slot} texture`);
    texture.setName(`${to}_${slot}`);
  }
}

/**
 * The scope's lenses are painted a flat sky blue in the colour texture, which reads as a plastic
 * disc in the game's light. Blue-dominant pixels (the lenses are the only blue on the rifle) are
 * taken down to the near-black, faintly blue of coated glass.
 */
const LENS = { blueOverRed: 1.4, blueOverGreen: 1.15, minBlue: 60, keep: 0.16 };
const mainColour = doc.getRoot().listMaterials().find((material) => material.getName() === 'm82_main').getBaseColorTexture();
const { data, info } = await sharp(Buffer.from(mainColour.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
let lensPixels = 0;
for (let i = 0; i < data.length; i += 3) {
  const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
  if (b < LENS.minBlue || b < r * LENS.blueOverRed || b < g * LENS.blueOverGreen) continue;
  data[i] = Math.round(r * LENS.keep);
  data[i + 1] = Math.round(g * LENS.keep);
  data[i + 2] = Math.round(b * LENS.keep * 1.3);
  lensPixels++;
}
// A few percent of the sheet: much more would mean the rule caught the rifle's own finish.
if (lensPixels < 2000 || lensPixels > 0.06 * info.width * info.height) throw new Error(`Lens rule matched ${lensPixels} pixels: the source model changed`);
mainColour.setImage(new Uint8Array(await sharp(data, { raw: info }).png().toBuffer())).setMimeType('image/png');

const meshes = bakePrimitives(pick(doc, 'M82.001', 'M82', 'M82.002'), toGun);
const parts = Object.fromEntries(Object.keys(RULES).map((name) => [name, []]));
for (const primitive of meshes) {
  for (const [name, { test }] of Object.entries(RULES)) {
    const piece = extractIslands(doc, primitive, test);
    if (piece) parts[name].push(piece);
  }
}
for (const [name, { triangles }] of Object.entries(RULES)) {
  const found = parts[name].reduce((sum, primitive) => sum + primitive.getIndices().getCount() / 3, 0);
  if (found !== triangles) throw new Error(`Piece "${name}": expected ${triangles} triangles, found ${found}. The source model changed.`);
}

const gun = doc.createNode('m82');
partNode(doc, gun, 'body', meshes.filter((primitive) => primitive.getIndices().getCount() > 0));
partNode(doc, gun, 'magazine', parts.magazine, [0, 0.07, -0.182]);
partNode(doc, gun, 'bolt', parts.bolt, [0.02, 0.104, -0.12]);
// Hinged at its pin, at the top of the blade.
partNode(doc, gun, 'trigger', parts.trigger, [0, 0.047, -0.073]);
replaceScene(doc, gun);

await doc.transform(
  weld(),
  dedup(),
  prune(),
  ...Object.entries(TEXTURE_SIZE).map(([set, size]) =>
    textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 88, resize: [size, size], pattern: new RegExp(`^${set}_`) }),
  ),
);
const unsized = doc.getRoot().listTextures().filter((texture) => texture.getMimeType() !== 'image/webp');
if (unsized.length > 0) throw new Error(`Textures left uncompressed: ${unsized.map((texture) => texture.getName() || '(unnamed)').join(', ')}`);
await mkdir(dirname(out), { recursive: true });
await io.write(out, doc);
await report(out, doc);
