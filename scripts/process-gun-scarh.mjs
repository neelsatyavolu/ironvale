// Builds public/assets/local/guns/scarh.glb from "FN SCAR-H" by Alex_Z (CC BY 4.0, Objaverse mirror).
// Usage: node scripts/process-gun-scarh.mjs
//
// The source is one baked low-poly gun in three meshes plus a sling swivel, with
// specular/glossiness textures. This script:
// - converts the textures to metal/roughness, which the game's finishes read;
// - removes the holographic sight and its mount, the rear flip-up sight and the
//   vertical foregrip (the game fits its own sight, and the left hand cups the handguard);
// - cuts out the magazine, the trigger and the left-side charging handle by
//   connected piece so they can move. On a SCAR the charging handle is fixed to
//   the bolt carrier and runs back with it on every shot, so it becomes the bolt part.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsIOR, KHRMaterialsSpecular } from '@gltf-transform/extensions';
import { dedup, metalRough, prune, textureCompress, weld } from '@gltf-transform/functions';
import sharp from 'sharp';
import { download } from './lib/guns-c-download.mjs';
import { bakePrimitives, multiply, partNode, pick, replaceScene, report, translation } from './lib/guns-c-gltf.mjs';
import { extractIslands } from './lib/guns-c-islands.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public/assets/local/guns/scarh.glb');
const SOURCE = 'https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-135/ba1c338e87fa45c99be0baef5aa8ccd7.glb';
/** Source units to metres: the top rail then comes out 21.2 mm wide, as a Picatinny rail is. */
const SCALE = 0.023;
/** Centre of the pistol grip in source units (barrel already along -Z, ejection port on +X); becomes the origin. */
const GRIP = [0, -3.3, 7.2];
/** The gun fills the view at arm's length; the sling swivel on the stock is a few centimetres across. */
const TEXTURE_SIZE = { scarh_main: 1024, scarh_swivel: 128 };

/**
 * Pieces sorted by the centre and bounds of each connected piece, in source units.
 * Every rule is checked against the triangle count it should find, so a changed download is noticed.
 */
const centre = (island, axis) => (island.min[axis] + island.max[axis]) / 2;
const RULES = {
  // Sight body, hood, glass, buttons and mount, and the flip-up rear sight just behind it.
  sight: { triangles: 3352, test: (island) => island.min[1] > 3.7 && centre(island, 2) > 1.9 && centre(island, 2) < 5.6 },
  foregrip: { triangles: 314, test: (island) => island.min[1] < -3 && centre(island, 2) > -8.2 && centre(island, 2) < -5.4 },
  // Body, floor plate and the four floor-plate screws.
  magazine: { triangles: 1152, test: (island) => island.max[1] < 1.3 && island.min[1] < -0.9 && centre(island, 2) > -1.4 && centre(island, 2) < 2.5 },
  trigger: { triangles: 188, test: (island) => Math.abs(centre(island, 2) - 3.99) < 0.05 && Math.abs(centre(island, 1) + 1.44) < 0.05 },
  // Knob, stem and face of the charging handle, forward on the left.
  bolt: { triangles: 272, test: (island) => island.min[0] < -1 && Math.abs(centre(island, 2) + 4.47) < 0.05 && Math.abs(centre(island, 1) - 3.01) < 0.05 },
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ sharp });
const doc = await io.read(await download(SOURCE, join(root, '.cache/guns-c/scarh/scarh-alexz.glb')));
await doc.transform(metalRough());

// metalRough() leaves specular and IOR settings the game's finish does not read.
for (const extension of [KHRMaterialsSpecular, KHRMaterialsIOR]) doc.createExtension(extension).dispose();

