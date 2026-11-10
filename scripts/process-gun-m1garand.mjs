// Builds public/assets/local/guns/m1garand.glb from "M1 Garand ( US Rifle, Caliber .30, M1)" by
// Sky_Hunter (CC BY 4.0, https://sketchfab.com/3d-models/m1-garand-us-rifle-caliber-30-m1-1be4bb0f8c05423abdccb50b779de6e6),
// fetched from the Objaverse mirror. Run scripts/fetch-guns-b.mjs first.
//
// Changes to the source: rescaled from 2 units long to 1.10 m, origin moved to the wrist of the
// stock, the one-piece gun mesh split by connected island into body, bolt (bolt, extractor and
// operating rod) and trigger, the en-bloc clip seated in the receiver and split into clip steel
// and rounds, the rear aperture opened up, wood lightened and toned down, roughness raised,
// textures recompressed as WebP.
//
// Output frame: metres, barrel along -Z, up +Y. Nodes: body, bolt, trigger, clip_mount > clip
// (> clip_steel, clip_rounds). Moving parts have their origin on their own axis or pin.
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
  extractPart,
  findIslands,
  groupAt,
  islandsInBox,
  setPivot,
  shiftGeometry,
} from './lib/guns-b-mesh.mjs';
import { encodeWebp, liftRoughness, rawPixels } from './lib/guns-b-texture.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '.cache/guns-b/garand-skyhunter/source.glb');
const target = join(root, 'public/assets/local/guns/m1garand.glb');

/** The source is 2 units long; the rifle is 1.10 m. */
const SCALE = 0.55;
const ORIGIN = [0.0082, 0.052, -0.31];
/** Bolt, extractor and operating rod with its handle (everything that reciprocates). */
const ACTION_BOX = { min: [-0.017, 0.059, -0.395], max: [0.044, 0.082, -0.152], count: 3 };
const TRIGGER_BOX = { min: [-0.003, -0.016, -0.105], max: [0.003, 0.015, -0.083], count: 1 };
const BOLT_AXIS = [0, 0.07, -0.2];
const TRIGGER_PIN = [0, 0.012, -0.098];
/** The clip floats above the receiver in the source; this drops it into the magazine well. */
const CLIP_SEAT = [0, -0.131, 0];
/** Parkerized steel and oiled walnut: neither should mirror the sky. */
const ROUGHNESS_FLOOR = { metal: 0.2, other: 0.4 };
/** The source walnut is close to black, so in shade it only shows the sky's reflection. Lift it. */
const WOOD_GAIN = 1.45;
/** Lifted, the walnut turns a saturated orange; pull it back toward oiled brown. */
const WOOD_SATURATION = 0.72;
/**
 * Rear aperture, output frame. The source hole is 4.1 mm across: with the eye a quarter of a metre
 * back it hides the ears of the front sight. Opened to a thin ring, the sight picture is the blade
 * between its ears inside the ring. The hole's centre does not move.
 */
const APERTURE = { centre: [-0.0001, 0.09765], z: [-0.119, -0.114], within: 0.0025, scale: 1.6 };

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(source);
bakeScene(doc, canonicalMatrix({ scale: SCALE, translate: ORIGIN }));

const meshNodes = doc.getRoot().listNodes().filter((node) => node.getMesh());
const materialOf = (node) => node.getMesh().listPrimitives()[0].getMaterial().getName();
const body = meshNodes.find((node) => materialOf(node) === 'M1_Garand').setName('body');
const clipSource = meshNodes.find((node) => materialOf(node) === 'Bullets');

