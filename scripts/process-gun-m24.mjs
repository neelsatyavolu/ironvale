// Builds public/assets/local/guns/m24.glb from "R700V2" by Domevans (CC BY 4.0,
// https://sketchfab.com/3d-models/r700v2-d748f463852144c7a982b3e170e7d000), a Remington 700 in the
// M24 configuration: heavy barrel, olive stock and rail. Run scripts/fetch-guns-b.mjs first.
//
// Output frame: metres, barrel along -Z, up +Y, bore on x = 0, origin at the wrist of the stock.
// Nodes: body (barrel, receiver, rail, stock, butt pad, trigger guard), bolt (> bolt_body,
// bolt_handle), trigger, lens_ocular, lens_objective. Moving parts have their origin on their own
// axis or pin. The source's scope tube, dials and rings are dropped; only its two lens discs stay, to
// fix the optical axis. The scope, rings, bipod and magazine are built in code
// (src/weapons/models/lib/m24-*.ts and guns-b-magazine.ts).
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld } from '@gltf-transform/functions';
import {
  bakeScene,
  canonicalMatrix,
  countTriangles,
  endRingCentre,
  extractPart,
  findIslands,
  groupAt,
  mergeNodes,
  setPivot,
  stretchWidth,
  trianglesWhere,
} from './lib/guns-b-mesh.mjs';
import { encodeWebp, liftRoughness, rawPixels } from './lib/guns-b-texture.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '.cache/guns-b/r700-domevans/source.glb');
const target = join(root, 'public/assets/local/guns/m24.glb');

/** The source is 2 units long; an M24 is 43 in (1.092 m) overall. */
const SCALE = 1.092 / 2;
/** Where the wrist of the stock sits relative to the muzzle crown, after scaling: back along the bore, and below it. */
const WRIST_FROM_MUZZLE = { back: 0.781, below: 0.057 };
/** In the output frame. */
/** Level with the bolt knob: the game sends the firing hand to the bolt's origin. */
const BOLT_AXIS_Z = -0.051;
const TRIGGER_PIN = [0, 0.011, -0.053];
/** Trigger blade inside the guard loop (the two are one welded island in the source). */
const TRIGGER_BOX = { halfWidth: 0.0032, y: [-0.01, 0.0085], z: [-0.0595, -0.0465] };
/**
 * The source stock is 22 mm wide at the tip of the fore-end and 33 mm at the action, barely wider than the barrel; an
 * M24 stock is 40 to 50 mm. At each station along the bore (z, output frame) everything outside the inletting
 * (|x| above `inner`) is pushed out so the source half-width `from` lands on `to`. Linear between stations.
 */
