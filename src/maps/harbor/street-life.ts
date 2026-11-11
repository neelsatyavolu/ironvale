import * as THREE from 'three/webgpu';
import { seededRandom } from '../../core/random';
import { addWallLantern } from './dressing';
import type { Kit } from './facade';
import { QUAY_EDGE, QUAY_NORTH, STREET_NORTH, STREET_SOUTH, TERRACE_EDGE, TERRACE_NORTH, TERRACE_Y } from './layout';

/** Its own stream: nothing here may shift the placements the layout was play-tested with. */
const SEED = 0x57ee7;

/** Foot of a wall where weeds take hold: [x0, x1, z, side of the wall the street is on, ground height]. */
const WALL_FEET: readonly (readonly [number, number, number, 1 | -1, number])[] = [
  // Quay fronts and the street behind them, broken at the lanes and the passage.
  ...[QUAY_NORTH, STREET_SOUTH].flatMap((z) =>
    (
      [
        [-52, -38.2],
        [-35.3, 7.3],
        [11.2, 32.8],
        [36.7, 52],
      ] as const
    ).map(([x0, x1]) => [x0, x1, z, z === QUAY_NORTH ? 1 : -1, 0] as const),
  ),
  // North side of the street, broken at the alley, the square and the ramp.
  [-52, -32.2, STREET_NORTH, 1, 0],
  [-29.3, -12.2, STREET_NORTH, 1, 0],
  [12.2, 29.8, STREET_NORTH, 1, 0],
  [34.2, 52, STREET_NORTH, 1, 0],
  [-52, 52, TERRACE_NORTH, 1, TERRACE_Y],
  [-52, -32.2, TERRACE_EDGE, -1, TERRACE_Y],
  [-29.3, -12.2, TERRACE_EDGE, -1, TERRACE_Y],
  [12.2, 29.8, TERRACE_EDGE, -1, TERRACE_Y],
  [-44.5, -28, QUAY_EDGE - 0.57, -1, 0],
  [8, 26, QUAY_EDGE - 0.57, -1, 0],
];

/** Extra bracket lanterns in the shaded streets: [x, height above the street, wall z, wall normal z, ground height]. */
const LANTERNS: readonly (readonly [number, number, number, 1 | -1, number])[] = [
  [41.6, 3.02, STREET_NORTH, 1, 0],
  [25.8, 3.02, STREET_SOUTH, -1, 0],
  [21.4, 3.02, STREET_NORTH, 1, 0],
  [-14.6, 3.02, STREET_NORTH, 1, 0],
  [-23.4, 3.02, STREET_SOUTH, -1, 0],
  [-40.6, 3.02, STREET_NORTH, 1, 0],
  [-46.4, 3.02, STREET_SOUTH, -1, 0],
  [-41, 2.95, TERRACE_NORTH, 1, TERRACE_Y],
  [-15.5, 2.95, TERRACE_NORTH, 1, TERRACE_Y],
  [15.5, 2.95, TERRACE_NORTH, 1, TERRACE_Y],
  [41, 2.95, TERRACE_NORTH, 1, TERRACE_Y],
];

/** Tuft of weeds: two or three crossed leaf cards rooted in the joint between wall and paving. */
function tuft(kit: Kit, random: () => number, x: number, y: number, z: number, size: number): void {
  const cards = 2 + (random() < 0.4 ? 1 : 0);
  const start = random() * Math.PI;
  for (let i = 0; i < cards; i++) {
    const card = new THREE.PlaneGeometry(size * (0.8 + random() * 0.5), size);
    const uv = card.getAttribute('uv');
    // Left half of the spray sheet is plain leaves.
    for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) / 2);
    card.rotateX((random() - 0.5) * 0.5);
    card.rotateY(start + (i * Math.PI) / cards);
    card.translate(x, y + size * 0.4, z);
    kit.batch.add(kit.mats.spray, card);
  }
}

/**
 * The small things that make a street look lived in and a little neglected:
 * weeds along the foot of every wall and more lanterns on brackets where the
 * houses keep the sun out.
 */
export function addStreetLife(kit: Kit): void {
  const random = seededRandom(SEED);
  const density = Math.max(0.4, kit.density);

  for (const [x0, x1, z, side, ground] of WALL_FEET) {
    let x = x0 + random() * 1.5;
    while (x < x1) {
      // Weeds come in runs with bare stretches between.
      const run = random() < 0.35 ? 1 + Math.floor(random() * 4) : 1;
      for (let i = 0; i < run && x < x1; i++) {
        const size = 0.12 + random() * random() * 0.3;
        tuft(kit, random, x, ground - 0.02, z + side * (0.07 + random() * 0.1), size);
        x += 0.18 + random() * 0.3;
      }
      x += (0.6 + random() * 2.6) / density;
    }
  }

  for (const [x, height, z, nz, ground] of LANTERNS) addWallLantern(kit, x, ground + height, z, 0, nz);
}
