import * as THREE from 'three/webgpu';
import type { Kit, Vec3 } from './kit';
import type { PinewoodMaterials } from './materials';

/** Deck height: eighteen 0.18 m risers. */
const RISERS = 18;
const RISE = 0.18;
const TREAD = 0.26;
export const STAND_DECK = RISERS * RISE;
const HALF = 1.4;
const POST = 1.25;
const WALL = 1.05;
const STAIR_HALF = 0.475;

/**
 * Raised hunting stand: a roofed blind on four timber legs, reached by a steep
 * ladder-like stair on its east side. The origin is the centre of the deck's
 * footprint at ground level; the blind looks west over the trail.
 */
export function buildStand(kit: Kit, m: PinewoodMaterials): { readonly blind: THREE.Box3 } {
  const deck = STAND_DECK;
  const roofFront = deck + 2.15;
  const roofBack = deck + 1.9;

  // Legs run from below ground to the roof; cross braces on every side.
  for (const x of [-POST, POST]) {
    for (const z of [-POST, POST]) {
      kit.box(m.planksDark, [0.16, (x < 0 ? roofFront : roofBack) + 0.5, 0.16], [x, ((x < 0 ? roofFront : roofBack) - 0.5) / 2, z], { surface: 'wood' });
    }
  }
  const low = 0.35;
  const high = deck - 0.3;
  for (const s of [-POST, POST]) {
    kit.beam(m.planksDark, [-POST, low, s], [POST, high, s], 0.05, 0.12);
    kit.beam(m.planksDark, [POST, low, s], [-POST, high, s], 0.05, 0.12);
    kit.beam(m.planksDark, [s, low, -POST], [s, high, POST], 0.12, 0.05);
    // The east side keeps one brace clear of the stair.
    if (s < 0) kit.beam(m.planksDark, [s, low, POST], [s, high, -POST], 0.12, 0.05);
  }

  // Deck on joists.
  for (const z of [-POST, 0, POST]) kit.box(m.planksDark, [HALF * 2, 0.14, 0.08], [0, deck - 0.15, z]);
  kit.box(m.planks, [HALF * 2, 0.08, HALF * 2], [0, deck - 0.04, 0], { surface: 'wood', tile: 1.5 });

  // Waist-high board walls with a gap on the east side for the stair, and a top rail.
  const wallY = deck + WALL / 2;
  kit.box(m.planks, [0.04, WALL, HALF * 2], [-HALF + 0.02, wallY, 0], { surface: 'wood', tile: 1.3 });
  for (const z of [-HALF + 0.02, HALF - 0.02]) kit.box(m.planks, [HALF * 2, WALL, 0.04], [0, wallY, z], { surface: 'wood', tile: 1.3 });
  const sideLength = HALF - STAIR_HALF;
  for (const side of [-1, 1]) {
    kit.box(m.planks, [0.04, WALL, sideLength], [HALF - 0.02, wallY, side * (STAIR_HALF + sideLength / 2)], { surface: 'wood', tile: 1.3 });
  }
  for (const z of [-HALF, HALF]) kit.box(m.planksDark, [HALF * 2 + 0.1, 0.06, 0.1], [0, deck + WALL + 0.03, z]);
  kit.box(m.planksDark, [0.1, 0.06, HALF * 2 + 0.1], [-HALF, deck + WALL + 0.03, 0]);
  // A plank shelf under the west opening to rest a rifle on.
  kit.box(m.planksDark, [0.22, 0.04, HALF * 2 - 0.3], [-HALF + 0.13, deck + WALL - 0.02, 0]);

  // Mono-pitch roof, higher toward the view.
  const pitch = Math.atan((roofFront - roofBack) / (POST * 2));
  kit.box(m.roof, [HALF * 2 + 0.7, 0.05, HALF * 2 + 0.6], [0, (roofFront + roofBack) / 2 + 0.06, 0], {
    rot: [0, 0, -pitch],
    surface: 'wood',
    tile: 1.6,
  });
  for (const z of [-POST, POST]) kit.beam(m.planksDark, [-POST, roofFront - 0.02, z], [POST, roofBack - 0.02, z], 0.07, 0.12);
  // Stool.
  kit.box(m.planksDark, [0.34, 0.04, 0.34], [0.5, deck + 0.44, -0.8]);
  for (const [dx, dz] of [[-0.13, -0.13], [0.13, -0.13], [-0.13, 0.13], [0.13, 0.13]] as const) {
    kit.box(m.planksDark, [0.04, 0.42, 0.04], [0.5 + dx, deck + 0.21, -0.8 + dz]);
  }

  stair(kit, m);
  return {
    blind: new THREE.Box3(new THREE.Vector3(-HALF, deck, -HALF), new THREE.Vector3(HALF, roofFront, HALF)),
  };
}

/** Straight flight rising west onto the deck. Walked on a hidden ramp so the small treads never snag. */
function stair(kit: Kit, m: PinewoodMaterials): void {
  const run = RISERS * TREAD;
  const footX = HALF + run;
  for (let i = 1; i < RISERS; i++) {
    kit.box(m.planks, [TREAD + 0.02, 0.04, STAIR_HALF * 2], [HALF + (RISERS - i) * TREAD - TREAD / 2, i * RISE - 0.02, 0], { tile: 1.2 });
  }
  const top: Vec3 = [HALF, STAND_DECK - 0.12, 0];
  const foot: Vec3 = [footX, -0.12, 0];
  for (const z of [-STAIR_HALF - 0.03, STAIR_HALF + 0.03]) {
    kit.beam(m.planksDark, [foot[0], foot[1], z], [top[0], top[1], z], 0.2, 0.05);
    // Handrail on posts.
    kit.beam(m.planksDark, [footX, 0.95, z], [HALF, STAND_DECK + 0.95, z], 0.05, 0.05);
    for (const t of [0.04, 0.5, 0.96]) kit.box(m.planksDark, [0.06, 1.0, 0.06], [footX - run * t, STAND_DECK * t + 0.46, z]);
  }
  // Ramp collider through the tread nosings, plus thin side guards.
  const length = Math.hypot(run + 0.1, STAND_DECK);
  const angle = Math.atan2(STAND_DECK, run + 0.1);
  const midX = HALF + (run + 0.1) / 2;
  const midY = STAND_DECK / 2;
  kit.collider([length, 0.2, STAIR_HALF * 2 + 0.1], [midX - Math.sin(angle) * 0.1, midY - Math.cos(angle) * 0.1, 0], 'wood', [0, 0, -angle]);
  for (const z of [-STAIR_HALF - 0.06, STAIR_HALF + 0.06]) {
    kit.collider([length, 1.1, 0.05], [midX + Math.sin(angle) * 0.5, midY + Math.cos(angle) * 0.5, z], 'wood', [0, 0, -angle]);
  }
}