const pick = (prim, box) => islandsInBox(findIslands(prim), box.min, box.max, box.count).flatMap((island) => island.triangles);
let prim = body.getMesh().listPrimitives()[0];
{
  const position = prim.getAttribute('POSITION');
  const point = [];
  let moved = 0;
  for (let i = 0; i < position.getCount(); i++) {
    position.getElement(i, point);
    const dx = point[0] - APERTURE.centre[0];
    const dy = point[1] - APERTURE.centre[1];
    if (point[2] < APERTURE.z[0] || point[2] > APERTURE.z[1] || Math.hypot(dx, dy) > APERTURE.within) continue;
    position.setElement(i, [APERTURE.centre[0] + dx * APERTURE.scale, APERTURE.centre[1] + dy * APERTURE.scale, point[2]]);
    moved++;
  }
  if (moved < 60) throw new Error(`rear aperture not found: only ${moved} vertices in its hole`);
  process.stdout.write(`rear aperture: ${moved} vertices moved\n`);
}
const action = extractPart(doc, body, prim, pick(prim, ACTION_BOX), 'bolt');
setPivot(action.node, BOLT_AXIS);
const trigger = extractPart(doc, body, action.rest, pick(action.rest, TRIGGER_BOX), 'trigger');
setPivot(trigger.node, TRIGGER_PIN);

// Clip: the largest island is the steel clip, the other eight are the rounds.
shiftGeometry(clipSource, CLIP_SEAT);
prim = clipSource.getMesh().listPrimitives()[0];
const clipIslands = findIslands(prim).sort((a, b) => b.triangles.length - a.triangles.length);
if (clipIslands.length !== 9) throw new Error(`expected 9 clip islands, found ${clipIslands.length}`);
const steel = extractPart(doc, clipSource, prim, clipIslands[0].triangles, 'clip_steel');
clipSource.setName('clip_rounds');
const clipCentre = [0, 1, 2].map((axis) => (clipIslands[0].min[axis] + clipIslands[0].max[axis]) / 2);
const clip = groupAt(doc, 'clip', [0, clipCentre[1], clipCentre[2]], [steel.node, clipSource]);
// The game takes a magazine out by moving it along its parent's -Y. An en-bloc clip leaves through
// the top, so its parent frame is turned upside down (and the clip turned back) to make the same
// motion lift it out of the receiver.
const HALF_TURN_Z = [0, 0, 1, 0];
const mount = doc.createNode('clip_mount').setTranslation(clip.getTranslation()).setRotation(HALF_TURN_Z);
doc.getRoot().listScenes()[0].addChild(mount);
mount.addChild(clip.setTranslation([0, 0, 0]).setRotation(HALF_TURN_Z));

// Textures: the source already packs occlusion, roughness and metal into one map. Re-encode as WebP.
for (const material of doc.getRoot().listMaterials()) {
  const gun = material.getName() === 'M1_Garand';
  const size = gun ? 1024 : 512;
  const orm = material.getMetallicRoughnessTexture();
  if (material.getOcclusionTexture() !== orm) throw new Error(`${material.getName()}: occlusion is not packed with metal-roughness`);
  const ormPixels = await rawPixels(orm, size);
  const sizes = [
    await encodeWebp(doc, material.getBaseColorTexture(), {
      size,
      quality: 92,
      edit: gun
        ? (pixels) => {
            for (let i = 0; i < pixels.length; i += 3) {
              const wood = 1 - Math.min(1, ormPixels[i + 2] / 128); // metal channel
              const gain = 1 + (WOOD_GAIN - 1) * wood;
              const saturation = 1 + (WOOD_SATURATION - 1) * wood;
              const grey = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
              for (let c = 0; c < 3; c++) {
                pixels[i + c] = Math.min(255, Math.round((grey + (pixels[i + c] - grey) * saturation) * gain));
              }
            }
          }
        : undefined,
    }),
    await encodeWebp(doc, material.getNormalTexture(), { size, quality: 92 }),
    await encodeWebp(doc, orm, { size, quality: 90, edit: gun ? liftRoughness(ROUGHNESS_FLOOR) : undefined }),
  ];
  material.setName(gun ? 'garand' : 'clip');
  process.stdout.write(`${material.getName()}: colour ${sizes[0]}, normal ${sizes[1]}, orm ${sizes[2]} bytes\n`);
}

await doc.transform(weld(), dedup(), prune());
await mkdir(dirname(target), { recursive: true });
await io.write(target, doc);
process.stdout.write(`${target}\n${countTriangles(doc)} triangles, ${(await stat(target)).size} bytes\n`);
