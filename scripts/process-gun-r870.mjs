// Builds public/assets/local/guns/r870.glb from "Remington 870 Police Magnum 12 Gauge Shotgun" by 8sianDude (CC BY 4.0).
// https://sketchfab.com/3d-models/remington-870-police-magnum-12-gauge-shotgun-eea11de7e9d24b6683962b8388c319eb
// Usage: node scripts/process-gun-r870.mjs [--islands] [--top]
import {
  addAnchor,
  boundsOf,
  crownCentre,
  fetchSource,
  findIslands,
  flag,
  placement,
  pointsOf,
  printIslands,
  readGlb,
  rebuild,
  removeMarks,
  writeGun,
} from './process-gun-a-common.mjs';

/** Source units to metres: the file is in decimetres, which gives the real 0.97 m of the 18 inch gun. */
const SCALE = 0.1;
/** Centre of the pistol grip, scaled, before it is moved to the origin (metres). */
const GRIP = [0, -0.03, 0.19];
/** How far above the receiver the eye line passes at the back, so the bead sits on top of it. */
const EYE_ABOVE_RECEIVER = 0.003;
/** The receiver's top is flat up to this far from its rear end, then rounds off. */
const RECEIVER_ROUND_OFF = 0.045;

/** Triangle count of the barrel's island, which tells it apart from the magazine tube under it. */
const BARREL_TRIANGLES = 1352;

/** Maker's name and model rollmarks on the barrel and receiver, [left, top, width, height] in texture pixels. */
const ROLLMARKS = [
  [561, 346, 25, 100],
  [138, 526, 17, 152],
];

const file = await fetchSource('r870-haoliu95.glb', '000-091/eea11de7e9d24b6683962b8388c319eb.glb');
const doc = await readGlb(file);
await removeMarks(doc, 'R870', ROLLMARKS);
const toGun = placement(SCALE, 0, GRIP.map((value) => -value));
// Object_4 is the shotgun; Object_2 and Object_3 are two loose shells shown beside it.
const islands = findIslands(doc, toGun, (node) => node.getName() === 'Object_4');

/**
 * The gun is one mesh, so parts are told apart by connected island: triangle
 * count plus a box, [minX, minY, minZ, maxX, maxY, maxZ] in millimetres
 * measured before the grip is moved to the origin, that must hold its centre.
 */
const mm = (value) => value * 1000;
const PICK = [
  ['part_pump', 1868, [-5, 20, -240, 5, 45, -210], 'fore-end'],
  ['part_pump', 404, [-5, 25, -320, 5, 45, -300], 'fore-end collar'],
  ['part_pump', 240, [-5, 25, -340, 5, 40, -322], 'fore-end nut'],
  ['part_pump', 370, [-5, 20, -70, 5, 45, -45], 'action bars'],
  ['part_pump', 430, [-5, 50, 0, 8, 70, 25], 'bolt'],
  ['part_pump', 52, [8, 55, -30, 16, 65, -15], 'extractor'],
  ['part_pump', 28, [10, 57, -22, 15, 63, -15], 'extractor pin'],
  ['part_trigger', 248, [-3, 0, 120, 3, 20, 135], 'trigger'],
].map(([part, count, box, label]) => ({ part, count, label, box: box.map((value, i) => value - mm(GRIP[i % 3])) }));

const pick = (island) => {
  const centre = island.centre.map(mm);
  return PICK.find(({ count, box }) => island.count === count && centre.every((value, axis) => value >= box[axis] && value <= box[axis + 3]));
};
const partOf = (island) => pick(island)?.part ?? 'part_body';
if (flag('islands')) printIslands(islands, (island) => `${partOf(island)} ${pick(island)?.label ?? ''}`);
for (const entry of PICK) {
  const found = islands.filter((island) => pick(island) === entry).length;
  if (found !== 1) throw new Error(`${entry.label}: expected one island, found ${found}`);
}

const labelled = (label) => boundsOf(pointsOf(islands.filter((island) => pick(island)?.label === label)));
const counted = (count) => boundsOf(pointsOf(islands.filter((island) => island.count === count)));
const all = boundsOf(pointsOf(islands));
const receiverPoints = pointsOf(islands.filter((island) => island.count === 2428));
const receiver = boundsOf(receiverPoints);
const bead = counted(620);
const beadHousing = counted(212);
const trigger = labelled('trigger');
const bolt = labelled('bolt');
const foreEnd = labelled('fore-end');
process.stdout.write(`overall length ${(all.max[2] - all.min[2]).toFixed(4)} m, height ${(all.max[1] - all.min[1]).toFixed(4)} m\n`);
process.stdout.write(`fore-end z ${foreEnd.min[2].toFixed(4)}..${foreEnd.max[2].toFixed(4)}, receiver front ${receiver.min[2].toFixed(4)}, bolt z ${bolt.min[2].toFixed(4)}..${bolt.max[2].toFixed(4)}\n`);
if (flag('top')) {
  // Height of the receiver's top along its centre line, in 20 mm steps.
  const profile = new Map();
  for (const p of receiverPoints) {
    if (Math.abs(p[0]) > 0.004) continue;
    const bin = Math.round(mm(p[2]) / 20) * 20;
    profile.set(bin, Math.max(profile.get(bin) ?? -Infinity, mm(p[1])));
  }
  for (const [z, y] of [...profile].sort((a, b) => a[0] - b[0])) process.stdout.write(`receiver top z ${z} y ${y.toFixed(1)}\n`);
}

const { scene, summary } = rebuild(
  doc,
  islands,
  {
    part_body: [0, 0, 0],
    part_pump: [0, 0, 0],
    // The trigger hangs from a pin at its top.
    part_trigger: [0, trigger.max[1], trigger.centre[2]],
  },
  partOf,
);

// The barrel is wider at the chamber than at the muzzle, so the crown is measured from its front face.
const crown = crownCentre(pointsOf(islands.filter((island) => island.count === BARREL_TRIANGLES)));
addAnchor(doc, scene, 'anchor_muzzle', [0, crown[1], all.min[2]]);
// The port is on the right of the receiver, over the front half of the bolt.
addAnchor(doc, scene, 'anchor_ejection', [receiver.max[0], bolt.centre[1], bolt.centre[2]]);
// A bead and no rear sight: the eye looks along the top of the receiver at the bead. The bead sits in a
// small housing; the anchor is on the housing's rear face, at bead height, which is the dot the shooter sees.
addAnchor(doc, scene, 'anchor_sight_front', [0, bead.centre[1], beadHousing.max[2]]);
addAnchor(doc, scene, 'anchor_sight_rear', [0, receiver.max[1] + EYE_ABOVE_RECEIVER, receiver.max[2] - RECEIVER_ROUND_OFF]);

await writeGun(doc, 'r870', summary);