const STOCK_WIDTH = [
  { z: -0.5, inner: 0.009, from: 0.0111, to: 0.0195 },
  { z: -0.4, inner: 0.0093, from: 0.0124, to: 0.021 },
  { z: -0.3, inner: 0.0099, from: 0.014, to: 0.022 },
  { z: -0.2, inner: 0.0106, from: 0.0151, to: 0.022 },
  { z: -0.15, inner: 0.0108, from: 0.0159, to: 0.0215 },
  { z: -0.1, inner: 0.0127, from: 0.0163, to: 0.021 },
  { z: -0.05, inner: 0.0146, from: 0.0163, to: 0.0205 },
  { z: 0.03, inner: 0.004, from: 0.0163, to: 0.02 },
  { z: 0.1, inner: 0.004, from: 0.0167, to: 0.0205 },
  { z: 0.2, inner: 0.004, from: 0.0177, to: 0.0225 },
  { z: 0.32, inner: 0.004, from: 0.0177, to: 0.0225 },
];
/** The rail is 12.5 mm wide in the source; a Picatinny rail is 21 mm. */
const RAIL_WIDTH_SCALE = 1.68;
/** Source objects replaced by the scope built in code. */
const DROPPED = /^(Scope_LP:Metal|Dial\d+_LP|Center_LP|Mount\d+_LP|Screw\d+_LP|Finger_Screw\d+_LP)/;
/** The guard and trigger are 8 and 5 mm wide in the source. */
const GUARD_WIDTH_SCALE = 1.6;
/** Stock paint: the source is a pale sage; the M24 stock is a dark olive drab. */
const STOCK = { gain: [0.5, 0.53, 0.42], chipGain: 0.6, roughnessFloor: 0.5 };
const METAL_ROUGHNESS_FLOOR = 0.32;
/** Linear base colours for the parts whose source colour map is a single flat value. */
const FLAT = {
  Metal: { color: [0.021, 0.021, 0.023], metal: 1, roughness: 1 },
  Rubber: { color: [0.01, 0.01, 0.01], metal: 0, roughness: 0.8 },
  Silver: { color: [0.11, 0.115, 0.12], metal: 1, roughness: 0.4 },
  Glass: { color: [0.02, 0.03, 0.04], metal: 0, roughness: 0.05 },
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(source);
const scene = doc.getRoot().listScenes()[0];

// Every source mesh node is an anonymous child of a named object: name it "<object>:<material>".
for (const node of doc.getRoot().listNodes()) {
  if (!node.getMesh()) continue;
  node.setName(`${node.getParentNode().getName()}:${node.getMesh().listPrimitives()[0].getMaterial().getName()}`);
}
const named = (name) => {
  const found = doc.getRoot().listNodes().filter((node) => node.getName() === name);
  if (found.length !== 1) throw new Error(`expected one "${name}" node, found ${found.length}`);
  return found[0];
};
const prim = (node) => node.getMesh().listPrimitives()[0];
for (const node of doc.getRoot().listNodes()) {
  if (DROPPED.test(node.getName())) node.dispose();
}

// Scale and turn the barrel from +X to -Z, then slide the muzzle crown to its place so the bore is on x = 0.
bakeScene(doc, canonicalMatrix({ scale: SCALE, yaw: Math.PI / 2 }));
const crown = endRingCentre(prim(named('Barrel_LP:Metal')), 2, -1);
const shift = [-crown[0], WRIST_FROM_MUZZLE.below - crown[1], -WRIST_FROM_MUZZLE.back - crown[2]];
bakeScene(doc, canonicalMatrix({ translate: shift }));
process.stdout.write(`muzzle crown at ${endRingCentre(prim(named('Barrel_LP:Metal')), 2, -1).map((v) => v.toFixed(4))}\n`);

// Widen the stock (and its butt pad) outside the inletting.
const station = (z) => {
  const found = STOCK_WIDTH.findIndex((entry) => entry.z >= z);
  const next = found < 0 ? STOCK_WIDTH.length - 1 : Math.max(1, found);
  const [a, b] = [STOCK_WIDTH[next - 1], STOCK_WIDTH[next]];
  const t = Math.min(1, Math.max(0, (z - a.z) / (b.z - a.z)));
  const mix = (key) => a[key] + (b[key] - a[key]) * t;
  const inner = mix('inner');
  return { inner, slope: (mix('to') - inner) / (mix('from') - inner) };
};
for (const name of ['Body_LP:Paint', 'Body_LP:Rubber']) {
  stretchWidth(
    prim(named(name)),
    (x, z) => {
      const { inner, slope } = station(z);
      return x <= inner ? x : inner + (x - inner) * slope;
    },
    (x, z) => (x <= station(z).inner ? 1 : station(z).slope),
  );
}

stretchWidth(prim(named('Rail_LP:Metal')), (x) => x * RAIL_WIDTH_SCALE, () => RAIL_WIDTH_SCALE);

// Trigger blade out of the guard.
const guard = named('Trigger_LP:Paint');
stretchWidth(prim(guard), (x) => x * GUARD_WIDTH_SCALE, () => GUARD_WIDTH_SCALE);
const blade = trianglesWhere(
  prim(guard),
  ([x, y, z]) =>
    Math.abs(x) < TRIGGER_BOX.halfWidth * GUARD_WIDTH_SCALE && y > TRIGGER_BOX.y[0] && y < TRIGGER_BOX.y[1] && z > TRIGGER_BOX.z[0] && z < TRIGGER_BOX.z[1],
);
const trigger = extractPart(doc, guard, prim(guard), blade, 'trigger').node;
setPivot(trigger, TRIGGER_PIN);
process.stdout.write(`trigger blade: ${blade.length} triangles\n`);

// Scope glass: one disc at each end of the tube. The game swaps in a coated-lens material by node name.
const glassNode = named('Scope_LP:Glass');
const centre = (island) => [0, 1, 2].map((axis) => (island.min[axis] + island.max[axis]) / 2);
const discs = findIslands(prim(glassNode)).sort((a, b) => a.min[2] - b.min[2]);
if (discs.length !== 2) throw new Error(`expected two lens discs, found ${discs.length}`);
const objective = extractPart(doc, glassNode, prim(glassNode), discs[0].triangles, 'lens_objective').node;
const ocular = glassNode.setName('lens_ocular');
ocular.getMesh().setName('lens_ocular');
setPivot(objective, centre(discs[0]));
setPivot(ocular, centre(discs[1]));
process.stdout.write(`scope axis: ocular ${centre(discs[1]).map((v) => v.toFixed(4))}, objective ${centre(discs[0]).map((v) => v.toFixed(4))}\n`);

// Bolt: body and handle under one node on the bolt's axis, level with the root of the handle.
const boltBody = named('Bolt_LP:Silver').setName('bolt_body');
const boltHandle = named('Bolt_LP:Metal').setName('bolt_handle');
const boltFace = endRingCentre(prim(boltBody), 2, -1, 2e-3);
groupAt(doc, 'bolt', [boltFace[0], boltFace[1], BOLT_AXIS_Z], [boltBody, boltHandle]);
process.stdout.write(`bolt axis at ${boltFace.slice(0, 2).map((v) => v.toFixed(4))}\n`);

// Materials. Only the stock paint has a colour map; the rest are flat values in the source.
const materials = Object.fromEntries(doc.getRoot().listMaterials().map((material) => [material.getName(), material]));
const dropTextures = (material, keep = []) => {
  if (!keep.includes('color')) material.setBaseColorTexture(null);
  if (!keep.includes('orm')) material.setMetallicRoughnessTexture(null).setOcclusionTexture(null);
  if (!keep.includes('normal')) material.setNormalTexture(null);
};
for (const [name, flat] of Object.entries(FLAT)) {
  materials[name].setBaseColorFactor([...flat.color, 1]).setMetallicFactor(flat.metal).setRoughnessFactor(flat.roughness).setDoubleSided(false);
  dropTextures(materials[name], name === 'Metal' ? ['orm', 'normal'] : []);
}
materials.Metal.setName('metal');
materials.Rubber.setName('rubber');
materials.Silver.setName('bolt_steel');
materials.Glass.setName('glass');
materials.Paint.setName('stock').setDoubleSided(false);
// The guard and trigger are black anodised aluminium on the rifle; in the source they share the stock's paint.
const guardMaterial = doc.createMaterial('guard').setBaseColorFactor([0.02, 0.02, 0.022, 1]).setMetallicFactor(1).setRoughnessFactor(0.48);
prim(guard).setMaterial(guardMaterial);
prim(trigger).setMaterial(guardMaterial);

const sizes = {};
sizes.metalNormal = await encodeWebp(doc, materials.Metal.getNormalTexture(), { size: 1024, quality: 94 });
sizes.metalOrm = await encodeWebp(doc, materials.Metal.getMetallicRoughnessTexture(), {
  size: 1024,
  quality: 84,
  edit: liftRoughness({ metal: METAL_ROUGHNESS_FLOOR, other: METAL_ROUGHNESS_FLOOR }),
});
const stockOrm = materials.Paint.getMetallicRoughnessTexture();
const chips = await rawPixels(stockOrm, 1024);
sizes.stockColor = await encodeWebp(doc, materials.Paint.getBaseColorTexture(), {
  size: 1024,
  quality: 88,
  edit: (pixels) => {
    for (let i = 0; i < pixels.length; i += 3) {
      // Chipped paint is bare metal in the source; on a fibreglass stock it is a paler undercoat.
      const chip = STOCK.chipGain + (1 - STOCK.chipGain) * (1 - chips[i + 2] / 255);
      for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(pixels[i + c] * STOCK.gain[c] * chip);
    }
  },
});
sizes.stockNormal = await encodeWebp(doc, materials.Paint.getNormalTexture(), { size: 1024, quality: 94 });
// Occlusion and roughness of the paint carry no fine detail: half size.
sizes.stockOrm = await encodeWebp(doc, stockOrm, {
  size: 512,
  quality: 84,
  edit: (pixels) => {
    for (let i = 0; i < pixels.length; i += 3) {
      pixels[i + 1] = Math.round((STOCK.roughnessFloor + (1 - STOCK.roughnessFloor) * (pixels[i + 1] / 255)) * 255);
      pixels[i + 2] = 0;
    }
  },
});
process.stdout.write(`textures: ${Object.entries(sizes).map(([key, bytes]) => `${key} ${bytes}`).join(', ')} bytes\n`);

// Everything that does not move becomes one node with one primitive per material.
const moving = new Set([trigger, objective, ocular, boltBody, boltHandle]);
const fixed = doc.getRoot().listNodes().filter((node) => node.getMesh() && !moving.has(node));
mergeNodes(doc, 'body', fixed);
for (const node of [trigger, ocular, objective]) scene.addChild(node);

await doc.transform(weld(), dedup(), prune());
await mkdir(dirname(target), { recursive: true });
await io.write(target, doc);
process.stdout.write(`${target}\n${countTriangles(doc)} triangles, ${(await stat(target)).size} bytes\n`);
