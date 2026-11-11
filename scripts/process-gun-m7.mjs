// Builds public/assets/local/guns/m7.glb from "Low-Poly Sig MCX" by TastyTony (CC BY 4.0, Objaverse mirror).
// Usage: node scripts/process-gun-m7.mjs
//
// No freely licensed MCX-SPEAR could be downloaded without an account, so the
// M7 is made from its parent design, a 5.56 mm SIG MCX, reshaped here:
// - the red dot, vertical foregrip, bottom rail section and flash hider are removed;
// - everything ahead of the receiver is shortened to 85 % and a suppressor is added;
// - the curved 30-round magazine is straightened and shortened into a 20-round box;
// - a folding charging handle and its track are added on the left of the upper receiver.
// The source is an untextured, rigidly skinned rig coloured by material. Its
// bones become the moving parts, and its materials are renamed by role for the
// finishes in src/weapons/models/lib/m7-materials.ts.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { dedup, prune, weld } from '@gltf-transform/functions';
import { download } from './lib/guns-c-download.mjs';
import { multiply, partNode, replaceScene, report, translation, yawScale } from './lib/guns-c-gltf.mjs';
import { extractIslands, findIslands } from './lib/guns-c-islands.mjs';
import { bakeSkinned, boxPrimitive, lathePrimitive, movePoints } from './lib/guns-c-skin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public/assets/local/guns/m7.glb');
const SOURCE = 'https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-114/9a6f000c43644afe900669b6e7202378.glb';
/** Source units to metres: the slots of the top rail then repeat every 10 mm, as on a real one. */
const SCALE = 0.204;
/** Centre of the pistol grip after the turn and scale; becomes the origin. */
const GRIP = [0, -0.24 * SCALE, 0.9325 * SCALE];
/** Front face of the receiver. Everything ahead of it is shortened by `FRONT_SCALE` along the barrel. */
const RECEIVER_FRONT = -GRIP[2];
const FRONT_SCALE = 0.85;
/** Bore axis (x, y) in gun space. */
const BORE = [0, 0.0973];
const TOLERANCE = 0.002;

/** Flat colours for viewers that show the file as it is; the game replaces every one by name. */
const MATERIALS = {
  m7_receiver: { color: [0.2, 0.15, 0.09], roughness: 0.55, metallic: 0.4 },
  m7_polymer: { color: [0.16, 0.12, 0.075], roughness: 0.75, metallic: 0 },
  m7_black: { color: [0.012, 0.012, 0.013], roughness: 0.7, metallic: 0 },
  m7_steel: { color: [0.03, 0.03, 0.032], roughness: 0.5, metallic: 1 },
  m7_bolt: { color: [0.2, 0.2, 0.21], roughness: 0.35, metallic: 1 },
  m7_magazine: { color: [0.014, 0.014, 0.015], roughness: 0.6, metallic: 0 },
  m7_brass: { color: [0.45, 0.3, 0.1], roughness: 0.35, metallic: 1 },
  m7_bullet: { color: [0.4, 0.16, 0.07], roughness: 0.35, metallic: 1 },
  m7_suppressor: { color: [0.15, 0.115, 0.075], roughness: 0.65, metallic: 0.5 },
};
/** Source material to role, for the pieces that are not split further below. */
const ROLE = {
  'Material.001': 'm7_receiver',
  'Material.000': 'm7_black',
  'Material.002': 'm7_steel',
  'Material.006': 'm7_steel',
  'Material.005': 'm7_steel',
  Material: 'm7_black',
  'Material.004': 'm7_magazine',
  'Material.007': 'm7_bolt',
  'Material.008': 'm7_brass',
  'Material.009': 'm7_brass',
  'Material.010': 'm7_bullet',
};
/** Bones whose geometry stays fixed to the body: the small controls and the open dust cover. */
const FIXED = ['body_11', 'dustcover_2', 'magrelease_3', 'boltrelease_4', 'bo selecta_5'];
const MAGAZINE = ['mag_8', 'bullet_6', 'bullets_7'];

