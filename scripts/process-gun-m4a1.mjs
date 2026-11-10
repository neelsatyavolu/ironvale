// Builds public/assets/local/guns/m4a1.glb from "M4A1 Carbine" by MrM0lten (CC BY 4.0, Objaverse mirror).
// Usage: node scripts/process-gun-m4a1.mjs
//
// The source is five meshes: Body (one mesh for the receivers, barrel, quad rail
// and every small part), Stock, Magazine, Scope (the detachable carry handle)
// and a loose cartridge. The carry handle and cartridge are dropped (the game
// fits an optic on the flat-top rail), and the trigger, charging handle and
// bolt carrier are cut out of Body by connected piece so they can move. The
// charging handle is only a head in the source, so the bar it slides on is added.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress, weld } from '@gltf-transform/functions';
import sharp from 'sharp';
import { download } from './lib/guns-c-download.mjs';
import { bakePrimitives, multiply, partNode, pick, replaceScene, report, translation, yawScale } from './lib/guns-c-gltf.mjs';
import { extractIslands } from './lib/guns-c-islands.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public/assets/local/guns/m4a1.glb');
const SOURCE = 'https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-084/9bb8f18ad94d4b468e447a2d43bd08b9.glb';
/** Source units to metres: the quad rail comes out 54 mm wide and the gun 0.84 m long, stock out. */
const SCALE = 0.251;
/** Centre of the pistol grip after the turn and scale; becomes the origin. */
const GRIP = [4.1845, -0.04, 4.189];
/** The receiver set fills the view at arm's length; the stock is behind the eye and the magazine is small. */
const TEXTURE_SIZE = { m4a1_metal: 1024, m4a1_stock: 512, m4a1_magazine: 512 };

/** Pieces of the Body mesh, by the centre of their bounds in gun space and their triangle count. */
const PIECES = {
  trigger: { centre: [0, 0.0455, -0.0633], triangles: 154 },
  chargingHandle: { centre: [0, 0.1186, 0.0003], triangles: 228 },
  bolt: { centre: [0.011, 0.0977, -0.1238], triangles: 332 },
  // Slots of the carry handle's two thumb nuts, left behind on the receiver.
  nutFront: { centre: [-0.0187, 0.1242, -0.1632], triangles: 36 },
  nutRear: { centre: [-0.0187, 0.1242, -0.0505], triangles: 36 },
};
const TOLERANCE = 0.002;

const io = new NodeIO().registerExtensions([EXTTextureWebP]);
const doc = await io.read(await download(SOURCE, join(root, '.cache/guns-c/m4a1/m4a1-mrm0lten.glb')));

// Barrel along +X in the source: a quarter turn puts it on -Z with the ejection port on +X.
const toGun = multiply(translation(GRIP.map((v) => -v)), yawScale(90, SCALE));
const [body] = bakePrimitives(pick(doc, 'Body'), toGun);

function cut(name) {
  const { centre, triangles } = PIECES[name];
  const piece = extractIslands(doc, body, (island) =>
    centre.every((value, axis) => Math.abs((island.min[axis] + island.max[axis]) / 2 - value) < TOLERANCE),
  );
  const found = piece ? piece.getIndices().getCount() / 3 : 0;
  if (found !== triangles) throw new Error(`Piece "${name}": expected ${triangles} triangles, found ${found}. The source model changed.`);
  return piece;
}

// Name the three texture sets for the finishes in src/weapons/models/m4a1.gun.ts.
for (const [from, to] of [['Body1', 'm4a1_metal'], ['lambert4', 'm4a1_stock'], ['material', 'm4a1_magazine']]) {
  const material = doc.getRoot().listMaterials().find((candidate) => candidate.getName() === from);
  if (!material) throw new Error(`Source material "${from}" not found`);
  material.setName(to);
  // Textures carry their set's name so each set can be resized on its own below.
  const slots = { color: material.getBaseColorTexture(), orm: material.getMetallicRoughnessTexture(), normal: material.getNormalTexture() };
  for (const [slot, texture] of Object.entries(slots)) {
    if (!texture) throw new Error(`Source material "${from}" has no ${slot} texture`);
    texture.setName(`${to}_${slot}`);
  }
}

