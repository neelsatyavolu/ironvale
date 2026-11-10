// Builds public/assets/local/guns/m1911.glb from "M1911 pistol" by e.belous (CC BY 4.0).
// https://sketchfab.com/3d-models/m1911-pistol-80a0b8a6c4314da4a7b3a7cfe6cec1d4
// Usage: node scripts/process-gun-m1911.mjs [--islands]
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

const REAL_LENGTH = 0.216;
const SOURCE_LENGTH = 0.2072;
const SCALE = REAL_LENGTH / SOURCE_LENGTH;
/** Grip centre in the source file, which becomes the origin. */
const SOURCE_ORIGIN = [0, 0.055, -0.152];
/**
 * The file holds two poses side by side: `.001` with the slide forward, hammer
 * down and safety on, `.002` with the slide locked back, hammer cocked and
 * safety off. The game wants slide forward, cocked, safety off, so the hammer
 * and safety come from `.002`, moved back by the spacing between the two.
 */
const POSE_SPACING = 0.762124;
const FROM_SECOND_POSE = ['hammer_low', 'lock_safety_low'];

const SLIDE = [
  'slide_low',
  'sight_front_low',
  'sight rear_low',
  'extractor_low',
  'firing_pin_stop_low',
  'pin_firing_low',
  'bushing_barrel_low',
  'plunger_recoil_sprin_low',
];
const MAGAZINE = ['magazine_low', 'follower_low'];

/**
 * Maker rollmarks (patent dates, company name, logo, model name and serial),
 * per material, as [left, top, width, height] in the 1024 px source images.
 * They are engraved in the colour, normal and roughness maps alike, and are
 * painted out of all of them so the pistol carries no trademark.
 */
const ROLLMARKS = {
  set1: [
    [503, 298, 34, 224],
    [503, 568, 34, 134],
    [583, 264, 29, 97],
    [850, 710, 47, 47],
  ],
  set2: [[353, 296, 26, 96]],
};

/** Ejection port in gun space (metres): its front and rear edges along Z and its lower lip. It is open to the top of the slide. */
const EJECTION_PORT = { front: -0.084, rear: -0.053, bottom: 0.066 };

const file = await fetchSource('m1911-egorbelous.glb', '000-093/80a0b8a6c4314da4a7b3a7cfe6cec1d4.glb');
const doc = await readGlb(file);
for (const [name, regions] of Object.entries(ROLLMARKS)) await removeMarks(doc, name, regions);
const toGun = placement(SCALE, 0, SOURCE_ORIGIN.map((value) => -value * SCALE));
const moveBack = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -POSE_SPACING, 1];

/** "slide_low.001_set1_0" -> ["slide_low", "001"]. */
const parse = (name) => /^(.*)\.(00\d)/.exec(name)?.slice(1, 3) ?? [name, ''];
const islands = findIslands(doc, toGun, (node) => {
  const [base, pose] = parse(node.getName());
  const wanted = FROM_SECOND_POSE.includes(base) ? '002' : '001';
  if (pose !== wanted) return false;
  return pose === '002' ? moveBack : true;
});
const partOf = (island) => {
  const [base] = parse(island.node);
  if (SLIDE.includes(base)) return 'part_slide';
  if (MAGAZINE.includes(base)) return 'part_magazine';
  if (base === 'pad_trigger_low') return 'part_trigger';
  return 'part_frame';
};
if (flag('islands')) printIslands(islands, partOf);

const named = (base) => pointsOf(islands.filter((island) => parse(island.node)[0] === base));
const all = boundsOf(pointsOf(islands));
const front = boundsOf(named('sight_front_low'));
const rear = boundsOf(named('sight rear_low'));
const magazine = boundsOf(named('magazine_low'));
const trigger = boundsOf(named('pad_trigger_low'));
const slide = boundsOf(named('slide_low'));
process.stdout.write(`overall length ${(all.max[2] - all.min[2]).toFixed(4)} m, height ${(all.max[1] - all.min[1]).toFixed(4)} m\n`);

const { scene, summary } = rebuild(
  doc,
  islands,
  {
    part_frame: [0, 0, 0],
    part_slide: [0, 0, 0],
    part_magazine: [0, magazine.max[1], magazine.centre[2]],
    part_trigger: trigger.centre,
  },
  partOf,
);

// The crown is the front face of the barrel itself; the bushing around it hangs lower, over the recoil spring plug.
const crown = crownCentre(named('barrel_low'));
addAnchor(doc, scene, 'anchor_muzzle', [0, crown[1], all.min[2]]);
// The blade's top edge and the top of the rear sight are what the eye lines up.
addAnchor(doc, scene, 'anchor_sight_front', [front.centre[0], front.max[1], front.max[2]]);
addAnchor(doc, scene, 'anchor_sight_rear', [rear.centre[0], rear.max[1], rear.max[2]]);
// The ejection port is cut into the right of the slide over the chamber. Its edges were read off the
// slide mesh with scripts/dev/guns-a-profile.mjs; tests/weapons/models/m1911.test.ts checks the opening.
addAnchor(doc, scene, 'anchor_ejection', [slide.max[0], (EJECTION_PORT.bottom + slide.max[1]) / 2, (EJECTION_PORT.front + EJECTION_PORT.rear) / 2]);

await writeGun(doc, 'm1911', summary);