/** Pieces identified by the centre of their bounds in gun space (before the front is shortened) and their triangle count. */
const PIECES = {
  trigger: { centre: [0, 0.0296, -0.0657], triangles: 36 },
  bottomRail: { centre: [0, 0.0674, -0.3193], triangles: 520 },
  flashHider: { centre: [0, 0.0972, -0.6333], triangles: 204 },
};

/**
 * The 20-round magazine. `mouth` is the height of the magazine well's lower
 * edge: the part of the magazine below it is shortened to `shorten` of its
 * length. `lean` is how far forward the box runs per metre of drop.
 */
const BOX_MAGAZINE = { mouth: 0.02, shorten: 0.74, lean: 0.07 };
/** Suppressor profile about the bore axis, rear to front, as [z, radius]. 205 mm long and 42 mm across. */
const SUPPRESSOR = [
  [-0.546, 0.011],
  [-0.546, 0.0165],
  [-0.563, 0.0165],
  [-0.565, 0.021],
  [-0.632, 0.021],
  [-0.633, 0.0202],
  [-0.636, 0.0202],
  [-0.637, 0.021],
  [-0.744, 0.021],
  [-0.751, 0.0175],
  [-0.751, 0.0048],
  [-0.731, 0.0048],
];
/** Left-side charging handle, folded back against the receiver, and the track it runs in. */
const SIDE_HANDLE = {
  track: { min: [-0.0192, 0.1085, -0.186], max: [-0.015, 0.1155, -0.1] },
  stem: { min: [-0.0225, 0.1065, -0.184], max: [-0.017, 0.1175, -0.172] },
  handle: { min: [-0.0285, 0.1045, -0.184], max: [-0.0215, 0.1195, -0.154] },
};

const io = new NodeIO();
const doc = await io.read(await download(SOURCE, join(root, '.cache/guns-c/m7/mcx-tastytony.glb')));

const material = Object.fromEntries(
  Object.entries(MATERIALS).map(([name, { color, roughness, metallic }]) => [
    name,
    // Double-sided like the source: the dust cover and the magazine's mouth are single sheets.
    doc.createMaterial(name).setBaseColorFactor([...color, 1]).setRoughnessFactor(roughness).setMetallicFactor(metallic).setDoubleSided(true),
  ]),
);

// Barrel along +X in the source with the ejection port on +Z: a quarter turn puts them on -Z and +X.
const toGun = multiply(translation(GRIP.map((v) => -v)), yawScale(90, SCALE));
const pieces = bakeSkinned(doc, toGun);
for (const piece of pieces) {
  if (!ROLE[piece.material]) throw new Error(`Source material "${piece.material}" is new: the source model changed`);
  piece.primitive.setMaterial(material[ROLE[piece.material]]);
}
const select = (joints, sourceMaterial) =>
  pieces.filter((piece) => joints.includes(piece.joint) && (sourceMaterial === undefined || piece.material === sourceMaterial)).map((piece) => piece.primitive);
const one = (joint, sourceMaterial) => {
  const found = select([joint], sourceMaterial);
  if (found.length !== 1) throw new Error(`Expected one "${sourceMaterial}" piece on bone "${joint}", found ${found.length}`);
  return found[0];
};

function cut(primitive, name) {
  const { centre, triangles } = PIECES[name];
  const piece = extractIslands(doc, primitive, (island) =>
    centre.every((value, axis) => Math.abs((island.min[axis] + island.max[axis]) / 2 - value) < TOLERANCE),
  );
  const found = piece ? piece.getIndices().getCount() / 3 : 0;
  if (found !== triangles) throw new Error(`Piece "${name}": expected ${triangles} triangles, found ${found}. The source model changed.`);
  return piece;
}

const trigger = cut(one('body_11', 'Material.000'), 'trigger');
cut(one('body_11', 'Material.001'), 'bottomRail');
cut(one('body_11', 'Material.006'), 'flashHider');
// The stock, its hinge and the pistol grip share the source's black with the controls: they are the
// pieces of it that lie behind the trigger guard.
const furniture = extractIslands(doc, one('body_11', 'Material.000'), (island) => island.min[2] > -0.045);
if (!furniture) throw new Error('Stock and pistol grip not found: the source model changed');
furniture.setMaterial(material.m7_polymer);