// Two texture sets: the gun, and the sling swivel on the stock. Named for the finish in src/weapons/models/scarh.gun.ts.
const materials = doc.getRoot().listMaterials();
const main = materials.find((material) => material.getName() === 'lowpolyinitialShadingGroup');
const swivel = materials.find((material) => material.getName() === 'detailinitialShadingGroup');
if (!main || !swivel) throw new Error('Source materials not found: the source model changed');
main.setName('scarh_main');
swivel.setName('scarh_swivel');
// Both sets were converted from one specular/glossiness map, so their roughness maps are the same: keep the gun's.
const swivelRoughness = swivel.getMetallicRoughnessTexture();
swivel.setMetallicRoughnessTexture(main.getMetallicRoughnessTexture());
// Disposed now: left for prune, dedup would merge the gun's copy into it, unnamed.
swivelRoughness?.dispose();
for (const material of [main, swivel]) {
  // Blended in the source only so the sight's glass shows through; that glass is removed below.
  material.setAlphaMode('OPAQUE');
  // The emissive map lights the sight's reticle, which is removed too.
  material.setEmissiveTexture(null).setEmissiveFactor([0, 0, 0]);
  // Textures carry their set's name so each set can be resized on its own below.
  const slots = { color: material.getBaseColorTexture(), orm: material.getMetallicRoughnessTexture(), normal: material.getNormalTexture(), ao: material.getOcclusionTexture() };
  for (const [slot, texture] of Object.entries(slots)) {
    if (!texture) throw new Error(`Material "${material.getName()}" has no ${slot} texture`);
    // A texture both sets share (roughness, occlusion) keeps the gun's name and size.
    if (!texture.getName()) texture.setName(`${material.getName()}_${slot}`);
  }
}

/**
 * Rectangles of the gun's colour texture (pixels, at its 1024 px source size) that hold the maker's
 * roll marks and a serial line. They are a few pixels tall and unreadable in play, but the game
 * carries no maker's marks, so each is blurred into the finish around it.
 */
const MARKINGS = [
  { left: 324, top: 218, width: 74, height: 19 },
  { left: 594, top: 176, width: 52, height: 13 },
];
const colour = main.getBaseColorTexture();
if (colour.getSize()?.join() !== '1024,1024') throw new Error(`Colour texture is ${colour.getSize()?.join('x')}, not 1024x1024: the source model changed`);
const patches = await Promise.all(
  MARKINGS.map(async (rect) => ({ input: await sharp(Buffer.from(colour.getImage())).extract(rect).blur(6).toBuffer(), left: rect.left, top: rect.top })),
);
colour.setImage(new Uint8Array(await sharp(Buffer.from(colour.getImage())).composite(patches).png().toBuffer())).setMimeType('image/png');

const toGun = multiply([SCALE, 0, 0, 0, 0, SCALE, 0, 0, 0, 0, SCALE, 0, 0, 0, 0, 1], translation(GRIP.map((v) => -v)));
const meshes = bakePrimitives(pick(doc, 'Object_2', 'Object_3', 'Object_4', 'Object_5'), toGun);
// Rules are written in source units: undo the transform for the test.
const inSource = (island) => ({ min: island.min.map((v, axis) => v / SCALE + GRIP[axis]), max: island.max.map((v, axis) => v / SCALE + GRIP[axis]) });

const parts = Object.fromEntries(Object.keys(RULES).map((name) => [name, []]));
for (const primitive of meshes) {
  for (const [name, { test }] of Object.entries(RULES)) {
    const piece = extractIslands(doc, primitive, (island) => test(inSource(island)));
    if (piece) parts[name].push(piece);
  }
}
for (const [name, { triangles }] of Object.entries(RULES)) {
  const found = parts[name].reduce((sum, primitive) => sum + primitive.getIndices().getCount() / 3, 0);
  if (found !== triangles) throw new Error(`Piece "${name}": expected ${triangles} triangles, found ${found}. The source model changed.`);
}

const gun = doc.createNode('scarh');
partNode(doc, gun, 'body', meshes.filter((primitive) => primitive.getIndices().getCount() > 0));
partNode(doc, gun, 'magazine', parts.magazine, [0, 0.03, -0.153]);
partNode(doc, gun, 'bolt', parts.bolt, [-0.0186, 0.145, -0.268]);
// Hinged at its pin, at the top of the blade.
partNode(doc, gun, 'trigger', parts.trigger, [0, 0.0587, -0.074]);
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
