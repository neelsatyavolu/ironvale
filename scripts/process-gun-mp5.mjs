// Builds public/assets/local/guns/mp5.glb from "MP5 submachinegun" by Michael Karel (CC BY 4.0).
// https://sketchfab.com/3d-models/mp5-submachinegun-2a9ce66fe96643fc8f20927401e5054c
// Usage: node scripts/process-gun-mp5.mjs [--islands] [--sights]
import sharp from 'sharp';
import {
  addAnchor,
  boundsOf,
  crownCentre,
  fetchSource,
  findIslands,
  flag,
  longAxisPitch,
  moveIsland,
  placement,
  pointsOf,
  printIslands,
  readGlb,
  rebuild,
  writeGun,
} from './process-gun-a-common.mjs';

/** Source units to metres, chosen so the sight radius comes out at the real 340 mm. */
const SCALE = 0.009;
/** The source file poses the gun with its muzzle raised by this much. */
const SOURCE_TILT_DEG = 11.43;
/** Centre of the pistol grip once levelled and scaled, before it is moved to the origin (metres). */
const GRIP = [0, 0.055, 0.086];

/**
 * The source poses the sliding stock 90 mm out, which makes the gun 0.63 m
 * long. Pulling it out this much further gives the 0.68 m of the real gun and
 * puts the butt plate behind the shooter's eye when aiming.
 */
const STOCK_EXTENSION = 0.05;
/** Stock parts start behind this z (the two long rails are picked by their length instead). */
const STOCK_FROM_Z = 0.15;
const RAIL_TRIANGLES = 22;
const RAIL_MIN_LENGTH = 0.2;

/**
 * The colour texture fills the space between UV islands with light grey,
 * which bleeds onto the dark gun along every seam once mipmapped. Repaint
 * that gutter (neutral grey in this range) with the gun's own dark tone.
 */
const GUTTER_RANGE = [186, 191];
const GUTTER_FILL = [29, 28, 27];

async function darkenGutter(material) {
  const texture = material.getBaseColorTexture();
  const { data, info } = await sharp(Buffer.from(texture.getImage())).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    const value = data[i];
    if (value >= GUTTER_RANGE[0] && value <= GUTTER_RANGE[1] && data[i + 1] === value && data[i + 2] === value) {
      data[i] = GUTTER_FILL[0];
      data[i + 1] = GUTTER_FILL[1];
      data[i + 2] = GUTTER_FILL[2];
    }
  }
  texture.setImage(await sharp(data, { raw: info }).png().toBuffer());
}

const file = await fetchSource('mp5-michaelkarel.glb', '000-110/2a9ce66fe96643fc8f20927401e5054c.glb');
const doc = await readGlb(file);
const gunMaterial = doc.getRoot().listMaterials().find((material) => material.getName() === 'MP-5_0');
if (!gunMaterial) throw new Error('material "MP-5_0" is missing from the source file');
await darkenGutter(gunMaterial);
// The source points its muzzle down +Z; turn it round and level it.
const toGun = placement(SCALE, 180, GRIP.map((value) => -value), -SOURCE_TILT_DEG);
// Only the gun itself: the file also has a pile of loose parts and a ground plane.
const isRail = (island) => island.count === RAIL_TRIANGLES && island.max[2] - island.min[2] > RAIL_MIN_LENGTH;
const isStock = (island) => isRail(island) || island.min[2] > STOCK_FROM_Z;
const islands = findIslands(doc, toGun, (node) => node.getName() === 'Object_9').map((island) =>
  isStock(island) ? moveIsland(island, [0, 0, STOCK_EXTENSION]) : island,
);
const stockParts = islands.filter(isStock).length;
if (stockParts !== 4) throw new Error(`Expected the stock to be 4 islands (two rails, butt and pad), found ${stockParts}`);

/**
 * The gun is one mesh, so parts are told apart by where each connected island
 * sits. Boxes are [minX, minY, minZ, maxX, maxY, maxZ] in millimetres of gun
 * space; an island belongs to a part when its centre is inside the box and
 * its triangle count matches.
 */
const mm = (value) => value * 1000;
const offset = (box) => box.map((value, i) => value * SCALE * 100 - mm(GRIP[i % 3]));
const PICK = [
  // name, triangle count, box in source-centimetre millimetres (levelled), moved to gun space below
  ['part_magazine', 220, [-12, -40, -210, 12, 180, -80]],
  ['part_magazine', 78, [-6, 155, -120, 6, 175, -85]], // top round in the magazine
  ['part_bolt', 78, [0, 215, -130, 14, 235, -90]], // round seen through the ejection port
  ['part_bolt', 19, [5, 218, -102, 22, 243, -64]], // bolt face
  ['part_charging', 56, [-30, 235, -243, -14, 246, -227]],
  ['part_charging', 24, [-17, 235, -239, -9, 242, -230]],
  ['part_trigger', 58, [-4, 100, -20, 4, 148, 12]],
].map(([part, count, box]) => ({ part, count, box: offset(box) }));