const body = [...select(FIXED), furniture];
for (const primitive of body) movePoints(primitive, ([x, y, z]) => [x, y, z < RECEIVER_FRONT ? RECEIVER_FRONT + (z - RECEIVER_FRONT) * FRONT_SCALE : z]);

/**
 * Centre line of the curved magazine: the middle, along the barrel, of level
 * sections cut through its shell every 4 mm. Returns it as a function of height.
 */
function centreLine(primitive) {
  const [shell] = findIslands(primitive).sort((first, second) => second.triangles.length - first.triangles.length);
  const position = primitive.getAttribute('POSITION');
  const indices = primitive.getIndices();
  const triangles = shell.triangles.map((triangle) => [0, 1, 2].map((k) => position.getElement(indices.getScalar(triangle * 3 + k), [])));
  const sections = [];
  for (let y = shell.min[1] + 0.003; y < shell.max[1] - 0.003; y += 0.004) {
    let min = Infinity;
    let max = -Infinity;
    for (const corners of triangles) {
      for (let k = 0; k < 3; k++) {
        const from = corners[k];
        const to = corners[(k + 1) % 3];
        if (from[1] > y === to[1] > y) continue;
        const z = from[2] + ((to[2] - from[2]) * (y - from[1])) / (to[1] - from[1]);
        min = Math.min(min, z);
        max = Math.max(max, z);
      }
    }
    sections.push({ y, depth: max - min, z: (min + max) / 2 });
  }
  // Leave out the feed lips and the bevel of the floor plate, where a section is not the whole box.
  const depth = Math.max(...sections.map((section) => section.depth));
  const line = sections.filter((section) => section.depth > depth * 0.85);
  if (line.length < 4) throw new Error('Magazine centre line not found: the source model changed');
  return (y) => {
    if (y <= line[0].y) return line[0].z;
    for (let i = 1; i < line.length; i++) {
      if (y <= line[i].y) return line[i - 1].z + ((line[i].z - line[i - 1].z) * (y - line[i - 1].y)) / (line[i].y - line[i - 1].y);
    }
    return line[line.length - 1].z;
  };
}

const magazine = select(MAGAZINE);
const curve = centreLine(one('mag_8', 'Material.004'));
for (const primitive of magazine) {
  movePoints(primitive, ([x, y, z]) => {
    const { mouth, shorten, lean } = BOX_MAGAZINE;
    const height = y < mouth ? mouth + (y - mouth) * shorten : y;
    return [x, height, z - curve(y) + curve(mouth) + (height - mouth) * lean];
  });
}

body.push(
  lathePrimitive(doc, material.m7_suppressor, BORE, SUPPRESSOR, 24),
  boxPrimitive(doc, material.m7_steel, SIDE_HANDLE.track.min, SIDE_HANDLE.track.max),
  boxPrimitive(doc, material.m7_black, SIDE_HANDLE.stem.min, SIDE_HANDLE.stem.max),
  boxPrimitive(doc, material.m7_black, SIDE_HANDLE.handle.min, SIDE_HANDLE.handle.max),
);

const gun = doc.createNode('m7');
partNode(doc, gun, 'body', body);
partNode(doc, gun, 'magazine', magazine, [0, 0.03, -0.147]);
partNode(doc, gun, 'bolt', select(['bolt_9']), [0, 0.1025, -0.1335]);
partNode(doc, gun, 'chargingHandle', select(['charginghandle_10']), [0, 0.1305, 0]);
// Hinged at its pin, at the top of the blade.
partNode(doc, gun, 'trigger', [trigger], [0, 0.0445, -0.066]);
replaceScene(doc, gun);

await doc.transform(weld(), dedup(), prune());
await mkdir(dirname(out), { recursive: true });
await io.write(out, doc);
await report(out, doc);