const trigger = cut('trigger');
const chargingHandle = cut('chargingHandle');
const bolt = cut('bolt');
cut('nutFront');
cut('nutRear');

/**
 * The source models only the head of the charging handle, so pulled back it would hang in the air
 * behind the receiver. This is the bar it rides on, in gun space: it lies inside the neck under the
 * rail (11 mm wide, solid from y 0.1151 up to the groove floors at 0.1214) and below the lip at the
 * rail's rear end (0.1194), so it is hidden at rest and bridges the gap when the handle is drawn.
 */
const HANDLE_BAR = { min: [-0.0045, 0.1158, -0.16], max: [0.0045, 0.119, -0.01] };

/** A box that matches `like` (material and vertex attributes), textured from a flat patch of `like`'s own UVs. */
function barPrimitive(like, { min, max }) {
  const expected = ['NORMAL', 'POSITION', 'TANGENT', 'TEXCOORD_0'];
  if (like.listSemantics().sort().join() !== expected.join()) throw new Error(`Charging handle attributes changed: ${like.listSemantics().join(', ')}`);
  // Borrow the middle of the largest triangle in UV space: the flat side of the handle's head.
  const uv = like.getAttribute('TEXCOORD_0');
  const indices = like.getIndices();
  let patch = { inradius: 0, centre: [0, 0] };
  for (let i = 0; i < indices.getCount(); i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => uv.getElement(indices.getScalar(i + k), []));
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
    const inradius = area / (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1]) + Math.hypot(a[0] - c[0], a[1] - c[1]));
    if (inradius > patch.inradius) patch = { inradius, centre: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3] };
  }
  // A real, small square of texture (not one texel): normal mapping needs UVs that vary across a face.
  const half = 2.5 / 1024;
  if (patch.inradius < half * Math.SQRT2) throw new Error('No flat patch of texture on the charging handle to borrow for its bar');

  const positions = [];
  const normals = [];
  const tangents = [];
  const uvs = [];
  const corners = [];
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    for (const side of [-1, 1]) {
      const first = positions.length / 3;
      for (const [s, t] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const point = [0, 0, 0];
        point[axis] = side < 0 ? min[axis] : max[axis];
        point[u] = s ? max[u] : min[u];
        point[v] = t ? max[v] : min[v];
        positions.push(...point);
        normals.push(...[0, 1, 2].map((k) => (k === axis ? side : 0)));
        tangents.push(...[0, 1, 2].map((k) => (k === u ? 1 : 0)), side);
        uvs.push(patch.centre[0] + (s * 2 - 1) * half, patch.centre[1] + (t * 2 - 1) * half);
      }
      // Counter-clockwise seen from outside.
      corners.push(...(side > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]).map((k) => first + k));
    }
  }
  const buffer = doc.getRoot().listBuffers()[0];
  const accessor = (type, values, Type = Float32Array) => doc.createAccessor().setType(type).setArray(new Type(values)).setBuffer(buffer);
  return doc
    .createPrimitive()
    .setMaterial(like.getMaterial())
    .setAttribute('POSITION', accessor('VEC3', positions))
    .setAttribute('NORMAL', accessor('VEC3', normals))
    .setAttribute('TANGENT', accessor('VEC4', tangents))
    .setAttribute('TEXCOORD_0', accessor('VEC2', uvs))
    .setIndices(accessor('SCALAR', corners, Uint32Array));
}

const gun = doc.createNode('m4a1');
partNode(doc, gun, 'body', [body, ...bakePrimitives(pick(doc, 'Stock'), toGun)]);
partNode(doc, gun, 'magazine', bakePrimitives(pick(doc, 'Magazine'), toGun), [0, 0.03, -0.105]);
partNode(doc, gun, 'bolt', [bolt], [0.011, 0.0977, -0.124]);
partNode(doc, gun, 'chargingHandle', [chargingHandle, barPrimitive(chargingHandle, HANDLE_BAR)], [0, 0.1186, 0]);
// Hinged at its pin, just inside the lower receiver.
partNode(doc, gun, 'trigger', [trigger], [0, 0.066, -0.062]);
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