const partOf = (island) => {
  const centre = island.centre.map(mm);
  for (const { part, count, box } of PICK) {
    if (island.count !== count) continue;
    if (centre.every((value, axis) => value >= box[axis] && value <= box[axis + 3])) return part;
  }
  return 'part_body';
};
if (flag('islands')) printIslands(islands, partOf);

const of = (part) => {
  const chosen = islands.filter((island) => partOf(island) === part);
  if (chosen.length === 0) throw new Error(`No island was assigned to ${part}`);
  return boundsOf(pointsOf(chosen));
};
const counts = new Map();
for (const island of islands) counts.set(partOf(island), (counts.get(partOf(island)) ?? 0) + 1);
for (const [part, expected] of [['part_magazine', 2], ['part_bolt', 2], ['part_charging', 2], ['part_trigger', 1]]) {
  if (counts.get(part) !== expected) throw new Error(`${part}: expected ${expected} islands, found ${counts.get(part) ?? 0}`);
}

const rails = islands.filter(isRail);
const tilt = longAxisPitch(pointsOf(rails));
if (rails.length !== 2 || Math.abs(tilt) > 0.1) throw new Error(`Stock rails are not level (${tilt.toFixed(2)} deg): check SOURCE_TILT_DEG`);

const all = boundsOf(pointsOf(islands));
const magazine = of('part_magazine');
const trigger = of('part_trigger');
const bolt = of('part_bolt');
const charging = of('part_charging');
const flashHider = islands.filter((island) => island.count === 130);
process.stdout.write(`overall length ${(all.max[2] - all.min[2]).toFixed(4)} m, height ${(all.max[1] - all.min[1]).toFixed(4)} m\n`);

if (flag('sights')) {
  const dump = (label, count) => {
    const points = pointsOf(islands.filter((island) => island.count === count));
    const unique = [...new Set(points.map((p) => p.map((v) => (v * 1000).toFixed(1)).join(' ')))].map((s) => s.split(' ').map(Number));
    unique.sort((a, b) => b[1] - a[1] || a[2] - b[2] || a[0] - b[0]);
    process.stdout.write(`${label} (${unique.length} vertices, mm x y z)\n${unique.map((p) => p.join('\t')).join('\n')}\n`);
  };
  dump('rear drum', 126);
  dump('front post?', 62);
  dump('front tower', 180);
}

// Sights: a thin post inside the front hood and a V notch cut into the rear of the slanted drum.
// The eye line runs level through the tip of the post, which must fall inside the notch.
const post = boundsOf(pointsOf(islands.filter((island) => island.count === 62)));
const drumPoints = pointsOf(islands.filter((island) => island.count === 126));
const drum = boundsOf(drumPoints);
const notchFloor = Math.max(...drumPoints.filter((p) => Math.abs(p[0]) < 0.001 && p[2] > drum.max[2] - 0.001).map((p) => p[1]));
if (!(post.max[1] > notchFloor && post.max[1] < drum.max[1])) {
  throw new Error(`Front post tip (${post.max[1].toFixed(4)}) is outside the rear notch (${notchFloor.toFixed(4)}..${drum.max[1].toFixed(4)})`);
}

const { scene, summary } = rebuild(
  doc,
  islands,
  {
    part_body: [0, 0, 0],
    part_bolt: [0, 0, 0],
    part_charging: [0, 0, 0],
    part_magazine: [0, magazine.max[1], magazine.centre[2]],
    // The trigger hangs from a pin at its top.
    part_trigger: [0, trigger.max[1], trigger.centre[2]],
  },
  partOf,
);

addAnchor(doc, scene, 'anchor_muzzle', [0, crownCentre(pointsOf(flashHider))[1], all.min[2]]);
addAnchor(doc, scene, 'anchor_ejection', [bolt.max[0] + 0.004, bolt.centre[1], bolt.centre[2]]);
process.stdout.write(`charging handle z ${charging.centre[2].toFixed(4)}, bolt z ${bolt.min[2].toFixed(4)}..${bolt.max[2].toFixed(4)}\n`);
addAnchor(doc, scene, 'anchor_sight_front', [0, post.max[1], post.centre[2]]);
addAnchor(doc, scene, 'anchor_sight_rear', [0, post.max[1], drum.max[2]]);

await writeGun(doc, 'mp5', summary);
